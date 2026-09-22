import type { JsonValue, Provenance, WorldEvent, WorldObject, SeverityClass } from '@worldview/world-model';
import {
  classifyFreshness,
  computeConfidence,
  freshnessPolicyFor,
  makeEventId,
  makeObjectId,
} from '@worldview/world-model';
import { USGS_NORMAL_FIXTURE } from './fixtures/usgs-normal.js';

/**
 * Deterministic demo world. Everything here is RECORDED DATA: provenance.origin is
 * 'recorded', objects carry a `recorded: true` property, and the demo client labels every
 * feed item. Earthquakes come from the synthetic USGS contract fixture (property names
 * mirror providers/usgs/src/normalize.ts); aircraft, vessels, the satellite, the fire
 * detection, the weather alert and the camera are synthetic and move as pure functions
 * of elapsed time so replays and tests are reproducible.
 */
export const FIXTURE_REFERENCE_MS = Date.parse('2026-09-21T08:00:00.000Z');

export const DEMO_PROVIDERS = {
  usgs: {
    id: 'usgs-earthquakes',
    name: 'USGS Earthquake Hazards Program',
    attribution: 'U.S. Geological Survey (public domain)',
  },
  aircraft: {
    id: 'readsb-local',
    name: 'Local ADS-B receiver (readsb)',
    attribution: 'Locally received ADS-B (recorded demo track)',
  },
  ais: { id: 'aisstream', name: 'AISStream', attribution: 'AIS data via aisstream.io (recorded demo track)' },
  celestrak: { id: 'celestrak', name: 'CelesTrak', attribution: 'Orbital elements courtesy of CelesTrak' },
  firms: { id: 'nasa-firms', name: 'NASA FIRMS', attribution: 'NASA FIRMS active fire data (recorded sample)' },
  nws: { id: 'nws-alerts', name: 'NWS Alerts', attribution: 'National Weather Service (public domain)' },
  cameras: { id: 'cctv-public', name: 'Public cameras', attribution: 'Recorded demo camera (synthetic frame)' },
} as const;

function provenance(
  p: { id: string; name: string; attribution: string },
  receivedAt: string,
  sourceRef: string,
): Provenance {
  return {
    providerId: p.id,
    sourceName: p.name,
    origin: 'recorded',
    sourceRef,
    attribution: p.attribution,
    receivedAt,
  };
}

function baseObject(
  id: string,
  type: string,
  providerId: string,
  observedAt: string,
  nowMs: number,
  prov: Provenance,
  position: WorldObject['position'],
  labels: Record<string, string>,
  properties: Record<string, JsonValue>,
  authoritative = true,
): WorldObject {
  const freshness = classifyFreshness(Date.parse(observedAt), nowMs, freshnessPolicyFor(type));
  const obj: WorldObject = {
    id,
    type,
    sourceRefs: [{ observationId: `${providerId}:${id}:${observedAt}`, providerId, observedAt }],
    observedAt,
    updatedAt: observedAt,
    freshness,
    confidence: computeConfidence({
      sourceQuality: 'authoritative',
      freshness,
      providerCount: 1,
      identityAuthoritative: authoritative,
    }),
    labels,
    properties: { ...properties, recorded: true },
    provenance: prov,
  };
  if (position) obj.position = position;
  return obj;
}

// ---- earthquakes from the USGS fixture ------------------------------------------------------

export function buildEarthquakes(nowMs: number): { objects: WorldObject[]; events: WorldEvent[] } {
  // Shift fixture times so the newest event is ~10 minutes before "now" — the data stays
  // recorded (provenance says so) but freshness classes are meaningful in the demo.
  const shift = nowMs - 10 * 60_000 - Math.max(...USGS_NORMAL_FIXTURE.features.map((f) => f.properties.time));
  const objects: WorldObject[] = [];
  const events: WorldEvent[] = [];
  for (const f of USGS_NORMAL_FIXTURE.features) {
    const p = f.properties;
    const [lon, lat, depthKm] = f.geometry.coordinates;
    const observedAt = new Date(p.time + shift).toISOString();
    const receivedAt = new Date(p.updated + shift).toISOString();
    const id = makeObjectId('earthquake', 'usgs', f.id);
    const props: Record<string, JsonValue> = {
      magnitude: p.mag,
      magType: p.magType,
      depthKm,
      place: p.place,
      title: p.title,
      status: p.status,
      eventType: p.type,
      tsunami: p.tsunami === 1,
      significance: p.sig,
      network: p.net,
      detailUrl: p.url,
      aliases: p.ids.split(',').filter(Boolean),
      updatedAt: receivedAt,
    };
    if (p.alert) props['alert'] = p.alert;
    if (p.felt !== null && p.felt !== undefined) props['felt'] = p.felt;
    if (p.nst !== null && p.nst !== undefined) props['stations'] = p.nst;
    const prov = provenance(DEMO_PROVIDERS.usgs, receivedAt, 'fixtures/usgs/normal.geojson');
    objects.push(
      baseObject(
        id,
        'earthquake',
        DEMO_PROVIDERS.usgs.id,
        observedAt,
        nowMs,
        prov,
        { latitude: lat, longitude: lon, altitudeM: -depthKm * 1000, altitudeDatum: 'msl' },
        { place: p.place, title: p.title },
        props,
      ),
    );
    const severity: SeverityClass =
      p.mag >= 7 ? 'EXTREME' : p.mag >= 6 ? 'SEVERE' : p.mag >= 5 ? 'MODERATE' : p.mag >= 4 ? 'MINOR' : 'INFO';
    events.push({
      id: makeEventId('earthquake', 'usgs', f.id),
      type: 'earthquake',
      title: p.title,
      startAt: observedAt,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      objectIds: [id],
      observationRefs: [
        {
          observationId: `${DEMO_PROVIDERS.usgs.id}:${id}:${observedAt}`,
          providerId: DEMO_PROVIDERS.usgs.id,
          observedAt,
        },
      ],
      confidence: 'HIGH',
      severity,
      summary: `M ${p.mag.toFixed(1)} ${p.magType} earthquake, ${depthKm} km deep, ${p.place}.`,
      properties: { magnitude: p.mag, depthKm, recorded: true },
      provenance: prov,
    });
  }
  return { objects, events };
}

// ---- synthetic movers -------------------------------------------------------------------------

interface Route {
  hex: string;
  callsign: string;
  registration: string;
  type: string;
  squawk: string;
  lat: number;
  lon: number;
  heading: number;
  speedMps: number;
  altitudeM: number;
  onGround?: boolean;
}

const AIRCRAFT_ROUTES: Route[] = [
  {
    hex: 'a1b2c3',
    callsign: 'HAL212',
    registration: 'N212HA',
    type: 'A21N',
    squawk: '3421',
    lat: 21.32,
    lon: -157.92,
    heading: 250,
    speedMps: 118,
    altitudeM: 1200,
  },
  {
    hex: 'a4f0e1',
    callsign: 'UAL1541',
    registration: 'N24974',
    type: 'B739',
    squawk: '2211',
    lat: 22.1,
    lon: -156.4,
    heading: 65,
    speedMps: 236,
    altitudeM: 10_668,
  },
  {
    hex: 'abc123',
    callsign: 'DAL1',
    registration: 'N201DN',
    type: 'A359',
    squawk: '5104',
    lat: 24.0,
    lon: -159.8,
    heading: 90,
    speedMps: 248,
    altitudeM: 11_887,
  },
  {
    hex: 'a9d8c7',
    callsign: 'FDX9034',
    registration: 'N850FD',
    type: 'B77L',
    squawk: '4102',
    lat: 20.4,
    lon: -155.1,
    heading: 310,
    speedMps: 240,
    altitudeM: 10_058,
  },
  {
    hex: '4ca7b2',
    callsign: 'RYR8AK',
    registration: 'EI-DYX',
    type: 'B738',
    squawk: '7622',
    lat: 51.9,
    lon: -0.2,
    heading: 180,
    speedMps: 210,
    altitudeM: 9144,
  },
  {
    hex: '3c6444',
    callsign: 'DLH2AY',
    registration: 'D-AIZH',
    type: 'A320',
    squawk: '1000',
    lat: 50.05,
    lon: 8.6,
    heading: 20,
    speedMps: 90,
    altitudeM: 900,
  },
  {
    hex: '406a3b',
    callsign: 'BAW117',
    registration: 'G-STBH',
    type: 'B77W',
    squawk: '2352',
    lat: 52.2,
    lon: -5.0,
    heading: 275,
    speedMps: 255,
    altitudeM: 11_277,
  },
  {
    hex: 'ac82ec',
    callsign: 'SWA318',
    registration: 'N8309C',
    type: 'B738',
    squawk: '6521',
    lat: 33.94,
    lon: -118.4,
    heading: 0,
    speedMps: 4,
    altitudeM: 40,
    onGround: true,
  },
  {
    hex: 'a6c9f5',
    callsign: 'AAL2451',
    registration: 'N912NN',
    type: 'B738',
    squawk: '3155',
    lat: 35.2,
    lon: -115.5,
    heading: 120,
    speedMps: 232,
    altitudeM: 10_972,
  },
  {
    hex: '7c6b1a',
    callsign: 'QFA12',
    registration: 'VH-OQJ',
    type: 'A388',
    squawk: '3014',
    lat: 30.5,
    lon: -140.0,
    heading: 235,
    speedMps: 262,
    altitudeM: 12_192,
  },
  {
    hex: '86d5a1',
    callsign: 'JAL784',
    registration: 'JA841J',
    type: 'B788',
    squawk: '2201',
    lat: 26.5,
    lon: -166.0,
    heading: 300,
    speedMps: 258,
    altitudeM: 11_582,
  },
  {
    hex: 'c0172b',
    callsign: 'ACA33',
    registration: 'C-FIUV',
    type: 'B77W',
    squawk: '5541',
    lat: 28.0,
    lon: -150.0,
    heading: 235,
    speedMps: 250,
    altitudeM: 12_497,
  },
];

/** Position after `elapsedMs` along a constant heading (small-angle approximation, adequate for demo scale). */
export function advance(
  lat: number,
  lon: number,
  headingDeg: number,
  speedMps: number,
  elapsedMs: number,
): { latitude: number; longitude: number } {
  const d = (speedMps * elapsedMs) / 1000;
  const rad = (headingDeg * Math.PI) / 180;
  const dLat = (d * Math.cos(rad)) / 111_320;
  const dLon = (d * Math.sin(rad)) / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  let latitude = lat + dLat;
  let longitude = lon + dLon;
  if (latitude > 85) latitude = 85;
  if (latitude < -85) latitude = -85;
  longitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return { latitude, longitude };
}

export function buildAircraft(nowMs: number, startMs: number): WorldObject[] {
  const elapsed = Math.max(0, nowMs - startMs);
  const observedAt = new Date(nowMs - 2000).toISOString();
  return AIRCRAFT_ROUTES.map((r) => {
    const moved = r.onGround
      ? { latitude: r.lat, longitude: r.lon }
      : advance(r.lat, r.lon, r.heading, r.speedMps, elapsed);
    const id = makeObjectId('aircraft', 'icao24', r.hex);
    const obj = baseObject(
      id,
      'aircraft',
      DEMO_PROVIDERS.aircraft.id,
      observedAt,
      nowMs,
      provenance(DEMO_PROVIDERS.aircraft, observedAt, 'demo://adsb/recorded-track'),
      {
        latitude: moved.latitude,
        longitude: moved.longitude,
        altitudeM: r.altitudeM,
        altitudeDatum: 'barometric',
        accuracyM: 30,
      },
      { callsign: r.callsign, registration: r.registration },
      {
        icao24: r.hex,
        callsign: r.callsign,
        registration: r.registration,
        aircraftType: r.type,
        squawk: r.squawk,
        onGround: r.onGround ?? false,
        baroAltitudeM: r.altitudeM,
        speedMps: r.speedMps,
        headingDegrees: r.heading,
        originCountry: r.hex.startsWith('a')
          ? 'United States'
          : r.hex.startsWith('4')
            ? 'Ireland'
            : r.hex.startsWith('3')
              ? 'Germany'
              : r.hex.startsWith('7')
                ? 'Australia'
                : r.hex.startsWith('8')
                  ? 'Japan'
                  : 'Canada',
      },
    );
    obj.motion = {
      speedMps: r.speedMps,
      headingDegrees: r.heading,
      verticalSpeedMps: r.onGround ? 0 : r.altitudeM > 11_000 ? 0 : 2.5,
    };
    return obj;
  });
}

const VESSELS = [
  {
    mmsi: '338123456',
    name: 'PRIDE OF AMERICA',
    imo: '9209221',
    shipType: 'Passenger',
    navStatus: 'Under way using engine',
    destination: 'KAHULUI',
    lat: 21.25,
    lon: -157.85,
    course: 120,
    speedMps: 8.7,
    lengthM: 280,
    beamM: 32,
    draughtM: 8.1,
  },
  {
    mmsi: '311000123',
    name: 'MATSON KAIMANA',
    imo: '9741205',
    shipType: 'Container ship',
    navStatus: 'Under way using engine',
    destination: 'HONOLULU',
    lat: 22.6,
    lon: -154.9,
    course: 255,
    speedMps: 10.3,
    lengthM: 260,
    beamM: 32,
    draughtM: 11.5,
  },
];

export function buildVessels(nowMs: number, startMs: number): WorldObject[] {
  const elapsed = Math.max(0, nowMs - startMs);
  const observedAt = new Date(nowMs - 45_000).toISOString();
  return VESSELS.map((v) => {
    const moved = advance(v.lat, v.lon, v.course, v.speedMps, elapsed);
    const id = makeObjectId('vessel', 'mmsi', v.mmsi);
    const obj = baseObject(
      id,
      'vessel',
      DEMO_PROVIDERS.ais.id,
      observedAt,
      nowMs,
      provenance(DEMO_PROVIDERS.ais, observedAt, 'demo://ais/recorded-track'),
      { latitude: moved.latitude, longitude: moved.longitude, altitudeDatum: 'sea-surface' },
      { name: v.name },
      {
        mmsi: v.mmsi,
        name: v.name,
        imo: v.imo,
        shipType: v.shipType,
        navStatus: v.navStatus,
        destination: v.destination,
        lengthM: v.lengthM,
        beamM: v.beamM,
        draughtM: v.draughtM,
        speedMps: v.speedMps,
        courseDegrees: v.course,
      },
    );
    obj.motion = { speedMps: v.speedMps, headingDegrees: v.course };
    return obj;
  });
}

export function buildSatellite(nowMs: number, startMs: number): WorldObject {
  // ISS-like ground track: 92.9 min period, 51.6° inclination, ~7.66 km/s ground speed equivalent.
  const elapsed = Math.max(0, nowMs - startMs);
  const t = (((FIXTURE_REFERENCE_MS % (92.9 * 60_000)) + elapsed) / (92.9 * 60_000)) * 2 * Math.PI;
  const latitude = 51.6 * Math.sin(t);
  const longitude = ((((-160 + (elapsed / 60_000) * 3.9 - (t * 180) / Math.PI) % 360) + 540) % 360) - 180;
  const observedAt = new Date(nowMs - 1000).toISOString();
  const id = makeObjectId('satellite', 'norad', '25544');
  const obj = baseObject(
    id,
    'satellite',
    DEMO_PROVIDERS.celestrak.id,
    observedAt,
    nowMs,
    provenance(DEMO_PROVIDERS.celestrak, observedAt, 'demo://celestrak/recorded-tle'),
    { latitude, longitude, altitudeM: 418_000, altitudeDatum: 'orbit' },
    { name: 'ISS (ZARYA)' },
    {
      noradId: '25544',
      intlDesignator: '1998-067A',
      epoch: new Date(startMs - 6 * 3600_000).toISOString(),
      periodMinutes: 92.9,
      inclinationDeg: 51.64,
      group: 'stations',
    },
  );
  obj.motion = { speedMps: 7660, headingDegrees: Math.cos(t) >= 0 ? 45 : 135 };
  return obj;
}

export function buildFireDetection(nowMs: number): WorldObject {
  const observedAt = new Date(nowMs - 2.5 * 3600_000).toISOString();
  return baseObject(
    makeObjectId('fire-detection', 'firms', 'viirs-noaa20-20260921-0530-3412'),
    'fire-detection',
    DEMO_PROVIDERS.firms.id,
    observedAt,
    nowMs,
    provenance(DEMO_PROVIDERS.firms, observedAt, 'demo://firms/recorded-sample'),
    { latitude: 34.21, longitude: -118.62, accuracyM: 375 },
    { name: 'VIIRS detection' },
    {
      brightnessK: 341.2,
      frpMw: 18.4,
      confidenceClass: 'nominal',
      satellite: 'NOAA-20',
      instrument: 'VIIRS',
      dayNight: 'N',
      acquiredAt: observedAt,
    },
  );
}

export function buildWeatherAlert(nowMs: number): WorldObject {
  const observedAt = new Date(nowMs - 40 * 60_000).toISOString();
  const expires = new Date(nowMs + 5 * 3600_000).toISOString();
  const obj = baseObject(
    makeObjectId('weather-alert', 'nws', 'urn-oid-2-49-0-1-840-0-demo-hawaii-hsw'),
    'weather-alert',
    DEMO_PROVIDERS.nws.id,
    observedAt,
    nowMs,
    provenance(DEMO_PROVIDERS.nws, observedAt, 'demo://nws/recorded-alert'),
    { latitude: 21.0, longitude: -157.3 },
    { title: 'High Surf Warning' },
    {
      event: 'High Surf Warning',
      headline: 'High Surf Warning in effect until this evening',
      areaDesc: 'Oahu North Facing Shores; Molokai North; Maui Windward West',
      severity: 'MODERATE',
      urgency: 'Expected',
      certainty: 'Likely',
      senderName: 'NWS Honolulu HI',
      effective: observedAt,
      expires,
      instruction: 'Stay away from shoreline rocks and ledges. Beachgoers should heed lifeguard warnings.',
      description: 'Surf of 18 to 24 feet along north facing shores.',
    },
  );
  obj.geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [-158.3, 21.7],
        [-156.0, 21.3],
        [-156.1, 20.8],
        [-158.2, 21.3],
        [-158.3, 21.7],
      ],
    ],
  };
  return obj;
}

export function buildCamera(nowMs: number): WorldObject {
  const observedAt = new Date(nowMs - 90_000).toISOString();
  const obj = baseObject(
    makeObjectId('camera', 'cctv-public', 'demo-hnl-h1-01'),
    'camera',
    DEMO_PROVIDERS.cameras.id,
    observedAt,
    nowMs,
    provenance(DEMO_PROVIDERS.cameras, observedAt, 'demo://cameras/synthetic-frame'),
    { latitude: 21.33, longitude: -157.9 },
    { name: 'H-1 Freeway — Kalihi (demo)' },
    {
      cameraId: 'demo-hnl-h1-01',
      operator: 'Recorded demo',
      direction: 'Facing east',
      gateway: 'direct',
      headingDegrees: 90,
    },
    false,
  );
  obj.media = [{ kind: 'snapshot', ref: 'demo-hnl-h1-01', label: 'Snapshot (synthetic)', mimeType: 'image/svg+xml' }];
  return obj;
}

/** SVG snapshot bytes for the demo camera — an obviously synthetic frame carrying the RECORDED DATA label. */
export function demoSnapshotSvg(capturedAt: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#0b0f14"/><path d="M0 250 L640 250 L640 360 L0 360 Z" fill="#161d28"/><path d="M0 250 L640 250" stroke="#33425a" stroke-width="2"/><path d="M40 250 L300 120 L340 120 L600 250" fill="none" stroke="#243040" stroke-width="3"/><text x="20" y="34" fill="#a3b3c4" font-family="Inter, system-ui, sans-serif" font-size="18">DEMO CAMERA — SYNTHETIC FRAME</text><text x="20" y="60" fill="#d6b64a" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="600">RECORDED DATA</text><text x="20" y="340" fill="#7f8d9e" font-family="monospace" font-size="13">${capturedAt}</text></svg>`;
}
