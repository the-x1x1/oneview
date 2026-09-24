import type { TelemetrySeries } from '@worldview/provider-sdk';

/**
 * The payload keys the rest of the app already names (`docs/architecture/EVENT-RULES.md`, the
 * local weather-station and air-quality providers): a name, display units and a format for
 * each, so a reading found on an object is labelled even when nothing described it. Values
 * stay SI; nothing here converts.
 */
export const KNOWN_READINGS: Readonly<Record<string, Omit<TelemetrySeries, 'key'>>> = {
  temperatureC: { name: 'Temperature', units: '°C', format: 'celsius' },
  dewPointC: { name: 'Dew point', units: '°C', format: 'celsius' },
  heatIndexC: { name: 'Heat index', units: '°C', format: 'celsius' },
  windChillC: { name: 'Wind chill', units: '°C', format: 'celsius' },
  humidityPct: { name: 'Humidity', units: '%', format: 'percent', min: 0, max: 100 },
  pressureHpa: { name: 'Pressure', units: 'hPa', format: 'hpa' },
  pressureSeaLevelHpa: { name: 'Pressure (sea level)', units: 'hPa', format: 'hpa' },
  windSpeedMps: { name: 'Wind', units: 'm/s', format: 'mps' },
  windGustMps: { name: 'Gusts', units: 'm/s', format: 'mps' },
  windDirDeg: { name: 'Wind direction', units: '°', format: 'degrees', min: 0, max: 360 },
  rainRateMmH: { name: 'Rain rate', units: 'mm/h', format: 'number:1' },
  rainTodayMm: { name: 'Rain today', units: 'mm', format: 'number:1' },
  rain24hMm: { name: 'Rain (24 h)', units: 'mm', format: 'number:1' },
  solarRadiationWm2: { name: 'Solar radiation', units: 'W/m²', format: 'number:0' },
  uvIndex: { name: 'UV index', format: 'number:1' },
  pm25Ugm3: { name: 'PM2.5', units: 'µg/m³', format: 'ugm3' },
  pm10Ugm3: { name: 'PM10', units: 'µg/m³', format: 'ugm3' },
  pm1Ugm3: { name: 'PM1', units: 'µg/m³', format: 'ugm3' },
  // The AQI's category edges are part of its definition: above 100 is "unhealthy for
  // sensitive groups", above 150 "unhealthy".
  aqiUs: { name: 'AQI (US EPA)', format: 'number:0', limits: { warnHigh: 100, critHigh: 150 } },
  co2Ppm: { name: 'CO₂', units: 'ppm', format: 'ppm' },
  batteryV: { name: 'Battery', units: 'V', format: 'volts' },
  batteryPct: { name: 'Battery', units: '%', format: 'percent', min: 0, max: 100 },
  rssiDbm: { name: 'Signal', units: 'dBm', format: 'dbm' },
};

/**
 * A per-object-type default: which readings a type shows when its source describes none.
 * Each entry lists alternative keys, the first one the object carries wins (a station
 * reports sea-level pressure or station pressure, not both).
 */
export const DEFAULT_READINGS: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
  'weather-station': [
    ['temperatureC'],
    ['humidityPct'],
    ['pressureSeaLevelHpa', 'pressureHpa'],
    ['windSpeedMps'],
    ['windGustMps'],
  ],
};

/**
 * Types whose numeric payload keys are all readings when nothing names them: a sensor is
 * a thing that reports values, so every number it carries is one. A weather station whose
 * default keys are all missing (a rain gauge) falls back to the same.
 */
export const DISCOVERED_TYPES: ReadonlySet<string> = new Set(['sensor', 'weather-station']);
