import { useState, type FormEvent } from 'react';
import type { Collection, CollectionItem } from '@worldview/ipc-contract';
import { Button, EmptyState, IconButton, Panel, Section, formatCoordinates, formatUtcDateTime } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';

/** Collections (directive §69): list/create/rename/delete; add selection/location; notes; export/import via IPC. */
export function CollectionsPanel() {
  const { collections, world } = useAppState();
  const actions = useActions();
  const [newName, setNewName] = useState('');
  const active = collections.collections.find((c) => c.id === collections.activeId) ?? null;

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!newName.trim()) return;
    void actions.createCollection(newName);
    setNewName('');
  };

  return (
    <Panel title="Collections" subtitle={`${collections.collections.length} collections`} actions={<IconButton icon="upload" label="Import collection" size="sm" onClick={() => void actions.importCollection()} />}>
      <form className="wv-inline-form" onSubmit={create}>
        <input className="wv-input" aria-label="New collection name" placeholder="New collection name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} />
        <Button size="sm" type="submit" variant="primary" icon="plus" disabled={!newName.trim()}>Create</Button>
      </form>
      {collections.collections.length === 0 ? (
        <EmptyState compact icon="bookmark" title="No collections yet" description="Create one to keep places, objects and events together with notes." />
      ) : (
        <ul className="wv-collections" role="list">
          {collections.collections.map((c) => (
            <li key={c.id} className={`wv-collections__item${c.id === collections.activeId ? ' wv-collections__item--active' : ''}`}>
              <button type="button" className="wv-collections__select" aria-pressed={c.id === collections.activeId} onClick={() => actions.setActiveCollection(c.id)}>
                <span className="wv-truncate">{c.name}</span>
                <span className="wv-ctx-muted wv-num">{c.items.length}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {active ? <CollectionDetail collection={active} hasSelection={!!world.selectedId} /> : null}
    </Panel>
  );
}

function CollectionDetail({ collection, hasSelection }: { collection: Collection; hasSelection: boolean }) {
  const actions = useActions();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(collection.name);

  return (
    <Section
      title={collection.name}
      actions={
        <>
          <IconButton icon="edit" label="Rename collection" size="sm" onClick={() => { setName(collection.name); setRenaming(true); }} />
          <IconButton icon="download" label="Export collection" size="sm" onClick={() => void actions.exportCollection(collection.id)} />
          <IconButton icon="trash" label="Delete collection" size="sm" onClick={() => void actions.deleteCollection(collection.id)} />
        </>
      }
    >
      {renaming ? (
        <form className="wv-inline-form" onSubmit={(e) => { e.preventDefault(); void actions.renameCollection(collection.id, name); setRenaming(false); }}>
          <input className="wv-input" aria-label="Collection name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          <Button size="sm" type="submit" variant="primary">Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
        </form>
      ) : null}
      <div className="wv-ctx-actions">
        {hasSelection ? <Button size="sm" icon="bookmark" onClick={() => void actions.addSelectionToCollection(collection.id)}>Add selection</Button> : null}
        <Button size="sm" icon="pin" onClick={() => void actions.addLocationToCollection(collection.id)}>Add map centre</Button>
      </div>
      {collection.items.length === 0 ? (
        <p className="wv-ctx-muted">Empty — add the current selection or the map centre.</p>
      ) : (
        <ul className="wv-collection-items">
          {collection.items.map((item) => <CollectionItemRow key={item.id} collectionId={collection.id} item={item} />)}
        </ul>
      )}
      <p className="wv-ctx-muted">Created {formatUtcDateTime(collection.createdAt)} · updated {formatUtcDateTime(collection.updatedAt)}</p>
    </Section>
  );
}

function CollectionItemRow({ collectionId, item }: { collectionId: string; item: CollectionItem }) {
  const actions = useActions();
  const [note, setNote] = useState(item.note ?? '');
  const [editing, setEditing] = useState(false);
  const goTo = () => {
    if (item.objectId) void actions.select(item.objectId, { kind: 'object', fly: true });
    else if (item.eventId) void actions.select(item.eventId, { kind: 'event', fly: true });
    else if (item.position) void actions.flyTo({ position: item.position, zoom: 9 });
  };
  const canGo = !!(item.objectId || item.eventId || item.position);
  return (
    <li className="wv-collection-items__row">
      <div className="wv-collection-items__head">
        <span className="wv-collection-items__kind wv-caps">{item.kind}</span>
        {canGo ? <button type="button" className="wv-ctx-link wv-truncate" onClick={goTo}>{item.title}</button> : <span className="wv-truncate">{item.title}</span>}
        <IconButton icon="edit" label={`Edit note for ${item.title}`} size="sm" onClick={() => setEditing((v) => !v)} />
        <IconButton icon="trash" label={`Remove ${item.title}`} size="sm" onClick={() => void actions.removeFromCollection(collectionId, item.id)} />
      </div>
      {item.position ? <span className="wv-ctx-muted wv-num">{formatCoordinates(item.position.latitude, item.position.longitude, 3)}</span> : null}
      {editing ? (
        <form className="wv-inline-form" onSubmit={(e) => { e.preventDefault(); void actions.setItemNote(collectionId, item.id, note); setEditing(false); }}>
          <textarea className="wv-input wv-textarea" aria-label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          <Button size="sm" type="submit" variant="primary">Save note</Button>
        </form>
      ) : item.note ? <p className="wv-collection-items__note">{item.note}</p> : null}
    </li>
  );
}
