import type { GeoPosition } from '@worldview/world-model';
import { Button } from '@worldview/ui';
import { useActions } from '../store/store.js';
import { formatDistance, formatDistanceAlt, measureSummary } from './measure.js';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "063° ENE" */
export function formatBearing(deg: number): string {
  const d = Math.round(deg) % 360;
  return `${String(d).padStart(3, '0')}° ${COMPASS[Math.round(d / 22.5) % 16]}`;
}

/**
 * The measure tool's readout, over the map: the total along the clicked points, each leg's
 * distance and initial bearing, and Undo / Clear / Done. A hint until there are two points.
 */
export function MeasurePanel({ points }: { points: readonly GeoPosition[] }) {
  const actions = useActions();
  const { legs, totalM } = measureSummary(points);
  return (
    <div className="wv-measure" role="region" aria-label="Measure">
      <div className="wv-measure__head">
        <span className="wv-caps">Measure</span>
        {legs.length ? (
          <span className="wv-measure__total wv-num" aria-live="polite">
            {formatDistance(totalM)} <span className="wv-ctx-muted">{formatDistanceAlt(totalM)}</span>
          </span>
        ) : null}
      </div>
      {legs.length === 0 ? (
        <p className="wv-ctx-muted">
          {points.length === 0
            ? 'Click the map to start a line; every click adds a point.'
            : 'Click a second point. Distances are along the great circle.'}
        </p>
      ) : (
        <ol className="wv-measure__legs">
          {legs.map((l, i) => (
            <li key={i} className="wv-num">
              {formatDistance(l.distanceM)} · {formatBearing(l.bearingDeg)}
            </li>
          ))}
        </ol>
      )}
      <div className="wv-ctx-actions" role="group" aria-label="Measure actions">
        <Button size="sm" variant="ghost" disabled={!points.length} onClick={() => actions.undoMeasurePoint()}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" disabled={!points.length} onClick={() => actions.clearMeasure()}>
          Clear
        </Button>
        <Button size="sm" variant="secondary" onClick={() => actions.toggleMeasure()}>
          Done
        </Button>
      </div>
    </div>
  );
}
