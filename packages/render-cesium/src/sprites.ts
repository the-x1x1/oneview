import { renderIconSprites, type CanvasFactory, type IconSprite } from '@worldview/render-core';

/**
 * Billboard sprite sheet: every icon rendered once to a PNG data URL. Cesium
 * keys its texture atlas by the image string, so all billboards sharing an icon
 * share one atlas entry; tinting happens through `Billboard.color`.
 */
export interface SpriteSheet {
  get(icon: string): IconSprite;
  readonly size: number;
}

export const SPRITE_SIZE_PX = 48;

export function domCanvasFactory(): CanvasFactory {
  return (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}

export function createSpriteSheet(createCanvas: CanvasFactory, sizePx = SPRITE_SIZE_PX): SpriteSheet {
  const sprites = renderIconSprites(createCanvas, { sizePx });
  const fallback = sprites.get('default')!;
  return { size: sprites.size, get: (icon) => sprites.get(icon) ?? fallback };
}
