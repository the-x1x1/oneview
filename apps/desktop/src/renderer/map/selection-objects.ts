import type { WorldObject } from '@worldview/world-model';
import type { RootState } from '../store/types.js';

/**
 * The objects to present, and the selected one when the subscription does not hold it (a
 * satellite on the far side, chosen from search, loaded only for its panel): it is drawn where
 * its details put it, so it has a marker and can be followed.
 */
export function* withSelection(
  objects: Iterable<WorldObject>,
  w: Pick<RootState['world'], 'objects' | 'selectedId' | 'selectedObject'>,
): Iterable<WorldObject> {
  yield* objects;
  const extra = w.selectedObject;
  if (extra && extra.id === w.selectedId && extra.position && !w.objects.has(extra.id)) yield extra;
}
