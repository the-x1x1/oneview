/**
 * Shared icon set drawn with plain canvas paths (no SVG assets, no fonts). Each
 * glyph is drawn white, centred in a `size × size` box and pointing north so
 * renderers can tint (billboard colour / icon-color) and rotate it by heading.
 *
 * The drawing code targets the minimal `GlyphContext` interface so it is testable
 * with a recording context in Node; in the browser a CanvasRenderingContext2D
 * satisfies it structurally.
 */
export const ICON_IDS = ['aircraft', 'vessel', 'satellite', 'fire', 'camera', 'alert', 'infrastructure', 'launch', 'sensor', 'weather', 'transit', 'cluster', 'default'] as const;
export type IconId = (typeof ICON_IDS)[number];

export interface GlyphContext {
  /** `string | object` so a real CanvasRenderingContext2D (gradients/patterns) satisfies the interface. */
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  globalAlpha: number;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
}

export interface GlyphCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): GlyphContext | null;
  toDataURL(type?: string): string;
}

export type CanvasFactory = (width: number, height: number) => GlyphCanvas;

export interface IconSprite {
  id: string;
  /** PNG data URL (stable per icon+size, so renderers can dedupe by string). */
  url: string;
  width: number;
  height: number;
}

export function isIconId(id: string): id is IconId {
  return (ICON_IDS as readonly string[]).includes(id);
}

function poly(ctx: GlyphContext, pts: Array<[number, number]>): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/**
 * Draw one glyph. Coordinates are in a unit box scaled to `size`; (0.5, 0.5) is the
 * centre and −y is north (up).
 */
export function drawGlyph(ctx: GlyphContext, icon: string, size: number, color = '#ffffff'): void {
  const id: IconId = isIconId(icon) ? icon : 'default';
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.scale(size, size);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.06;
  switch (id) {
    case 'aircraft':
      // Fuselage + swept wings + tailplane, nose up.
      poly(ctx, [[0.5, 0.06], [0.56, 0.2], [0.56, 0.42], [0.92, 0.6], [0.92, 0.68], [0.56, 0.58], [0.55, 0.78], [0.68, 0.88], [0.68, 0.94], [0.5, 0.9], [0.32, 0.94], [0.32, 0.88], [0.45, 0.78], [0.44, 0.58], [0.08, 0.68], [0.08, 0.6], [0.44, 0.42], [0.44, 0.2]]);
      ctx.fill();
      break;
    case 'vessel':
      // Hull outline: pointed bow, flat stern.
      poly(ctx, [[0.5, 0.06], [0.72, 0.38], [0.72, 0.9], [0.28, 0.9], [0.28, 0.38]]);
      ctx.fill();
      break;
    case 'satellite':
      // Body with two solar panels.
      ctx.beginPath(); ctx.rect(0.4, 0.38, 0.2, 0.24); ctx.fill();
      ctx.beginPath(); ctx.rect(0.06, 0.44, 0.28, 0.12); ctx.fill();
      ctx.beginPath(); ctx.rect(0.66, 0.44, 0.28, 0.12); ctx.fill();
      ctx.beginPath(); ctx.arc(0.5, 0.5, 0.34, 0, Math.PI * 2); ctx.lineWidth = 0.04; ctx.stroke();
      break;
    case 'fire':
      // Flame: teardrop with an inner notch.
      ctx.beginPath();
      ctx.moveTo(0.5, 0.06);
      ctx.lineTo(0.78, 0.5);
      ctx.arc(0.5, 0.62, 0.3, -0.3, Math.PI + 0.3, false);
      ctx.closePath();
      ctx.fill();
      break;
    case 'camera':
      // Body + lens ring.
      ctx.beginPath(); ctx.rect(0.12, 0.3, 0.76, 0.48); ctx.fill();
      ctx.beginPath(); ctx.rect(0.34, 0.2, 0.32, 0.12); ctx.fill();
      ctx.strokeStyle = '#00000080';
      ctx.beginPath(); ctx.arc(0.5, 0.54, 0.15, 0, Math.PI * 2); ctx.lineWidth = 0.08; ctx.stroke();
      break;
    case 'alert':
      // Triangle with a bar (exclamation without a font).
      poly(ctx, [[0.5, 0.08], [0.94, 0.88], [0.06, 0.88]]);
      ctx.fill();
      ctx.fillStyle = '#00000099';
      ctx.beginPath(); ctx.rect(0.46, 0.34, 0.08, 0.3); ctx.fill();
      ctx.beginPath(); ctx.arc(0.5, 0.76, 0.05, 0, Math.PI * 2); ctx.fill();
      break;
    case 'infrastructure':
      // Hexagon.
      poly(ctx, [[0.5, 0.06], [0.88, 0.28], [0.88, 0.72], [0.5, 0.94], [0.12, 0.72], [0.12, 0.28]]);
      ctx.fill();
      break;
    case 'launch':
      // Rocket: nose, body, fins.
      poly(ctx, [[0.5, 0.04], [0.64, 0.3], [0.64, 0.7], [0.36, 0.7], [0.36, 0.3]]);
      ctx.fill();
      poly(ctx, [[0.36, 0.56], [0.2, 0.84], [0.36, 0.78]]); ctx.fill();
      poly(ctx, [[0.64, 0.56], [0.8, 0.84], [0.64, 0.78]]); ctx.fill();
      ctx.beginPath(); ctx.rect(0.44, 0.7, 0.12, 0.14); ctx.fill();
      break;
    case 'sensor':
      // Dot with two rings.
      ctx.beginPath(); ctx.arc(0.5, 0.5, 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 0.05;
      ctx.beginPath(); ctx.arc(0.5, 0.5, 0.26, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0.5, 0.5, 0.42, 0, Math.PI * 2); ctx.stroke();
      break;
    case 'weather':
      // Cloud: three discs on a base.
      ctx.beginPath(); ctx.arc(0.36, 0.56, 0.18, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0.56, 0.44, 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0.72, 0.6, 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.rect(0.22, 0.58, 0.62, 0.18); ctx.fill();
      break;
    case 'transit':
      // Bus: rounded body with a windscreen band.
      ctx.beginPath(); ctx.rect(0.18, 0.12, 0.64, 0.7); ctx.fill();
      ctx.fillStyle = '#00000099';
      ctx.beginPath(); ctx.rect(0.26, 0.22, 0.48, 0.2); ctx.fill();
      ctx.beginPath(); ctx.arc(0.32, 0.86, 0.06, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0.68, 0.86, 0.06, 0, Math.PI * 2); ctx.fill();
      break;
    case 'cluster':
      // Disc with a translucent halo (count label is drawn by the renderer).
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.arc(0.5, 0.5, 0.48, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(0.5, 0.5, 0.34, 0, Math.PI * 2); ctx.fill();
      break;
    case 'default':
      ctx.beginPath(); ctx.arc(0.5, 0.5, 0.3, 0, Math.PI * 2); ctx.fill();
      break;
  }
  ctx.restore();
}

/** Render every icon once into a PNG data URL (white, tinted by the renderer). */
export function renderIconSprites(createCanvas: CanvasFactory, options: { sizePx?: number; icons?: readonly string[] } = {}): Map<string, IconSprite> {
  const size = options.sizePx ?? 32;
  const out = new Map<string, IconSprite>();
  for (const id of options.icons ?? ICON_IDS) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    drawGlyph(ctx, id, size);
    out.set(id, { id, url: canvas.toDataURL('image/png'), width: size, height: size });
  }
  return out;
}
