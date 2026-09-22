import type { AttributionEntry } from '@worldview/render-core';
import type { ControlLike, MapLibreLike, MapLike } from './maplibre-like.js';

/**
 * Attribution through MapLibre's AttributionControl. Basemap attribution comes
 * from the style's source `attribution`; data attributions are added as custom
 * entries, on-screen ones first. The control is rebuilt only when the rendered
 * list changes. Never hidden by clean-view/recording modes (legal rule).
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function attributionMarkup(entries: AttributionEntry[]): string[] {
  const ordered = [...entries].sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of ordered) {
    const text = escapeHtml(e.text);
    const html =
      e.url && /^https?:\/\//i.test(e.url)
        ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${text}</a>`
        : text;
    if (seen.has(html)) continue;
    seen.add(html);
    out.push(html);
  }
  return out;
}

export class AttributionSync {
  private control: ControlLike | undefined;
  private key = '';
  constructor(
    private readonly maplibre: Pick<MapLibreLike, 'AttributionControl'>,
    private readonly map: MapLike,
  ) {}

  apply(entries: AttributionEntry[]): boolean {
    const markup = attributionMarkup(entries);
    const key = markup.join('\u0000');
    if (key === this.key && this.control) return false;
    this.key = key;
    if (this.control) this.map.removeControl(this.control);
    this.control = new this.maplibre.AttributionControl({ compact: false, customAttribution: markup });
    this.map.addControl(this.control, 'bottom-right');
    return true;
  }

  get current(): string {
    return this.key;
  }

  dispose(): void {
    if (this.control) this.map.removeControl(this.control);
    this.control = undefined;
    this.key = '';
  }
}
