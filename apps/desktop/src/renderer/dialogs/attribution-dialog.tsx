import { MODEL_CREDITS, MODEL_LICENCE_URL } from '@worldview/render-core';
import { Button, Dialog, Section, StatusBadge } from '@worldview/ui';
import { selectBasemap, selectTerrain } from '../map-providers.js';
import { useActions, useAppState } from '../store/store.js';

/** Data & Attribution: every registered source's attribution and terms, plus the basemap/terrain credits. */
export function AttributionDialog() {
  const { ui, sources, session } = useAppState();
  const actions = useActions();
  if (ui.dialog !== 'attribution') return null;
  const basemap = selectBasemap(session.mapProviders, session.settings?.basemapId);
  const terrain = selectTerrain(session.mapProviders, session.settings?.terrainId);
  return (
    <Dialog
      open
      title="Data & attribution"
      onClose={() => actions.closeDialog()}
      size="md"
      description="Who the data comes from and under which terms. Sources that require attribution are credited on screen when their data is visible."
    >
      <Section title="Map">
        <ul className="wv-attribution">
          {basemap ? (
            <li>
              <strong>{basemap.name}</strong>
              {basemap.attribution ? <span> — {basemap.attribution}</span> : null}
            </li>
          ) : (
            <li className="wv-ctx-muted">Basemap: {session.settings?.basemapId ?? 'unknown'}</li>
          )}
          {terrain ? (
            <li>
              <strong>Terrain: {terrain.name}</strong>
              {terrain.attribution ? <span> — {terrain.attribution}</span> : null}
            </li>
          ) : null}
        </ul>
      </Section>
      <Section title="Data sources">
        {sources.entries.length === 0 ? (
          <p className="wv-ctx-muted">No sources registered.</p>
        ) : (
          <ul className="wv-attribution">
            {sources.entries.map((e) => (
              <li key={e.providerId} className="wv-attribution__row">
                <div className="wv-attribution__head">
                  <strong>{e.name}</strong>
                  <StatusBadge kind="provider" value={e.health.status} size="sm" />
                  {!e.enabled ? <span className="wv-ctx-muted">disabled</span> : null}
                </div>
                <span>{e.meta.attribution}</span>
                <span className="wv-ctx-muted">
                  {e.meta.commercialReview.replace(/-/g, ' ')}
                  {e.meta.cacheAllowed ? '' : ' · no caching'}
                </span>
                {e.meta.termsUrl ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="external"
                    onClick={() => void actions.openExternal(e.meta.termsUrl!)}
                  >
                    Terms
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {/* The globe credits a model on screen while it is drawn; listed here whether or not one is. */}
      <Section title="3D models (globe, close in)">
        <ul className="wv-attribution">
          {[...new Map(Object.values(MODEL_CREDITS).map((c) => [c.sourceUrl, c])).values()].map((c) => (
            <li key={c.sourceUrl} className="wv-attribution__row">
              <div className="wv-attribution__head">
                <strong>“{c.title}”</strong>
              </div>
              <span>by {c.author}, CC BY 4.0, modified</span>
              <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(c.sourceUrl)}>
                Source
              </Button>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(MODEL_LICENCE_URL)}>
          CC BY 4.0
        </Button>
      </Section>
      {session.appInfo?.demoMode ? (
        <Section title="Demo">
          <p>
            This build shows recorded and synthetic data only. Attribution lines describe where the recorded samples
            originate.
          </p>
        </Section>
      ) : null}
    </Dialog>
  );
}
