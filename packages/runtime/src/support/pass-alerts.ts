import type { PassAlertSettings } from '@worldview/ipc-contract';
import type { JsonValue } from '@worldview/world-model';

/**
 * Satellite pass alerts (Settings → `passAlerts`): a notice a few minutes before a listed
 * satellite rises over the operator's home view — by default only for passes it can be seen with
 * the eye. The passes are the satellite's source's own answer (`objectDetails` with the home
 * view as observer: CelesTrak works them out with SGP4 from the element set it keeps), asked
 * again every so often and whenever the settings change; each pass is announced once.
 *
 * Nothing here looks up where the operator is: the home view is the operator's own setting,
 * and without one there are no alerts.
 */

interface Pass {
  riseAt: string;
  riseAzimuthDeg?: number;
  culminationAt: string;
  culminationAzimuthDeg: number;
  maxElevationDeg: number;
  setAt?: string;
  setAzimuthDeg?: number;
  visibleFrom?: string;
  visibleUntil?: string;
}

/** How far ahead a pass is scheduled; later ones wait for the next look. */
export const PASS_ALERT_HORIZON_MS = 3 * 3600_000;
/** How often the passes are asked for again. */
export const PASS_ALERT_REFRESH_MS = 20 * 60_000;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
const hhmm = (iso: string) => new Date(Date.parse(iso)).toISOString().slice(11, 16);

function asPass(v: JsonValue): Pass | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, JsonValue>;
  if (typeof o['riseAt'] !== 'string' || !Number.isFinite(Date.parse(o['riseAt']))) return undefined;
  if (typeof o['culminationAt'] !== 'string' || typeof o['maxElevationDeg'] !== 'number') return undefined;
  if (typeof o['culminationAzimuthDeg'] !== 'number') return undefined;
  return o as unknown as Pass;
}

/** "Rises WNW at 05:12 UTC, highest 62° NNE at 05:15, sets E · visible to the eye 05:13–05:17 UTC". */
export function passAlertBody(pass: Pass): string {
  const rise = `Rises ${pass.riseAzimuthDeg !== undefined ? `${compass(pass.riseAzimuthDeg)} ` : ''}at ${hhmm(pass.riseAt)} UTC`;
  const top = `highest ${Math.round(pass.maxElevationDeg)}° ${compass(pass.culminationAzimuthDeg)} at ${hhmm(pass.culminationAt)}`;
  const set = pass.setAzimuthDeg !== undefined ? `, sets ${compass(pass.setAzimuthDeg)}` : '';
  const eye =
    pass.visibleFrom && pass.visibleUntil
      ? ` · visible to the eye ${hhmm(pass.visibleFrom)}–${hhmm(pass.visibleUntil)} UTC`
      : ' · not visible to the eye';
  return `${rise}, ${top}${set}${eye}`;
}

export interface PassAlertDeps {
  now: () => number;
  settings: () => PassAlertSettings | undefined;
  home: () => { latitude: number; longitude: number } | undefined;
  /** The satellite's sources' answers asked with the home view as observer (core.objectDetails). */
  details: (
    objectId: string,
    observer: { latitude: number; longitude: number },
  ) => Promise<Array<{ properties: Record<string, JsonValue> }>>;
  notify: (n: { id: string; title: string; body: string; desktop: boolean }) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export class PassAlerts {
  private readonly timers = new Map<string, unknown>();
  /** Passes already announced, by `objectId|riseAt`, with when they rose (to forget them later). */
  private readonly announced = new Map<string, number>();
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: PassAlertDeps) {}

  /** Ask for the passes again and schedule what is coming; one look at a time. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.look().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.running;
  }

  /** What is scheduled now (for tests and diagnostics). */
  scheduled(): string[] {
    return [...this.timers.keys()].sort();
  }

  stop(): void {
    for (const handle of this.timers.values()) this.deps.clearTimer(handle);
    this.timers.clear();
  }

  private async look(): Promise<void> {
    const cfg = this.deps.settings();
    const home = this.deps.home();
    const now = this.deps.now();
    for (const [key, rose] of this.announced) if (rose < now - 86_400_000) this.announced.delete(key);
    if (!cfg || !home || !cfg.satellites.length) {
      this.stop();
      return;
    }
    const lead = Math.max(1, Math.min(60, cfg.leadMinutes)) * 60_000;
    const wanted = new Map<string, { name: string; pass: Pass; alertAt: number }>();
    for (const sat of cfg.satellites.slice(0, 20)) {
      let answers: Array<{ properties: Record<string, JsonValue> }>;
      try {
        answers = await this.deps.details(sat.objectId, home);
      } catch {
        continue;
      }
      const raw = answers.flatMap((a) => (Array.isArray(a.properties['passes']) ? a.properties['passes'] : []));
      for (const item of raw) {
        const pass = asPass(item);
        if (!pass) continue;
        const riseMs = Date.parse(pass.riseAt);
        // Still to rise (a minute or more away), and soon enough to schedule now.
        if (riseMs - now < 60_000 || riseMs - lead - now > PASS_ALERT_HORIZON_MS) continue;
        if (cfg.visibleOnly && !(pass.visibleFrom && pass.visibleUntil)) continue;
        const key = `${sat.objectId}|${pass.riseAt}`;
        if (this.announced.has(key)) continue;
        wanted.set(key, { name: sat.name, pass, alertAt: riseMs - lead });
      }
    }
    for (const [key, handle] of this.timers)
      if (!wanted.has(key)) {
        this.deps.clearTimer(handle);
        this.timers.delete(key);
      }
    for (const [key, { name, pass, alertAt }] of wanted) {
      if (this.timers.has(key)) continue;
      // A look that comes after the alert time but before the rise announces at once.
      const delay = Math.max(0, alertAt - now);
      this.timers.set(
        key,
        this.deps.setTimer(() => this.fire(key, name, pass), delay),
      );
    }
  }

  private fire(key: string, name: string, pass: Pass): void {
    this.timers.delete(key);
    // As the settings are now: switched off since, nothing; the desktop switch as it stands.
    const cfg = this.deps.settings();
    if (!cfg || !cfg.satellites.some((s) => key.startsWith(`${s.objectId}|`))) return;
    const desktop = cfg.desktop;
    const riseMs = Date.parse(pass.riseAt);
    this.announced.set(key, riseMs);
    const minutes = Math.max(1, Math.round((riseMs - this.deps.now()) / 60_000));
    this.deps.notify({
      id: `pass:${key}`,
      title: `${name} over home in ${minutes} min`,
      body: passAlertBody(pass),
      desktop,
    });
  }
}
