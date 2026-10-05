import { FieldReader } from './wire.js';

/**
 * The NMEA 2000 messages this provider reads, by PGN, decoded from their bytes. Field
 * positions, sizes and resolutions are those CANboat documents (docs/canboat.json); angles
 * arrive in 1e-4 rad and are given here in degrees, speeds in m/s, temperatures in °C,
 * pressure in hPa. A field the sender marks not available is left out.
 */

const RAD = 180 / Math.PI;
const K = 273.15;

export interface PositionMessage {
  kind: 'position';
  latitude: number;
  longitude: number;
  /** 129029 only. */
  fixTime?: number;
  satellites?: number;
  hdop?: number;
  /** 129029's method: 0 no fix, 1 GNSS, 2 DGNSS, … (CANboat's GNSS_METHOD). */
  method?: number;
  precise?: boolean;
}
export interface CourseMessage {
  kind: 'course';
  courseDeg?: number;
  magnetic: boolean;
  speedMps?: number;
}
export interface HeadingMessage {
  kind: 'heading';
  headingDeg?: number;
  magnetic: boolean;
  deviationDeg?: number;
  variationDeg?: number;
}
export interface DepthMessage {
  kind: 'depth';
  /** Below the transducer. */
  depthM?: number;
  /** Positive: transducer to waterline; negative: transducer to keel. */
  offsetM?: number;
}
export interface SpeedMessage {
  kind: 'speed';
  throughWaterMps?: number;
}
export interface WindMessage {
  kind: 'wind';
  speedMps?: number;
  angleDeg?: number;
  /** 0 true (ground, north), 1 magnetic (ground, north), 2 apparent, 3 true (boat), 4 true (water). */
  reference: number;
}
export interface EnvironmentMessage {
  kind: 'environment';
  waterTemperatureC?: number;
  airTemperatureC?: number;
  pressureHpa?: number;
}
export interface AisPositionMessage {
  kind: 'ais-position';
  aisClass: 'A' | 'B';
  /** The AIS message id carried (1–3 class A, 18–19 class B). */
  messageId: number;
  mmsi: number;
  latitude?: number;
  longitude?: number;
  accuracy: boolean;
  /** The UTC second of the fix (0–59), when the sender knew it. */
  second?: number;
  courseDeg?: number;
  speedMps?: number;
  headingDeg?: number;
  navStatus?: number;
}
export interface AisStaticMessage {
  kind: 'ais-static';
  mmsi: number;
  imo?: number;
  callSign?: string;
  name?: string;
  shipType?: number;
  lengthM?: number;
  beamM?: number;
  fromStarboardM?: number;
  fromBowM?: number;
  draughtM?: number;
  destination?: string;
  /** ETA as days since 1970 and seconds since midnight UTC. */
  etaDays?: number;
  etaSeconds?: number;
}

export type N2kMessage =
  | PositionMessage
  | CourseMessage
  | HeadingMessage
  | DepthMessage
  | SpeedMessage
  | WindMessage
  | EnvironmentMessage
  | AisPositionMessage
  | AisStaticMessage;

/** The PGNs `decodePgn` reads. */
export const READ_PGNS: ReadonlySet<number> = new Set([
  127250, 128259, 128267, 129025, 129026, 129029, 129038, 129039, 129794, 129809, 129810, 130306, 130310, 130312,
  130316,
]);

const deg = (rad: number | undefined) => (rad === undefined ? undefined : rad * RAD);
const celsius = (k: number | undefined) => (k === undefined ? undefined : Math.round((k - K) * 100) / 100);
const validLat = (v: number | undefined) => (v !== undefined && Math.abs(v) <= 90 ? v : undefined);
const validLon = (v: number | undefined) => (v !== undefined && Math.abs(v) <= 180 ? v : undefined);

/** One message's fields, or undefined for a PGN not read here or one too short to hold them. */
export function decodePgn(pgn: number, bytes: Uint8Array): N2kMessage | undefined {
  const f = new FieldReader(bytes);
  switch (pgn) {
    case 129025: {
      const latitude = validLat(f.signed(0, 32, 1e-7));
      const longitude = validLon(f.signed(32, 32, 1e-7));
      return latitude !== undefined && longitude !== undefined ? { kind: 'position', latitude, longitude } : undefined;
    }
    case 129029: {
      if (f.bitLength < 264) return undefined;
      const latitude = validLat(f.signed64(56, 1e-16));
      const longitude = validLon(f.signed64(120, 1e-16));
      const method = f.unsigned(252, 4);
      if (latitude === undefined || longitude === undefined || method === 0) return undefined;
      const days = f.unsigned(8, 16);
      const seconds = f.unsigned(24, 32, 1e-4);
      const out: PositionMessage = { kind: 'position', latitude, longitude, precise: true };
      if (days !== undefined && seconds !== undefined) out.fixTime = days * 86_400_000 + Math.round(seconds * 1000);
      const sats = f.unsigned(264, 8);
      if (sats !== undefined) out.satellites = sats;
      const hdop = f.signed(272, 16, 0.01);
      if (hdop !== undefined) out.hdop = Math.round(hdop * 100) / 100;
      if (method !== undefined) out.method = method;
      return out;
    }
    case 129026: {
      const out: CourseMessage = { kind: 'course', magnetic: f.unsigned(8, 2) === 1 };
      const cog = deg(f.unsigned(16, 16, 1e-4));
      const sog = f.unsigned(32, 16, 0.01);
      if (cog !== undefined) out.courseDeg = cog;
      if (sog !== undefined) out.speedMps = sog;
      return out;
    }
    case 127250: {
      const out: HeadingMessage = { kind: 'heading', magnetic: f.unsigned(56, 2) === 1 };
      const heading = deg(f.unsigned(8, 16, 1e-4));
      const deviation = deg(f.signed(24, 16, 1e-4));
      const variation = deg(f.signed(40, 16, 1e-4));
      if (heading !== undefined) out.headingDeg = heading;
      if (deviation !== undefined) out.deviationDeg = deviation;
      if (variation !== undefined) out.variationDeg = variation;
      return out;
    }
    case 128267: {
      const out: DepthMessage = { kind: 'depth' };
      const depth = f.unsigned(8, 32, 0.01);
      const offset = f.signed(40, 16, 0.001);
      if (depth !== undefined) out.depthM = Math.round(depth * 100) / 100;
      if (offset !== undefined) out.offsetM = Math.round(offset * 1000) / 1000;
      return out;
    }
    case 128259: {
      const stw = f.unsigned(8, 16, 0.01);
      return stw === undefined ? { kind: 'speed' } : { kind: 'speed', throughWaterMps: Math.round(stw * 100) / 100 };
    }
    case 130306: {
      const reference = f.unsigned(40, 3);
      if (reference === undefined) return undefined;
      const out: WindMessage = { kind: 'wind', reference };
      const speed = f.unsigned(8, 16, 0.01);
      const angle = deg(f.unsigned(24, 16, 1e-4));
      if (speed !== undefined) out.speedMps = Math.round(speed * 100) / 100;
      if (angle !== undefined) out.angleDeg = angle;
      return out;
    }
    case 130310: {
      const out: EnvironmentMessage = { kind: 'environment' };
      const water = celsius(f.unsigned(8, 16, 0.01));
      const air = celsius(f.unsigned(24, 16, 0.01));
      const pressure = f.unsigned(40, 16, 100);
      if (water !== undefined) out.waterTemperatureC = water;
      if (air !== undefined) out.airTemperatureC = air;
      if (pressure !== undefined) out.pressureHpa = pressure / 100;
      return out;
    }
    case 130312:
    case 130316: {
      // Source 0 is the sea, 1 the outside air (CANboat's TEMPERATURE_SOURCE); others are a
      // cabin, an engine room, a fridge… and are not the vessel's surroundings.
      const source = f.unsigned(16, 8);
      const kelvin = pgn === 130312 ? f.unsigned(24, 16, 0.01) : f.unsigned(24, 24, 0.001);
      const c = celsius(kelvin);
      if (c === undefined || (source !== 0 && source !== 1)) return undefined;
      return source === 0 ? { kind: 'environment', waterTemperatureC: c } : { kind: 'environment', airTemperatureC: c };
    }
    case 129038:
    case 129039: {
      const mmsi = f.unsigned(8, 32);
      if (mmsi === undefined) return undefined;
      const classA = pgn === 129038;
      const out: AisPositionMessage = {
        kind: 'ais-position',
        aisClass: classA ? 'A' : 'B',
        messageId: f.unsigned(0, 6) ?? (classA ? 1 : 18),
        mmsi,
        accuracy: f.raw(104, 1) === 1,
      };
      const lon = validLon(f.signed(40, 32, 1e-7));
      const lat = validLat(f.signed(72, 32, 1e-7));
      if (lat !== undefined && lon !== undefined) {
        out.latitude = lat;
        out.longitude = lon;
      }
      const second = f.raw(106, 6);
      if (second !== undefined && second < 60) out.second = second;
      const cog = deg(f.unsigned(112, 16, 1e-4));
      const sog = f.unsigned(128, 16, 0.01);
      const heading = deg(f.unsigned(168, 16, 1e-4));
      if (cog !== undefined) out.courseDeg = cog;
      if (sog !== undefined) out.speedMps = sog;
      if (heading !== undefined) out.headingDeg = heading;
      if (classA) {
        const nav = f.raw(200, 4);
        // 15 ("not defined", and an AIS-SART's test transmissions) is kept: see vessels.ts.
        if (nav !== undefined) out.navStatus = nav;
      }
      return out;
    }
    case 129794: {
      const mmsi = f.unsigned(8, 32);
      if (mmsi === undefined) return undefined;
      const out: AisStaticMessage = { kind: 'ais-static', mmsi };
      setIf(out, 'imo', positive(f.unsigned(40, 32)));
      setIf(out, 'callSign', f.text(72, 7));
      setIf(out, 'name', f.text(128, 20));
      setIf(out, 'shipType', positive(f.unsigned(288, 8)));
      setIf(out, 'lengthM', f.unsigned(296, 16, 0.1));
      setIf(out, 'beamM', f.unsigned(312, 16, 0.1));
      setIf(out, 'fromStarboardM', f.unsigned(328, 16, 0.1));
      setIf(out, 'fromBowM', f.unsigned(344, 16, 0.1));
      setIf(out, 'etaDays', f.unsigned(360, 16));
      setIf(out, 'etaSeconds', f.unsigned(376, 32, 1e-4));
      setIf(out, 'draughtM', f.unsigned(408, 16, 0.01));
      setIf(out, 'destination', f.text(424, 20));
      return out;
    }
    case 129809: {
      const mmsi = f.unsigned(8, 32);
      if (mmsi === undefined) return undefined;
      const out: AisStaticMessage = { kind: 'ais-static', mmsi };
      setIf(out, 'name', f.text(40, 20));
      return out;
    }
    case 129810: {
      const mmsi = f.unsigned(8, 32);
      if (mmsi === undefined) return undefined;
      const out: AisStaticMessage = { kind: 'ais-static', mmsi };
      setIf(out, 'shipType', positive(f.unsigned(40, 8)));
      setIf(out, 'callSign', f.text(104, 7));
      setIf(out, 'lengthM', f.unsigned(160, 16, 0.1));
      setIf(out, 'beamM', f.unsigned(176, 16, 0.1));
      setIf(out, 'fromStarboardM', f.unsigned(192, 16, 0.1));
      setIf(out, 'fromBowM', f.unsigned(208, 16, 0.1));
      return out;
    }
    default:
      return undefined;
  }
}

function positive(v: number | undefined): number | undefined {
  return v !== undefined && v > 0 ? v : undefined;
}

function setIf<T extends object, K extends keyof T>(o: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) o[key] = value;
}
