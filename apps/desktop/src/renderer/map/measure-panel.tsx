import type { GeoPosition } from '@worldview/world-model';
import { Button } from '@worldview/ui';
import { useActions } from '../store/store.js';
import {
  formatArea,
  formatAreaAlt,
  formatDistance,
  formatDistanceAlt,
  measureArea,
  measureSummary,
} from './measure.js';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "063° ENE" */
export function formatBearing(deg: number): string {
  const d = Math.round(deg) % 360;
  return `${String(d).padStart(3, '0')}° ${COMPASS[Math.round(d / 22.5) % 16]}`;
}

/**
 * The measure tool's readout, over the map: the total along the clicked points, each leg's
 * distance and initial bearing, and Undo / Clear / Area / Done. A hint until there are two
 * points. With Area on, the shape closes back to its first point: the total is its perimeter,
 * the last leg the closing one, and the area it encloses is given (or why not).
 */
export function MeasurePanel({ points, area }: { points: readonly GeoPosition[]; area: boolean }) {
  const actions = useActions();
  const { legs, totalM } = measureSummary(points, area);
  const enclosed = area ? measureArea(points) : undefined;
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
            : 'Click a second point. Distances are the shortest way over the Earth (WGS84).'}
        </p>
      ) : (
        <ol className="wv-measure__legs">
          {legs.map((l, i) => (
            <li key={i} className="wv-num">
              {formatDistance(l.distanceM)} · {formatBearing(l.bearingDeg)}
              {area && points.length >= 3 && i === legs.length - 1 ? (
                <span className="wv-ctx-muted"> · back to the start</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {area ? (
        <p className="wv-measure__area wv-num" aria-live="polite">
          {enclosed === undefined ? (
            <span className="wv-ctx-muted">Area: three points or more enclose one.</span>
          ) : 'crossing' in enclosed ? (
            <span className="wv-ctx-muted">Area: the outline crosses itself, so it has none to give.</span>
          ) : (
            <>
              Area {formatArea(enclosed.areaM2)} <span className="wv-ctx-muted">{formatAreaAlt(enclosed.areaM2)}</span>
            </>
          )}
        </p>
      ) : null}
      <div className="wv-ctx-actions" role="group" aria-label="Measure actions">
        <Button size="sm" variant="ghost" disabled={!points.length} onClick={() => actions.undoMeasurePoint()}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" disabled={!points.length} onClick={() => actions.clearMeasure()}>
          Clear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          pressed={area}
          title="Close the shape back to the first point and give the area it encloses"
          onClick={() => actions.toggleMeasureArea()}
        >
          Area
        </Button>
        <Button size="sm" variant="secondary" onClick={() => actions.toggleMeasure()}>
          Done
        </Button>
      </div>
    </div>
  );
}
