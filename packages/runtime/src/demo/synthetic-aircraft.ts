import type { JsonValue, Observation } from '@worldview/world-model';
import { observationId } from '@worldview/world-model';
import { ProviderError, type ProviderContext, type ProviderHealth, type ProviderManifest, type ProviderQuery, type WorldProvider } from '@worldview/provider-sdk';

/**
 * Demo aircraft provider: a fixed set of tracks that move as a pure function of the
 * clock, so a demo session is reproducible and a replay is identical. Nothing here is
 * live data — every observation carries `provenance.origin: 'recorded'` and the shell
 * labels it RECORDED DATA.
 *
 * The positions are synthetic great-circle-ish legs between real airports; they are not
 * derived from any real flight and are never presented as such.
 */
export interface DemoTrack {
  icao24: string;
  callsign: string;
  registration: string;
  model: string;
  origin: string;
  destination: string;
  from: { latitude: number; longitude: number };
  to: { latitude: number; longitude: number };
  cruiseAltitudeM: number;
  groundSpeedMps: number;
  /** Seconds for one complete leg; the track loops back and forth. */
  legSeconds: number;
  /** Offset into the leg at the epoch, so the aircraft are spread out. */
  phaseSeconds: number;
}

export const DEMO_TRACKS: readonly DemoTrack[] = Object.freeze([
  { icao24: 'a1b2c3', callsign: 'HAL021', registration: 'N380HA', model: 'A330-243', origin: 'PHNL', destination: 'KLAX', from: { latitude: 21.32, longitude: -157.92 }, to: { latitude: 33.94, longitude: -118.41 }, cruiseAltitudeM: 11_600, groundSpeedMps: 250, legSeconds: 5400, phaseSeconds: 0 },
  { icao24: 'c4d5e6', callsign: 'UAL149', registration: 'N77295', model: 'B777-224', origin: 'KSFO', destination: 'PHNL', from: { latitude: 37.62, longitude: -122.38 }, to: { latitude: 21.32, longitude: -157.92 }, cruiseAltitudeM: 10_700, groundSpeedMps: 240, legSeconds: 5400, phaseSeconds: 1800 },
  { icao24: 'f70809', callsign: 'HAL142', registration: 'N492HA', model: 'B717-22A', origin: 'PHNL', destination: 'PHOG', from: { latitude: 21.32, longitude: -157.92 }, to: { latitude: 20.90, longitude: -156.43 }, cruiseAltitudeM: 5_500, groundSpeedMps: 180, legSeconds: 1500, phaseSeconds: 300 },
  { icao24: '0a0b0c', callsign: 'N512WV', registration: 'N512WV', model: 'C172S', origin: 'PHNL', destination: 'PHNL', from: { latitude: 21.32, longitude: -157.92 }, to: { latitude: 21.70, longitude: -157.60 }, cruiseAltitudeM: 900, groundSpeedMps: 55, legSeconds: 900, phaseSeconds: 120 },
]);

export const DEMO_AIRCRAFT_MANIFEST: ProviderManifest = {
  id: 'readsb-local',
  name: 'Local ADS-B receiver (recorded demo)',
  version: '0.1.0',
  description: 'Deterministic synthetic aircraft tracks for demo mode. No receiver, no network; every observation is recorded data.',
  objectTypes: ['aircraft'],
  categories: ['air'],
  transport: 'filesystem',
  capabilities: { live: false, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 2_000,
    minIntervalMs: 1_000,
    timeoutMs: 5_000,
    maxRetries: 0,
    maxRequestsPerMinute: 120,
    staleWhileErrorMs: 0,
    freshness: { aircraft: { liveSeconds: 30, recentSeconds: 120, expireSeconds: 600 } },
  },
  dataPolicy: {
    cacheAllowed: false,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: false,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: false,
    attributionText: 'Synthetic demo tracks (WORLDVIEW project)',
  },
  attribution: { text: 'Synthetic demo tracks (WORLDVIEW project)', licenseId: 'MIT' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: [],
};

export class DemoAircraftProvider implements WorldProvider {
  readonly manifest: ProviderManifest = DEMO_AIRCRAFT_MANIFEST;
  private context!: ProviderContext;
  private running = false;
  private lastCount = 0;

  constructor(private readonly tracks: readonly DemoTrack[] = DEMO_TRACKS) {}

  async initialize(context: ProviderContext): Promise<void> { this.context = context; }
  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }

  async query(request: ProviderQuery): Promise<Observation[]> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled');
    const now = this.context.clock.now();
    const at = new Date(now).toISOString();
    const observations = this.tracks.map((track) => this.observationFor(track, now, at));
    this.lastCount = observations.length;
    return observations;
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: this.running ? 'LIVE' : 'STARTING',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
      objectCount: this.lastCount,
      message: 'recorded demo data',
    };
  }

  private observationFor(track: DemoTrack, nowMs: number, at: string): Observation {
    const t = progress(nowMs, track);
    const latitude = round(track.from.latitude + (track.to.latitude - track.from.latitude) * t, 5);
    const longitude = round(track.from.longitude + (track.to.longitude - track.from.longitude) * t, 5);
    const forward = legForward(nowMs, track);
    const heading = bearing(forward ? track.from : track.to, forward ? track.to : track.from);
    // Climb over the first tenth of the leg, cruise, descend over the last tenth.
    const climb = Math.min(1, t / 0.1, (1 - t) / 0.1);
    const altitudeM = Math.max(0, round(track.cruiseAltitudeM * Math.max(0, climb), 0));
    const payload: Record<string, JsonValue> = {
      icao24: track.icao24,
      callsign: track.callsign,
      registration: track.registration,
      model: track.model,
      origin: track.origin,
      destination: track.destination,
      onGround: altitudeM <= 0,
      speedMps: track.groundSpeedMps,
      headingDegrees: heading,
      recorded: true,
    };
    return {
      id: observationId(this.manifest.id, track.icao24, at),
      providerId: this.manifest.id,
      externalId: track.icao24,
      objectType: 'aircraft',
      observedAt: at,
      receivedAt: at,
      position: { latitude, longitude, altitudeM, altitudeDatum: 'msl' },
      payload,
      quality: { complete: true, sourceQuality: 'authoritative', flags: ['synthetic'] },
      provenance: {
        providerId: this.manifest.id,
        sourceName: this.manifest.name,
        origin: 'recorded',
        sourceRef: 'worldview:demo/synthetic-aircraft',
        attribution: this.manifest.attribution.text,
        receivedAt: at,
      },
    };
  }
}

/** Position along the leg in [0, 1]; the track ping-pongs between the endpoints. */
function progress(nowMs: number, track: DemoTrack): number {
  const cycle = track.legSeconds * 2;
  const s = ((Math.floor(nowMs / 1000) + track.phaseSeconds) % cycle + cycle) % cycle;
  return s < track.legSeconds ? s / track.legSeconds : (cycle - s) / track.legSeconds;
}

function legForward(nowMs: number, track: DemoTrack): boolean {
  const cycle = track.legSeconds * 2;
  const s = ((Math.floor(nowMs / 1000) + track.phaseSeconds) % cycle + cycle) % cycle;
  return s < track.legSeconds;
}

function bearing(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((to.longitude - from.longitude) * toRad) * Math.cos(to.latitude * toRad);
  const x = Math.cos(from.latitude * toRad) * Math.sin(to.latitude * toRad) - Math.sin(from.latitude * toRad) * Math.cos(to.latitude * toRad) * Math.cos((to.longitude - from.longitude) * toRad);
  return round((Math.atan2(y, x) / toRad + 360) % 360, 1);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function createDemoAircraftProvider(tracks?: readonly DemoTrack[]): DemoAircraftProvider {
  return new DemoAircraftProvider(tracks);
}
