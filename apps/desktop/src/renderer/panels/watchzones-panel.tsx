import { useState, type FormEvent } from 'react';
import type { SeverityClass } from '@worldview/world-model';
import type { EventTypeInfo, WatchZone } from '@worldview/ipc-contract';
import {
  Button,
  EmptyState,
  IconButton,
  Panel,
  Section,
  Toggle,
  formatCoordinates,
  formatDistance,
} from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { zoneEventTypes } from '../store/watch-zones.js';

const SEVERITIES: SeverityClass[] = ['INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME'];

/** Parses "lat, lon" lines into a polygon ring ([lon, lat] pairs). Exported for tests. */
export function parsePolygonText(text: string): { ring: Array<[number, number]>; error?: string } {
  const ring: Array<[number, number]> = [];
  for (const raw of text.split(/\n|;/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.split(/[,\s]+/).map(Number);
    if (
      m.length < 2 ||
      !Number.isFinite(m[0]) ||
      !Number.isFinite(m[1]) ||
      Math.abs(m[0]!) > 90 ||
      Math.abs(m[1]!) > 180
    )
      return { ring: [], error: `Cannot read "${line}" — use "latitude, longitude" per line` };
    ring.push([m[1]!, m[0]!]);
  }
  if (ring.length < 3) return { ring: [], error: 'A polygon needs at least three points' };
  const first = ring[0]!,
    last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return { ring };
}

/** Watch zones (directive §67): circle from the map centre + radius, polygon by typed coordinates, event types / severity / notifications. */
export function WatchZonesPanel() {
  const { watchzones, world, session } = useAppState();
  const actions = useActions();
  const [radiusKm, setRadiusKm] = useState(50);
  const [polyText, setPolyText] = useState('');
  const [polyError, setPolyError] = useState<string | null>(null);
  const [polyName, setPolyName] = useState('');

  const createPolygon = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = parsePolygonText(polyText);
    if (parsed.error) {
      setPolyError(parsed.error);
      return;
    }
    setPolyError(null);
    void actions.saveWatchZone({
      id: `zone-${Date.now().toString(36)}`,
      name: polyName.trim() || `Polygon zone (${parsed.ring.length - 1} points)`,
      geometry: { kind: 'polygon', polygon: parsed.ring },
      eventTypes: zoneEventTypes(undefined, session.eventTypes),
      notifications: { inApp: true, desktop: false },
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    setPolyText('');
    setPolyName('');
  };

  return (
    <Panel title="Watch zones" subtitle={`${watchzones.zones.length} zones`}>
      <Section title="Create">
        <form
          className="wv-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void actions.createCircleZoneAtCenter(radiusKm * 1000);
          }}
        >
          <label className="wv-field-inline">
            Radius{' '}
            <input
              className="wv-input wv-input--sm"
              type="number"
              min={1}
              max={2000}
              step={1}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))}
              aria-label="Radius in kilometres"
            />{' '}
            km
          </label>
          <Button size="sm" type="submit" icon="target" variant="primary">
            Circle at map centre
          </Button>
        </form>
        <p className="wv-ctx-muted wv-num">
          Centre {formatCoordinates(world.view.center.latitude, world.view.center.longitude, 3)}
        </p>
        <form className="wv-stack-form" onSubmit={createPolygon}>
          <input
            className="wv-input"
            aria-label="Polygon zone name"
            placeholder="Polygon zone name"
            value={polyName}
            onChange={(e) => setPolyName(e.target.value)}
            maxLength={80}
          />
          <textarea
            className="wv-input wv-textarea"
            aria-label="Polygon coordinates, one latitude, longitude pair per line"
            rows={3}
            placeholder={'One "latitude, longitude" per line\n21.7, -158.3\n21.3, -156.0\n20.8, -156.1'}
            value={polyText}
            onChange={(e) => setPolyText(e.target.value)}
          />
          {polyError ? (
            <p className="wv-form-error" role="alert">
              {polyError}
            </p>
          ) : null}
          <Button size="sm" type="submit" icon="plus" disabled={!polyText.trim()}>
            Polygon from coordinates
          </Button>
        </form>
      </Section>
      {watchzones.zones.length === 0 ? (
        <EmptyState
          compact
          icon="target"
          title="No watch zones"
          description="Zones raise in-app notifications when matching events start inside them."
        />
      ) : (
        <ul className="wv-zones">
          {watchzones.zones.map((z) => (
            <ZoneRow key={z.id} zone={z} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ZoneRow({ zone }: { zone: WatchZone }) {
  const actions = useActions();
  const { session } = useAppState();
  // The runtime decides what can fire here; a type already on the zone stays listed even
  // if it became unavailable, so an existing subscription is visible rather than vanishing.
  const known = session.eventTypes ?? [];
  const eventTypes: EventTypeInfo[] = [
    ...known,
    ...zone.eventTypes
      .filter((t) => !known.some((k) => k.type === t))
      .map((type): EventTypeInfo => ({ type, label: type, available: true, objectTypes: [] })),
  ];
  const [open, setOpen] = useState(false);
  const save = (patch: Partial<WatchZone>) => void actions.saveWatchZone({ ...zone, ...patch });
  const g = zone.geometry;
  const where =
    g.kind === 'circle'
      ? `circle · ${formatDistance(g.radiusM)} around ${formatCoordinates(g.center.latitude, g.center.longitude, 2)}`
      : g.kind === 'polygon'
        ? `polygon · ${g.polygon.length - 1} points`
        : g.kind === 'bounds'
          ? 'bounds'
          : `region ${g.regionId}`;
  return (
    <li className="wv-zones__row">
      <div className="wv-zones__head">
        <Toggle
          size="sm"
          hideLabel
          label={`${zone.name} enabled`}
          checked={zone.enabled}
          onChange={(v) => save({ enabled: v })}
        />
        <button type="button" className="wv-ctx-link wv-truncate" onClick={() => actions.flyToZone(zone)}>
          {zone.name}
        </button>
        <IconButton
          icon={open ? 'chevronUp' : 'chevronDown'}
          label={open ? 'Collapse zone' : 'Edit zone'}
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
        <IconButton
          icon="trash"
          label={`Delete ${zone.name}`}
          size="sm"
          onClick={() => void actions.deleteWatchZone(zone.id)}
        />
      </div>
      <span className="wv-ctx-muted">{where}</span>
      {open ? (
        <div className="wv-zones__edit">
          <fieldset className="wv-fieldset">
            <legend className="wv-caps">Event types</legend>
            {eventTypes.map((t) => (
              <label key={t.type} className="wv-check" title={t.unavailableReason}>
                <input
                  type="checkbox"
                  checked={zone.eventTypes.includes(t.type)}
                  disabled={!t.available && !zone.eventTypes.includes(t.type)}
                  onChange={(e) =>
                    save({
                      eventTypes: e.target.checked
                        ? [...zone.eventTypes, t.type]
                        : zone.eventTypes.filter((x) => x !== t.type),
                    })
                  }
                />{' '}
                {t.label}
                {t.available ? null : <span className="wv-ctx-muted"> — {t.unavailableReason}</span>}
              </label>
            ))}
          </fieldset>
          <label className="wv-field-inline">
            Minimum severity
            <select
              className="wv-select"
              value={zone.minimumSeverity ?? 'INFO'}
              onChange={(e) => {
                const v = e.target.value as SeverityClass;
                const { minimumSeverity: _omit, ...rest } = zone;
                void actions.saveWatchZone(v === 'INFO' ? rest : { ...rest, minimumSeverity: v });
              }}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <Toggle
            size="sm"
            label="In-app notifications"
            checked={zone.notifications.inApp}
            onChange={(v) => save({ notifications: { ...zone.notifications, inApp: v } })}
          />
          <Toggle
            size="sm"
            label="Desktop notifications"
            checked={zone.notifications.desktop}
            onChange={(v) => save({ notifications: { ...zone.notifications, desktop: v } })}
          />
          {zone.notifications.desktop ? (
            <label className="wv-field-inline wv-zones__indent">
              Desktop from
              <select
                className="wv-select"
                value={zone.desktopMinimumSeverity ?? 'INFO'}
                title="Only events at least this severe reach the desktop; the feed and in-app notices keep the rest."
                onChange={(e) => {
                  const v = e.target.value as SeverityClass;
                  const { desktopMinimumSeverity: _omit, ...rest } = zone;
                  void actions.saveWatchZone(v === 'INFO' ? rest : { ...rest, desktopMinimumSeverity: v });
                }}
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'INFO' ? 'any severity' : `${s.charAt(0)}${s.slice(1).toLowerCase()} and above`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Toggle
            size="sm"
            label="Quiet hours"
            checked={zone.quietHours !== undefined}
            onChange={(v) => {
              const { quietHours: _omit, ...rest } = zone;
              void actions.saveWatchZone(v ? { ...rest, quietHours: DEFAULT_QUIET_HOURS } : rest);
            }}
          />
          {zone.quietHours ? (
            <div className="wv-zones__quiet">
              <label className="wv-field-inline">
                From
                <input
                  type="time"
                  className="wv-input wv-input--time"
                  value={zone.quietHours.start}
                  onChange={(e) =>
                    isClockTime(e.target.value) && e.target.value !== zone.quietHours!.end
                      ? save({ quietHours: { ...zone.quietHours!, start: e.target.value } })
                      : undefined
                  }
                />
              </label>
              <label className="wv-field-inline">
                to
                <input
                  type="time"
                  className="wv-input wv-input--time"
                  value={zone.quietHours.end}
                  onChange={(e) =>
                    isClockTime(e.target.value) && e.target.value !== zone.quietHours!.start
                      ? save({ quietHours: { ...zone.quietHours!, end: e.target.value } })
                      : undefined
                  }
                />
              </label>
              <span className="wv-ctx-muted">
                This computer's time. Only severe and extreme events notify; the rest are still in the feed.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Quiet hours a zone starts with when they are switched on. */
export const DEFAULT_QUIET_HOURS = { start: '22:00', end: '07:00' } as const;

function isClockTime(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
