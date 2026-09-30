import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ManualScheduler,
  VISUAL_STYLE_IDS,
  sunElevationDeg,
  type CameraModeState,
  type RenderFeature,
} from '@worldview/render-core';
import { MapLibreWorldRenderer } from './renderer.js';
import { createFakeMapLibre, fakeImageCanvasFactory } from './testing/fake-maplibre.js';
import { NIGHT_LAYER_IDS, NIGHT_SOURCE, nightCollection } from './night.js';
import { IRON_TABLE, visualStyle2D, type StyleDocument, type StyleElement } from './visual-styles.js';
import { RASTER_OVERLAY_PREFIX } from './raster-overlays.js';
import { REFERENCE_LAYER_IDS } from './reference.js';

/** A DOM just big enough for the style applier: elements that record what is done to them. */
class FakeElement implements StyleElement {
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly css = new Map<string, string>();
  parent: FakeElement | undefined;
  readonly style = {
    setProperty: (k: string, v: string) => void this.css.set(k, v),
    removeProperty: (k: string) => this.css.delete(k),
  };
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  appendChild(child: StyleElement): unknown {
    const c = child as FakeElement;
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  find(tag: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.find(tag)]);
  }
}
const fakeDocument: StyleDocument = {
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createElement: (tag) => new FakeElement(tag),
};

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (h: unknown) => void pending.delete(h as number),
    /** Run (once) every pending timer of this interval. */
    fire(ms: number) {
      for (const [h, t] of [...pending])
        if (t.ms === ms) {
          pending.delete(h);
          t.fn();
        }
    },
  };
}

async function mounted(opts: { wall?: { now: number } } = {}) {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  const timers = fakeTimers();
  const wall = opts.wall ?? { now: Date.parse('2026-06-21T08:24:00Z') };
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    wallNow: () => wall.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const modes: CameraModeState[] = [];
  renderer.on('cameraMode', (m) => modes.push(m));
  const pane = new FakeElement('div');
  (pane as unknown as { ownerDocument: StyleDocument }).ownerDocument = fakeDocument;
  await renderer.mount(pane as unknown as HTMLElement);
  const map = maplibre.maps[0]!;
  return { renderer, map, pane, scheduler, timers, wall, modes };
}

const pt = (id: string, lon: number, lat: number, extra: Partial<RenderFeature> = {}): RenderFeature => ({
  id,
  objectId: id.replace(/^obj:/, ''),
  geometry: { kind: 'point', position: { latitude: lat, longitude: lon } },
  style: { styleClass: 'aircraft' },
  interactive: true,
  priority: 50,
  layer: 'aircraft',
  ...extra,
});

// ── visual styles ────────────────────────────────────────────────────────────

test('2D visual styles: a filter or an overlay for every style but standard, never anything animated', () => {
  for (const id of VISUAL_STYLE_IDS) {
    const spec = visualStyle2D(id);
    if (id === 'standard') {
      assert.deepEqual(spec, { filter: null, overlay: null });
      continue;
    }
    assert.ok(spec.filter || spec.overlay, id);
    const text = JSON.stringify(spec);
    assert.doesNotMatch(text, /animation|transition|<animate/, `${id} is static`);
    if (spec.overlay) assert.equal(spec.overlay['pointer-events'], undefined, 'the applier sets it, not the spec');
  }
  const thermal = visualStyle2D('thermal').filter!;
  const table = thermal.find((p) => p.tag === 'feComponentTransfer')!.children!;
  assert.equal(table[0]!.attrs.tableValues, IRON_TABLE.r.join(' '), 'a gradient map onto the iron palette');
  assert.equal(IRON_TABLE.r.length, 7);
});

test('2D visual styles: filter on the canvas and overlay on the pane, swapped whole, standard leaves nothing', async () => {
  const { renderer, map, pane } = await mounted();
  renderer.setVisualStyle('night-vision');
  const filterUrl = map.canvasStyle.get('filter');
  assert.match(filterUrl ?? '', /^url\(#wv-visual-style-\d+\)$/);
  const filters = pane.find('filter');
  assert.equal(filters.length, 1);
  assert.equal(`url(#${filters[0]!.attrs.get('id')})`, filterUrl, 'the canvas points at the filter in the pane');
  const overlays = pane.children.filter((c) => c.tag === 'div');
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0]!.css.get('pointer-events'), 'none', 'clicks go through to the map');

  renderer.setVisualStyle('thermal');
  assert.equal(pane.find('filter').length, 1, 'the old filter is gone');
  assert.equal(pane.children.filter((c) => c.tag === 'div').length, 0, 'thermal has no overlay');

  renderer.setVisualStyle('standard');
  assert.equal(pane.children.length, 0);
  assert.equal(map.canvasStyle.has('filter'), false);
});

test('2D visual styles: chosen before mount, shown at mount; without a DOM the id is kept', async () => {
  const maplibre = createFakeMapLibre();
  const renderer = new MapLibreWorldRenderer({ maplibre, createCanvas: fakeImageCanvasFactory() });
  renderer.setVisualStyle('noir');
  await renderer.mount({} as HTMLElement);
  assert.equal(renderer.visualStyleShown, 'noir');
  renderer.dispose();
});

// ── day and night ────────────────────────────────────────────────────────────

test('2D day/night: the night bands under the reference and markers, over the overlays, refreshed each minute', async () => {
  const { renderer, map, timers, wall, scheduler } = await mounted();
  renderer.update({ upsert: [pt('obj:a', 10, 20)], remove: [] });
  scheduler.flush();
  // Invented fixtures: one border line, one XYZ overlay at a host that does not exist.
  renderer.setReference(
    {
      lines: [
        { kind: 'country', dashed: false, minZoom: 0, coords: new Float64Array([0, 0, 1, 1]), bbox: [0, 0, 1, 1] },
      ],
      labels: [],
      attribution: 'invented',
    },
    { borders: true, labels: false },
  );
  renderer.setOverlays([
    {
      id: 'radar',
      providerId: 'test',
      name: 'Radar',
      kind: 'xyz',
      url: 'https://example.invalid/{z}/{x}/{y}.png',
      attribution: 'invented test overlay',
    },
  ]);
  renderer.setDayNight(true);
  const ids = map.layers.map((l) => l.id);
  const night = NIGHT_LAYER_IDS.map((id) => ids.indexOf(id));
  assert.ok(
    night.every((i) => i >= 0),
    'every band drawn',
  );
  const firstRef = Math.min(...REFERENCE_LAYER_IDS.map((id) => ids.indexOf(id)).filter((i) => i >= 0));
  assert.ok(Math.max(...night) < firstRef, 'below the borders');
  const overlay = ids.findIndex((id) => id.startsWith(RASTER_OVERLAY_PREFIX));
  assert.ok(overlay >= 0 && overlay < Math.min(...night), `above raster overlays: ${ids.join(', ')}`);
  const marker = ids.findIndex((id) => id.includes('aircraft'));
  assert.ok(marker > Math.max(...night), 'below every marker');

  const before = map.getSource(NIGHT_SOURCE)!.setDataCalls;
  wall.now += 60_000;
  timers.fire(60_000);
  assert.equal(map.getSource(NIGHT_SOURCE)!.setDataCalls, before + 1, 'redrawn after a minute');
  assert.ok(
    [...timers.pending.values()].some((t) => t.ms === 60_000),
    'and again next minute',
  );

  renderer.setDayNight(false);
  assert.equal(map.getSource(NIGHT_SOURCE), undefined);
  assert.ok(
    NIGHT_LAYER_IDS.every((id) => !map.getLayer(id)),
    'off: nothing left',
  );
  assert.ok(![...timers.pending.values()].some((t) => t.ms === 60_000), 'no timer left');
});

test('2D day/night: survives a basemap change', async () => {
  const { renderer, map } = await mounted();
  renderer.setDayNight(true);
  await renderer.setBasemap({ kind: 'none', id: 'none' });
  assert.ok(map.getSource(NIGHT_SOURCE));
  assert.ok(NIGHT_LAYER_IDS.every((id) => map.getLayer(id)));
});

test('night collection: each band a polygon whose edge has the Sun at the band elevation', () => {
  const at = Date.parse('2026-12-21T20:50:00Z');
  const fc = nightCollection(at);
  assert.equal(fc.features.length, 4);
  const edge = fc.features[1]!.geometry.coordinates[0]!.filter(([, lat]) => Math.abs(lat) < 90);
  for (const [lon, lat] of edge) assert.ok(Math.abs(sunElevationDeg(at, { latitude: lat, longitude: lon }) + 6) < 0.01);
});

// ── orbit ────────────────────────────────────────────────────────────────────

test('2D orbit: quarter turns chained a frame apart, stopped by the operator’s hand', async () => {
  const { renderer, map, scheduler, modes } = await mounted();
  renderer.setOrbit(true);
  assert.equal(map.eases.length, 1);
  assert.deepEqual(map.eases[0], { bearing: 90, duration: 22_500, essential: true });
  assert.equal(map.eases.length, 1, 'the next quarter is not started from inside moveend');
  scheduler.flush();
  assert.equal(map.eases.length, 2);
  assert.equal(map.eases[1]!.bearing, 180);
  map.fire('mousedown', {});
  assert.deepEqual(modes.at(-1), { orbit: false, follow: null });
  scheduler.flush();
  scheduler.flush();
  assert.equal(map.eases.length, 2, 'no more turning');
});

// ── follow ───────────────────────────────────────────────────────────────────

test('2D follow: flies to the object, re-centres it on each motion step, and ends on a pan or when it goes', async () => {
  const wall = { now: Date.parse('2026-09-23T08:00:00Z') };
  const { renderer, map, timers, modes } = await mounted({ wall });
  map.zoom = 9;
  renderer.update({
    upsert: [
      pt('obj:a', 10, 20, {
        motion: { to: { latitude: 20, longitude: 11 }, fromMs: wall.now, toMs: wall.now + 60_000 },
      }),
    ],
    remove: [],
  });
  timers.fire(0); // the first motion step: the aircraft is chosen to move
  renderer.follow('obj:a');
  assert.deepEqual(map.flights.at(-1)!.center, [10, 20]);
  wall.now += 30_000;
  for (const [h, t] of [...timers.pending]) {
    timers.pending.delete(h);
    t.fn();
  }
  assert.ok(Math.abs(map.center.lng - 10.5) < 1e-9, `moved with the marker (${map.center.lng})`);
  assert.deepEqual(renderer.cameraMode, { orbit: false, follow: 'obj:a' });

  map.fire('dragstart', {});
  assert.deepEqual(modes.at(-1), { orbit: false, follow: null }, 'a pan lets go');

  renderer.follow('obj:a');
  renderer.update({ upsert: [], remove: ['obj:a'] });
  assert.deepEqual(modes.at(-1), { orbit: false, follow: null }, 'gone: follow ends');
});

test('2D flyTo: a pitch tilts the map; a bounds flight does not', async () => {
  const { renderer, map } = await mounted();
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, zoom: 10 }, { pitchDegrees: -35 });
  assert.equal(map.flights.at(-1)!.pitch, 55);
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, zoom: 10 });
  assert.equal(map.flights.at(-1)!.pitch, undefined);
  // A heading turns the map to face it (a home view set facing west); none keeps the bearing.
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, zoom: 10 }, { headingDegrees: -90 });
  assert.equal(map.flights.at(-1)!.bearing, 270);
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, zoom: 10 });
  assert.equal(map.flights.at(-1)!.bearing, undefined);
});
