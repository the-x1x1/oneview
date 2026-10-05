import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NearbyPlaceResult } from '@worldview/ipc-contract';
import type { GeoPosition } from '@worldview/world-model';
import { Button } from '@worldview/ui';
import type { RendererHostLike } from '../renderer-host-like.js';
import { useActions } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';
import { cardPlacement, nearestPlaceText, whatsHereRows } from './whats-here-text.js';

export interface WhatsHereProps {
  host: RendererHostLike | undefined;
  position: GeoPosition;
  /** Where on the map it was asked about; null from the palette (the card goes top right). */
  screen: { x: number; y: number } | null;
  grid?: 'mgrs' | 'utm';
  home?: GeoPosition;
  selection?: { name: string; position: GeoPosition };
  /** The active collection, to add the point to. */
  collection?: { id: string; name: string };
}

/**
 * What's here: a card beside a point the operator right-clicked (or the middle of the view,
 * from the palette). It names the nearest town from the offline gazetteer, gives the point's
 * coordinates and grid reference to select and copy, how far it is from home and from the
 * selection, and the Sun and Moon there; and offers to centre the map on it, measure from it,
 * watch round it, or keep it in the active collection. It stays beside its point as the map
 * moves (DOM only, no re-render), hides while the point is out of sight, and closes with
 * Esc, its close button, or a click on the map.
 */
export function WhatsHere({ host, position, screen, grid, home, selection, collection }: WhatsHereProps) {
  const actions = useActions();
  const nowMs = useNow(5000);
  const ref = useRef<HTMLDivElement | null>(null);
  const [nearest, setNearest] = useState<NearbyPlaceResult | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setNearest(undefined);
    void actions.nearestPlace(position).then((p) => {
      if (live) setNearest(p);
    });
    return () => {
      live = false;
    };
  }, [actions, position]);

  // Beside its point, wherever the map has moved it; hidden while the point is out of sight.
  const place = useCallback(() => {
    const el = ref.current;
    const map = el?.parentElement;
    if (!el || !map) return;
    let point = screen;
    if (screen && host?.project) {
      const [projected] = host.project([position]);
      if (!projected) {
        el.style.visibility = 'hidden';
        return;
      }
      point = projected;
    }
    const at = cardPlacement(
      point,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: map.clientWidth, height: map.clientHeight },
    );
    el.style.visibility = '';
    el.style.transform = `translate3d(${Math.round(at.x)}px, ${Math.round(at.y)}px, 0)`;
  }, [host, position, screen]);

  useLayoutEffect(() => place());
  useEffect(() => (host ? host.on('viewChanged', place) : undefined), [host, place]);

  const rows = whatsHereRows({
    position,
    nowMs,
    ...(grid ? { grid } : {}),
    ...(home ? { home } : {}),
    ...(selection ? { selection } : {}),
  });
  const title = nearest ? nearestPlaceText(nearest) : undefined;
  const label = `${position.latitude.toFixed(3)}, ${position.longitude.toFixed(3)}`;

  return (
    <div ref={ref} className="wv-whats-here" role="dialog" aria-label="What's here">
      <div className="wv-whats-here__head">
        <div className="wv-whats-here__title">
          <span className="wv-caps">What's here</span>
          <strong aria-live="polite">
            {nearest === undefined ? 'Looking up the nearest town…' : title ? title.title : 'No town known nearby'}
          </strong>
          {title?.subtitle ? <span className="wv-ctx-muted">{title.subtitle}</span> : null}
        </div>
        <Button size="sm" variant="ghost" icon="close" aria-label="Close" onClick={() => actions.closeWhatsHere()} />
      </div>
      <dl className="wv-whats-here__rows">
        {rows.map((r) => (
          <div key={r.label} className="wv-whats-here__row">
            <dt>{r.label}</dt>
            {/* The window may not write to the clipboard (main.ts refuses every permission):
                a reference is selected whole with one click, then copied with Ctrl+C. */}
            <dd
              className={r.copyable ? 'wv-num wv-whats-here__copy' : 'wv-num'}
              {...(r.copyable ? { title: 'Click to select, then Ctrl+C' } : {})}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="wv-ctx-actions" role="group" aria-label="What's here actions">
        <Button
          size="sm"
          variant="ghost"
          icon="pin"
          onClick={() => {
            void host?.flyTo({ position, zoom: host.getView().zoom });
            actions.closeWhatsHere();
          }}
        >
          Centre here
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="ruler"
          onClick={() => {
            actions.measureFrom(position);
            actions.closeWhatsHere();
          }}
        >
          Measure from here
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="target"
          title="A watch zone 50 km round this point"
          onClick={() => {
            const name =
              !nearest || !title
                ? `Zone near ${label}`
                : nearest.distanceM < 1000
                  ? `Zone at ${title.title}`
                  : `Zone ${title.title}`;
            void actions.createCircleZoneAt(position, 50_000, name);
            actions.closeWhatsHere();
          }}
        >
          Watch here
        </Button>
        {collection ? (
          <Button
            size="sm"
            variant="ghost"
            icon="bookmark"
            title={`Add to “${collection.name}”`}
            onClick={() => {
              void actions.addLocationToCollection(collection.id, title?.title ?? label, position);
              actions.closeWhatsHere();
            }}
          >
            Collect
          </Button>
        ) : null}
      </div>
    </div>
  );
}
