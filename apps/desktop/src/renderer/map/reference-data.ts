import {
  REFERENCE_ATTRIBUTION,
  decodeReferenceBorders,
  decodeReferenceLabels,
  type ReferenceData,
} from '@worldview/render-core';

/**
 * The bundled reference layer (borders and names), loaded once from next to index.html
 * (apps/desktop/assets/reference, staged by scripts/renderer-assets.mjs) and decoded for
 * the renderers. A failed load is not remembered, so switching the layer off and on again
 * retries rather than staying broken for the session.
 */
let pending: Promise<ReferenceData> | undefined;

export function loadReferenceData(fetchImpl: typeof fetch = fetch): Promise<ReferenceData> {
  pending ??= (async () => {
    const get = async (file: string): Promise<unknown> => {
      const res = await fetchImpl(`reference/${file}`);
      if (!res.ok) throw new Error(`reference/${file}: HTTP ${res.status}`);
      return res.json();
    };
    const [borders, labels] = await Promise.all([get('borders.json'), get('labels.json')]);
    return {
      lines: decodeReferenceBorders(borders),
      labels: decodeReferenceLabels(labels),
      attribution: REFERENCE_ATTRIBUTION,
    };
  })().catch((err: unknown) => {
    pending = undefined;
    throw err;
  });
  return pending;
}

/** Test hook: forget the cached load. */
export function resetReferenceData(): void {
  pending = undefined;
}
