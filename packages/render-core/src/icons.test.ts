import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICON_IDS, drawGlyph, renderIconSprites, type GlyphCanvas, type GlyphContext } from './icons.js';

/** Recording 2D context: captures the path commands so glyphs can be checked without a canvas. */
function recordingContext(): GlyphContext & { ops: string[] } {
  const ops: string[] = [];
  const ctx = {
    ops,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    globalAlpha: 1,
    beginPath: () => {
      ops.push('beginPath');
    },
    closePath: () => {
      ops.push('closePath');
    },
    moveTo: (x: number, y: number) => {
      ops.push(`moveTo ${x.toFixed(2)},${y.toFixed(2)}`);
    },
    lineTo: (x: number, y: number) => {
      ops.push(`lineTo ${x.toFixed(2)},${y.toFixed(2)}`);
    },
    arc: (x: number, y: number, r: number) => {
      ops.push(`arc ${x.toFixed(2)},${y.toFixed(2)},${r.toFixed(2)}`);
    },
    rect: (x: number, y: number, w: number, h: number) => {
      ops.push(`rect ${x},${y},${w},${h}`);
    },
    fill: () => {
      ops.push('fill');
    },
    stroke: () => {
      ops.push('stroke');
    },
    clearRect: () => {
      ops.push('clearRect');
    },
    save: () => {
      ops.push('save');
    },
    restore: () => {
      ops.push('restore');
    },
    translate: () => {
      ops.push('translate');
    },
    rotate: () => {
      ops.push('rotate');
    },
    scale: (x: number, y: number) => {
      ops.push(`scale ${x},${y}`);
    },
  };
  return ctx;
}

function fakeCanvas(width: number, height: number): GlyphCanvas & { ctx: ReturnType<typeof recordingContext> } {
  const ctx = recordingContext();
  return {
    width,
    height,
    ctx,
    getContext: () => ctx,
    toDataURL: () => `data:image/png;base64,${Buffer.from(ctx.ops.join('|')).toString('base64').slice(0, 24)}`,
  };
}

test('icons: every icon draws a distinct, non-empty path and stays inside the unit box', () => {
  const signatures = new Map<string, string>();
  for (const id of ICON_IDS) {
    const ctx = recordingContext();
    drawGlyph(ctx, id, 32);
    const drawing = ctx.ops.filter((o) => /^(fill|stroke)$/.test(o));
    assert.ok(drawing.length >= 1, `${id} paints something`);
    assert.equal(ctx.ops[0], 'save');
    assert.equal(ctx.ops[ctx.ops.length - 1], 'restore');
    assert.ok(ctx.ops.includes('scale 32,32'), 'unit box scaled to size');
    for (const op of ctx.ops) {
      const m = /^(?:moveTo|lineTo) ([\d.]+),([\d.]+)$/.exec(op);
      if (m) {
        assert.ok(
          Number(m[1]) >= 0 && Number(m[1]) <= 1 && Number(m[2]) >= 0 && Number(m[2]) <= 1,
          `${id}: ${op} inside box`,
        );
      }
    }
    signatures.set(ctx.ops.join(';'), id);
  }
  assert.equal(signatures.size, ICON_IDS.length, 'no two icons share a drawing');
});

test('icons: unknown ids fall back to the default disc; sprites are rendered once per icon', () => {
  const a = recordingContext();
  drawGlyph(a, 'does-not-exist', 16);
  const b = recordingContext();
  drawGlyph(b, 'default', 16);
  assert.deepEqual(a.ops, b.ops);
  const sprites = renderIconSprites((w, h) => fakeCanvas(w, h), { sizePx: 24 });
  assert.equal(sprites.size, ICON_IDS.length);
  const aircraft = sprites.get('aircraft')!;
  assert.equal(aircraft.width, 24);
  assert.ok(aircraft.url.startsWith('data:image/png'));
});
