import type { VisualStyleId } from '@worldview/render-core';
import type { CesiumLike, PostProcessStageLike, SceneLike } from './cesium-like.js';

/**
 * The visual styles on the globe (render-core visual-styles.ts): each one full-screen
 * post-process pass over the rendered frame, after the scene and before FXAA.
 *
 * Two rules every shader here keeps, because the target machine is an integrated GPU drawing
 * in request-render mode:
 *
 * - **Static.** No `time` uniform, nothing that changes from one frame to the next. A still
 *   view with a style on draws no frames at all, exactly as without one; grain and scanlines
 *   are patterns keyed to the pixel's position, so they sit still instead of crawling.
 * - **Cheap.** At most five texture reads per pixel, all from the one colour texture Cesium
 *   hands the stage, plus arithmetic. At 1920×1200 that is well under what one MSAA resolve
 *   costs. No second pass, no intermediate textures.
 *
 * The hash is interleaved gradient noise (Jimenez, *Next Generation Post Processing in Call
 * of Duty: Advanced Warfare*, 2014): one dot product and two `fract`s, and a pattern with
 * little low-frequency energy, so it reads as fine grain rather than blotches.
 */

const HEADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
in vec2 v_textureCoordinates;

float wvGrain(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

// Distance from the middle of the view, in units of the view's height (0.5 at the top edge),
// so round things stay round on a wide window.
float wvRadius(vec2 uv) {
  vec2 d = (uv - 0.5) * vec2(colorTextureDimensions.x / colorTextureDimensions.y, 1.0);
  return length(d);
}
`;

/**
 * Night vision: an image intensifier's green phosphor. Luminance lifted by a strong gain (the
 * tube's point is to make the dark readable), a soft four-tap glow standing in for phosphor
 * bloom, faint fixed grain, a scanline every third row, and the tube's round field of view —
 * darkened towards its edge but never to black, so nothing at the corners of the map is lost.
 * Five texture reads.
 */
const NIGHT_VISION = /* glsl */ `${HEADER}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 px = 1.5 / colorTextureDimensions;
  vec3 c = texture(colorTexture, uv).rgb * 0.52;
  c += texture(colorTexture, uv + vec2(px.x, 0.0)).rgb * 0.12;
  c += texture(colorTexture, uv - vec2(px.x, 0.0)).rgb * 0.12;
  c += texture(colorTexture, uv + vec2(0.0, px.y)).rgb * 0.12;
  c += texture(colorTexture, uv - vec2(0.0, px.y)).rgb * 0.12;
  float l = czm_luminance(c);
  l = pow(clamp(l * 2.1 + 0.03, 0.0, 1.0), 0.75);
  vec3 phosphor = vec3(0.32, 1.0, 0.40) * l + vec3(0.01, 0.035, 0.015);
  phosphor += (wvGrain(gl_FragCoord.xy) - 0.5) * 0.07;
  phosphor *= mod(floor(gl_FragCoord.y), 3.0) < 1.0 ? 0.84 : 1.0;
  float r = wvRadius(uv);
  float tube = mix(0.22, 1.0, 1.0 - smoothstep(0.46, 0.78, r));
  out_FragColor = vec4(clamp(phosphor * tube, 0.0, 1.0), 1.0);
}
`;

/**
 * Thermal: brightness read as heat and shown on an iron palette — black, purple, magenta,
 * red, orange, yellow, white. Bright markers and lit ground run hot, dark water cold. The
 * four diagonal taps blur by about a pixel, as a microbolometer's coarse sensor does, which
 * also keeps the palette from shimmering along fine lines. Five texture reads.
 */
const THERMAL = /* glsl */ `${HEADER}
vec3 wvIron(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.0, 0.0, 0.03), vec3(0.22, 0.0, 0.45), smoothstep(0.0, 0.2, t));
  c = mix(c, vec3(0.62, 0.02, 0.48), smoothstep(0.18, 0.38, t));
  c = mix(c, vec3(0.90, 0.16, 0.10), smoothstep(0.36, 0.56, t));
  c = mix(c, vec3(1.0, 0.56, 0.0), smoothstep(0.54, 0.74, t));
  c = mix(c, vec3(1.0, 0.90, 0.30), smoothstep(0.72, 0.9, t));
  return mix(c, vec3(1.0), smoothstep(0.88, 1.0, t));
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec2 px = 1.0 / colorTextureDimensions;
  vec3 c = texture(colorTexture, uv).rgb * 0.4;
  c += texture(colorTexture, uv + px).rgb * 0.15;
  c += texture(colorTexture, uv - px).rgb * 0.15;
  c += texture(colorTexture, uv + vec2(px.x, -px.y)).rgb * 0.15;
  c += texture(colorTexture, uv + vec2(-px.x, px.y)).rgb * 0.15;
  float heat = smoothstep(0.03, 0.8, czm_luminance(c));
  out_FragColor = vec4(wvIron(heat), 1.0);
}
`;

/**
 * A CRT monitor: gentle barrel distortion (black past the bent edge), the three colour
 * channels read a little apart towards the edges as a misconverged tube does, an aperture
 * grille of red, green and blue columns, a dark line every other row, and darker corners.
 * The bend is kept small — 1.5 % at the corners — because clicks still land where the
 * undistorted picture would be. Three texture reads.
 */
const CRT = /* glsl */ `${HEADER}
void main() {
  vec2 centred = v_textureCoordinates * 2.0 - 1.0;
  centred *= 1.0 + 0.015 * dot(centred, centred);
  vec2 uv = centred * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 shift = centred * (1.2 / colorTextureDimensions);
  vec3 c = vec3(
    texture(colorTexture, uv + shift).r,
    texture(colorTexture, uv).g,
    texture(colorTexture, uv - shift).b
  );
  float column = mod(floor(gl_FragCoord.x), 3.0);
  vec3 grille = column < 1.0 ? vec3(1.0, 0.7, 0.7) : column < 2.0 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0);
  c *= grille * 1.22;
  c *= mod(floor(gl_FragCoord.y), 2.0) < 1.0 ? 0.78 : 1.0;
  vec2 edge = uv * (1.0 - uv);
  float vignette = clamp(pow(edge.x * edge.y * 18.0, 0.22), 0.0, 1.0);
  out_FragColor = vec4(clamp(c * vignette * vec3(1.0, 1.02, 0.97), 0.0, 1.0), 1.0);
}
`;

/**
 * Noir: hard black-and-white. An S-curve on luminance crushes the shadows and lifts the
 * highlights, a faint warm-neutral tint keeps it from looking like a disabled screen, and
 * fixed grain and a vignette finish it. One texture read.
 */
const NOIR = /* glsl */ `${HEADER}
void main() {
  vec2 uv = v_textureCoordinates;
  float l = czm_luminance(texture(colorTexture, uv).rgb);
  l = smoothstep(0.06, 0.82, l);
  l += (wvGrain(gl_FragCoord.xy) - 0.5) * 0.06;
  float vignette = 1.0 - 0.55 * smoothstep(0.25, 0.85, wvRadius(uv));
  out_FragColor = vec4(clamp(vec3(l) * vec3(1.0, 0.985, 0.95) * vignette, 0.0, 1.0), 1.0);
}
`;

/** The fragment shader of each style; `standard` has none. */
export const VISUAL_STYLE_SHADERS: Readonly<Record<VisualStyleId, string | undefined>> = Object.freeze({
  standard: undefined,
  'night-vision': NIGHT_VISION,
  thermal: THERMAL,
  crt: CRT,
  noir: NOIR,
});

/**
 * The style in force on one scene: at most one post-process stage of ours in the collection.
 * A change removes the old stage (Cesium destroys it) and adds the new one; asking for the
 * style already shown does nothing. The stage is built on demand, so a user who never picks a
 * style never compiles a shader for one.
 */
export class VisualStyle3D {
  private current: VisualStyleId = 'standard';
  private stage: PostProcessStageLike | undefined;

  constructor(
    private readonly cesium: Pick<CesiumLike, 'PostProcessStage'>,
    private readonly scene: SceneLike,
  ) {}

  get id(): VisualStyleId {
    return this.current;
  }

  set(id: VisualStyleId): void {
    if (id === this.current) return;
    this.current = id;
    this.removeStage();
    const fragmentShader = VISUAL_STYLE_SHADERS[id];
    if (fragmentShader) {
      this.stage = new this.cesium.PostProcessStage({
        fragmentShader,
        name: `worldview_style_${id.replace('-', '_')}`,
      });
      this.scene.postProcessStages.add(this.stage);
    }
    this.scene.requestRender();
  }

  dispose(): void {
    this.removeStage();
  }

  private removeStage(): void {
    if (!this.stage) return;
    this.scene.postProcessStages.remove(this.stage);
    this.stage = undefined;
  }
}
