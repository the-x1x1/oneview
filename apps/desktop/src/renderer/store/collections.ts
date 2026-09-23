import type { CollectionItem } from '@worldview/ipc-contract';

/** Whether a selection (object or event id) is already an item of a collection. */
export function isCollected(items: readonly CollectionItem[], selectedId: string | null | undefined): boolean {
  if (!selectedId) return false;
  return items.some((i) => i.objectId === selectedId || i.eventId === selectedId);
}
