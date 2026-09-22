import type { GeoBounds, GeoPosition } from '@worldview/world-model';
import type {
  AttributionEntry,
  FeatureUpdate,
  LensDefinition,
  PickResult,
  RenderFeature,
  RenderMode,
  RendererEvents,
  ViewState,
} from '@worldview/render-core';
import { altitudeToZoom, zoomToAltitudeM } from '@worldview/render-core';
import type { RendererHostLike } from '../renderer-host-like.js';

/**
 * CanvasRendererHost — a small, dependency-free 2D map host used by the browser demo and
 * screenshot runs when the Cesium/MapLibre adapters are not installed. Web-Mercator
 * projection, graticule, RenderFeature drawing (points, icons, clusters, density cells,
 * lines, polygons), drag-pan, wheel-zoom, picking and hover. It is a real renderer for
 * the demo — not a stand-in for the production adapters, which replace it through the
 * same RendererHostLike interface. 3D is not available here: setMode('3D') keeps 2D and
 * activeMode() reports '2D' so the UI never claims a globe it cannot show.
 */
const TILE = 256;
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 16;

const STYLE_COLORS: Record<string, string> = {
  aircraft: '#3ec5d5',
  vessel: '#62d9e6',
  satellite: '#c9a0ff',
  earthquake: '#e8903a',
  'earthquake.shallow': '#e0605c',
  'earthquake.intermediate': '#e8903a',
  'earthquake.deep': '#d6b64a',
  fire: '#e0605c',
  'weather-alert': '#d6b64a',
  'weather-station': '#8b97ff',
  camera: '#a3b3c4',
  transit: '#35c98a',
  infrastructure: '#7f8d9e',
  launch: '#c9a0ff',
  sensor: '#35c98a',
  trail: '#62d9e6',
};

function colorFor(styleClass: string, override?: string): string {
  if (override) return override;
  const base = styleClass.replace(/\.(cluster|density)$/, '');
  return STYLE_COLORS[base] ?? STYLE_COLORS[base.split('.')[0] ?? ''] ?? '#a3b3c4';
}

type Listeners = { [K in keyof RendererEvents]: Set<(payload: RendererEvents[K]) => void> };

export class CanvasRendererHost implements RendererHostLike {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private center: GeoPosition = { latitude: 20, longitude: -157 };
  private zoom = 1.6;
  private width = 800;
  private height = 600;
  private readonly features = new Map<string, RenderFeature>();
  private selectedId: string | null = null;
  private hoverId: string | null = null;
  private lens: LensDefinition | null = null;
  private attribution: AttributionEntry[] = [];
  private frame: number | null = null;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private drag: { x: number; y: number; startLon: number; startLat: number; moved: boolean } | null = null;
  private animation: number | null = null;
  private readonly listeners: Listeners = {
    viewChanged: new Set(),
    pick: new Set(),
    hover: new Set(),
    ready: new Set(),
    error: new Set(),
    frame: new Set(),
  };
  private readonly abort = new AbortController();

  mount(container: HTMLElement): void {
    this.container = container;
    const canvas = document.createElement('canvas');
    canvas.className = 'wv-canvas-host';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'World map (demo canvas renderer)');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const { signal } = this.abort;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal });
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e), { signal });
    canvas.addEventListener('pointerleave', () => this.setHover(null), { signal });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { signal, passive: false });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.resize();
    this.emit('ready', undefined);
    this.scheduleViewChanged();
  }

  unmount(): void {
    this.abort.abort();
    this.resizeObserver?.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.container = null;
  }

  setMode(_mode: RenderMode): void {
    /* only 2D is available in the demo host */
  }
  activeMode(): '2D' {
    return '2D';
  }
  supportsMode(mode: '2D' | '3D'): boolean {
    return mode === '2D';
  }

  getView(): ViewState {
    return {
      center: { ...this.center },
      zoom: this.zoom,
      altitudeM: zoomToAltitudeM(this.zoom, this.center.latitude),
      headingDegrees: 0,
      pitchDegrees: -90,
      bounds: this.bounds(),
    };
  }

  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts?: { durationMs?: number },
  ): Promise<void> {
    const toZoom = target.bounds
      ? this.zoomForBounds(target.bounds)
      : (target.zoom ??
        (target.altitudeM !== undefined ? altitudeToZoom(target.altitudeM, target.position.latitude) : this.zoom));
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 0 : (opts?.durationMs ?? 600);
    const from = { lat: this.center.latitude, lon: this.center.longitude, zoom: this.zoom };
    const to = {
      lat: target.position.latitude,
      lon: target.position.longitude,
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, toZoom)),
    };
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    if (duration === 0 || typeof requestAnimationFrame !== 'function') {
      this.center = { latitude: to.lat, longitude: to.lon };
      this.zoom = to.zoom;
      this.redraw();
      this.scheduleViewChanged(0);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - start) / duration);
        const e = 1 - Math.pow(1 - k, 3);
        this.center = { latitude: from.lat + (to.lat - from.lat) * e, longitude: from.lon + (to.lon - from.lon) * e };
        this.zoom = from.zoom + (to.zoom - from.zoom) * e;
        this.redraw();
        if (k < 1) this.animation = requestAnimationFrame(step);
        else {
          this.animation = null;
          this.scheduleViewChanged(0);
          resolve();
        }
      };
      this.animation = requestAnimationFrame(step);
    });
  }

  select(featureId: string | null): void {
    this.selectedId = featureId;
    this.redraw();
  }
  setLens(lens: LensDefinition): void {
    this.lens = lens;
    this.redraw();
  }
  setAttribution(entries: AttributionEntry[]): void {
    this.attribution = entries;
    this.redraw();
  }

  setFeatures(update: FeatureUpdate): void {
    if (update.replaceLayers?.length)
      for (const [id, f] of [...this.features]) if (update.replaceLayers.includes(f.layer)) this.features.delete(id);
    for (const id of update.remove) this.features.delete(id);
    for (const f of update.upsert) this.features.set(f.id, f);
    this.redraw();
  }

  on<K extends keyof RendererEvents>(event: K, listener: (payload: RendererEvents[K]) => void): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  // ---- projection ----------------------------------------------------------------------------

  private scale(): number {
    return TILE * Math.pow(2, this.zoom);
  }

  private project(lat: number, lon: number): { x: number; y: number } {
    const s = this.scale();
    const clampedLat = Math.max(-85.05, Math.min(85.05, lat));
    const c = this.projectRaw(this.center.latitude, this.center.longitude, s);
    const p = this.projectRaw(clampedLat, lon, s);
    let dx = p.x - c.x;
    if (dx > s / 2) dx -= s;
    else if (dx < -s / 2) dx += s;
    return { x: this.width / 2 + dx, y: this.height / 2 + (p.y - c.y) };
  }

  private projectRaw(lat: number, lon: number, s: number): { x: number; y: number } {
    const x = ((lon + 180) / 360) * s;
    const sin = Math.sin((lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s;
    return { x, y };
  }

  private unproject(x: number, y: number): GeoPosition {
    const s = this.scale();
    const c = this.projectRaw(this.center.latitude, this.center.longitude, s);
    const px = c.x + (x - this.width / 2);
    const py = c.y + (y - this.height / 2);
    const lon = (px / s) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * py) / s;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { latitude: Math.max(-85, Math.min(85, lat)), longitude: ((((lon + 180) % 360) + 360) % 360) - 180 };
  }

  private bounds(): GeoBounds {
    const nw = this.unproject(0, 0),
      se = this.unproject(this.width, this.height);
    const s = this.scale();
    const coversWorld = this.width >= s;
    return {
      west: coversWorld ? -180 : nw.longitude,
      east: coversWorld ? 180 : se.longitude,
      north: nw.latitude,
      south: se.latitude,
    };
  }

  private zoomForBounds(b: GeoBounds): number {
    const lonSpan = Math.max(0.001, (b.east - b.west + 360) % 360 || 360);
    const latSpan = Math.max(0.001, b.north - b.south);
    const zx = Math.log2((this.width * 360) / (lonSpan * TILE));
    const zy = Math.log2((this.height * 170) / (latSpan * TILE));
    return Math.min(zx, zy) - 0.3;
  }

  // ---- interaction ------------------------------------------------------------------------------

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.canvas?.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.drag = { x: p.x, y: p.y, startLon: this.center.longitude, startLat: this.center.latitude, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.drag) {
      const dx = p.x - this.drag.x,
        dy = p.y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (!this.drag.moved) return;
      const s = this.scale();
      const c = this.projectRaw(this.drag.startLat, this.drag.startLon, s);
      const next = this.unprojectAbs(c.x - dx, c.y - dy, s);
      this.center = next;
      this.redraw();
      this.scheduleViewChanged();
      return;
    }
    const hit = this.pick(p.x, p.y);
    this.setHover(hit);
  }

  private unprojectAbs(px: number, py: number, s: number): GeoPosition {
    const lon = (px / s) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * py) / s;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { latitude: Math.max(-85, Math.min(85, lat)), longitude: ((((lon + 180) % 360) + 360) % 360) - 180 };
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (!drag.moved) {
      const p = this.local(e);
      this.emit('pick', this.pick(p.x, p.y));
    } else this.scheduleViewChanged(0);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const before = this.unproject(p.x, p.y);
    const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + delta));
    // keep the geographic point under the cursor fixed
    const after = this.unproject(p.x, p.y);
    this.center = {
      latitude: Math.max(-85, Math.min(85, this.center.latitude + (before.latitude - after.latitude))),
      longitude: ((this.center.longitude + (before.longitude - after.longitude) + 540) % 360) - 180,
    };
    this.redraw();
    this.scheduleViewChanged();
  }

  private pick(x: number, y: number): PickResult | null {
    let best: { f: RenderFeature; d: number; pos: GeoPosition } | null = null;
    for (const f of this.features.values()) {
      if (!f.interactive) continue;
      const g = f.geometry;
      const pos =
        g.kind === 'point'
          ? g.position
          : g.kind === 'cluster'
            ? g.position
            : g.kind === 'polygon'
              ? centroid(g.rings[0] ?? [])
              : null;
      if (!pos) continue;
      const p = this.project(pos.latitude, pos.longitude);
      const radius = Math.max(8, (f.style.size ?? 6) / 2 + 4);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= radius && (!best || d < best.d || (d === best.d && f.priority > best.f.priority))) best = { f, d, pos };
    }
    if (!best) return null;
    const r: PickResult = { featureId: best.f.id, position: best.pos, screen: { x, y } };
    if (best.f.objectId) r.objectId = best.f.objectId;
    if (best.f.eventId) r.eventId = best.f.eventId;
    return r;
  }

  private setHover(hit: PickResult | null): void {
    const id = hit?.featureId ?? null;
    if (id === this.hoverId) return;
    this.hoverId = id;
    if (this.canvas) this.canvas.style.cursor = id ? 'pointer' : 'grab';
    this.emit('hover', hit);
  }

  private scheduleViewChanged(delayMs = 120): void {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      this.emit('viewChanged', this.getView());
    }, delayMs);
  }

  private emit<K extends keyof RendererEvents>(event: K, payload: RendererEvents[K]): void {
    for (const l of [...this.listeners[event]]) l(payload);
  }

  // ---- drawing -----------------------------------------------------------------------------------

  private resize(): void {
    if (!this.canvas || !this.container) return;
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
    this.scheduleViewChanged();
  }

  private redraw(): void {
    if (this.frame !== null || typeof requestAnimationFrame !== 'function') return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = performance.now();
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawGraticule(ctx);
    const ordered = [...this.features.values()].sort((a, b) => a.priority - b.priority);
    for (const f of ordered) if (f.geometry.kind === 'density') this.drawDensity(ctx, f);
    for (const f of ordered) if (f.geometry.kind === 'polygon') this.drawPolygon(ctx, f);
    for (const f of ordered) if (f.geometry.kind === 'line') this.drawLine(ctx, f);
    for (const f of ordered) if (f.geometry.kind === 'cluster') this.drawCluster(ctx, f);
    for (const f of ordered) if (f.geometry.kind === 'point') this.drawPoint(ctx, f);
    this.drawAttribution(ctx);
    const dt = performance.now() - t0;
    this.emit('frame', {
      fps: dt > 0 ? Math.min(60, Math.round(1000 / Math.max(dt, 16.7))) : 60,
      featureCount: this.features.size,
    });
  }

  private drawGraticule(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = '#1c2532';
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) {
      const a = this.project(85, lon),
        b = this.project(-85, lon);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = this.project(lat, -180),
        b = this.project(lat, 180);
      const s = this.scale();
      if (this.width < s) {
        ctx.beginPath();
        ctx.moveTo(0, a.y);
        ctx.lineTo(this.width, b.y);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = '#243040';
    const eqA = this.project(0, -180),
      eqB = this.project(0, 180);
    ctx.beginPath();
    ctx.moveTo(Math.min(0, eqA.x), eqA.y);
    ctx.lineTo(Math.max(this.width, eqB.x), eqB.y);
    ctx.stroke();
  }

  private drawDensity(ctx: CanvasRenderingContext2D, f: RenderFeature): void {
    if (f.geometry.kind !== 'density') return;
    const b = f.geometry.bounds;
    const nw = this.project(b.north, b.west),
      se = this.project(b.south, b.east);
    ctx.fillStyle = colorFor(f.style.styleClass, f.style.color);
    ctx.globalAlpha = 0.12 + 0.5 * f.geometry.intensity;
    ctx.fillRect(nw.x, nw.y, Math.max(1, se.x - nw.x), Math.max(1, se.y - nw.y));
    ctx.globalAlpha = 1;
    if (f.style.label && se.x - nw.x > 24) {
      ctx.fillStyle = '#e6edf3';
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.style.label, (nw.x + se.x) / 2, (nw.y + se.y) / 2 + 4);
    }
  }

  private drawPolygon(ctx: CanvasRenderingContext2D, f: RenderFeature): void {
    if (f.geometry.kind !== 'polygon') return;
    const color = colorFor(f.style.styleClass, f.style.color);
    for (const ring of f.geometry.rings) {
      ctx.beginPath();
      ring.forEach((p, i) => {
        const s = this.project(p.latitude, p.longitude);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = f.style.selected ? 0.35 : 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = f.style.selected ? 2 : 1;
      ctx.stroke();
    }
  }

  private drawLine(ctx: CanvasRenderingContext2D, f: RenderFeature): void {
    if (f.geometry.kind !== 'line') return;
    ctx.beginPath();
    f.geometry.positions.forEach((p, i) => {
      const s = this.project(p.latitude, p.longitude);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.strokeStyle = colorFor(f.style.styleClass, f.style.color);
    ctx.lineWidth = f.style.size ?? 2;
    ctx.setLineDash(f.style.lineStyle === 'dashed' ? [6, 4] : f.style.lineStyle === 'trail' ? [2, 3] : []);
    ctx.globalAlpha = f.style.opacity ?? 0.9;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawCluster(ctx: CanvasRenderingContext2D, f: RenderFeature): void {
    if (f.geometry.kind !== 'cluster') return;
    const p = this.project(f.geometry.position.latitude, f.geometry.position.longitude);
    const r = (f.style.size ?? 20) / 2;
    const color = colorFor(f.style.styleClass, f.style.color);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#e6edf3';
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(f.style.label ?? String(f.geometry.count), p.x, p.y + 4);
  }

  private drawPoint(ctx: CanvasRenderingContext2D, f: RenderFeature): void {
    if (f.geometry.kind !== 'point') return;
    const p = this.project(f.geometry.position.latitude, f.geometry.position.longitude);
    if (p.x < -40 || p.y < -40 || p.x > this.width + 40 || p.y > this.height + 40) return;
    const color = colorFor(f.style.styleClass, f.style.color);
    const size = f.style.size ?? 6;
    const selected = f.style.selected || f.id === this.selectedId;
    const hovered = f.style.hovered || f.id === this.hoverId;
    ctx.globalAlpha = f.style.opacity ?? 1;
    if (f.style.icon === 'aircraft' || f.style.icon === 'vessel') {
      const rot = ((f.style.rotationDegrees ?? 0) * Math.PI) / 180;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.7, size);
      ctx.lineTo(0, size * 0.5);
      ctx.lineTo(-size * 0.7, size);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, size / 2), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (f.style.styleClass.startsWith('earthquake')) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (selected || hovered) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(6, size) + 5, 0, Math.PI * 2);
      ctx.strokeStyle = selected ? '#e6edf3' : '#62d9e6';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
    }
    if (f.style.label && (selected || this.zoom >= 5 || (f.style.labelPriority ?? 0) >= 60)) {
      ctx.fillStyle = selected ? '#e6edf3' : '#a3b3c4';
      ctx.font = `${selected ? 600 : 400} 11px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(f.style.label, p.x + Math.max(6, size) + 6, p.y + 4);
    }
  }

  private drawAttribution(ctx: CanvasRenderingContext2D): void {
    const text = this.attribution
      .filter((a) => a.onScreen)
      .map((a) => a.text)
      .join(' · ');
    if (!text) return;
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#7f8d9e';
    ctx.fillText(text, this.width - 8, this.height - 8);
  }
}

function centroid(ring: GeoPosition[]): GeoPosition | null {
  if (ring.length === 0) return null;
  let lat = 0,
    lon = 0;
  for (const p of ring) {
    lat += p.latitude;
    lon += p.longitude;
  }
  return { latitude: lat / ring.length, longitude: lon / ring.length };
}

export function createCanvasHost(): CanvasRendererHost {
  return new CanvasRendererHost();
}
