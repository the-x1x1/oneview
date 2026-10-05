import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandLatitudes,
  formatUps,
  fromUps,
  toUps,
  formatMgrs,
  formatUtm,
  fromUtm,
  latitudeBand,
  parseMgrs,
  parseUtm,
  toMgrs,
  toUtm,
  utmZone,
} from './grid-reference.js';

/*
 * The expected values below were produced by GeographicLib's GeoConvert (C. F. F. Karney's
 * reference implementation of UTM and MGRS, github.com/geographiclib/geographiclib at
 * 48959df), built and run outside this repository: `GeoConvert -u -p 6`, `-m -p 0` and
 * `-g -p 9`. No GeographicLib code is included here. Beyond these vectors the module was
 * compared with GeoConvert on 20,000 random points (UTM within 0.5 µm, MGRS identical at every
 * precision from 100 km to 1 m) and on all 576,000 combinations of zone, band and square
 * letters (the same references read and refused, positions within 1e-8 m); in the polar caps,
 * on 20,049 points (UPS within 0.5 µm, MGRS identical at every precision) and all 2,304 polar
 * band and letter pairs (the same read and refused).
 */

const UTM_VECTORS: Array<[number, number, string, number, number]> = [
  // latitude, longitude → zone+hemisphere, easting, northing
  [21.307, -157.85831, '4N', 618415.972723, 2356553.519206],
  [-33.8688, 151.2093, '56S', 334368.633648, 6250948.345385],
  [48.8582, 2.2945, '31N', 448251.795206, 5411932.67767],
  [60.0, 5.0, '32N', 276979.926401, 6658157.202407], // Norway's 32V
  [78.0, 15.0, '33N', 500000.0, 8658369.585827], // Svalbard's 33X
  [-79.9, -0.5, '30S', 548929.285088, 1128524.571853],
  [83.9, -40.0, '24N', 488136.730751, 9317033.09712],
  [0.0, -0.000001, '30N', 833978.445491, 0.0],
  [-0.000001, 179.999999, '60S', 833978.445491, 9999999.889317],
  [-17.8, 178.6, '60S', 669588.153757, 8031217.464542],
  [-54.8, -68.3, '19S', 545000.053364, 3927239.3813],
  [40.7128, -74.006, '18N', 583959.372324, 4507350.998243],
];

const MGRS_VECTORS: Array<[number, number, string]> = [
  [21.307, -157.85831, '4Q FJ 18415 56553'],
  [-33.8688, 151.2093, '56H LH 34368 50948'],
  [48.8582, 2.2945, '31U DQ 48251 11932'],
  [60.0, 5.0, '32V KM 76979 58157'],
  [78.0, 15.0, '33X WG 00000 58369'],
  [-79.9, -0.5, '30C WS 48929 28524'],
  [83.9, -40.0, '24X VU 88136 17033'],
  [0.0, -0.000001, '30N ZF 33978 00000'],
  [-0.000001, 179.999999, '60M ZE 33978 99999'],
  [51.4778, -0.0015, '30U YC 08213 07224'],
  [-17.8, 178.6, '60K XF 69588 31217'],
  [64.0, -21.9, '27W VL 55980 97324'],
  [-54.8, -68.3, '19F EV 45000 27239'],
  [35.6762, 139.6503, '54S UE 77855 48874'],
  [40.7128, -74.006, '18T WL 83959 07350'],
];

test('UTM: zone, hemisphere, easting and northing as GeographicLib gives them, to a micrometre', () => {
  for (const [lat, lon, zh, e, n] of UTM_VECTORS) {
    const u = toUtm({ latitude: lat, longitude: lon })!;
    assert.equal(`${u.zone}${u.hemisphere}`, zh, `${lat},${lon}`);
    assert.ok(Math.abs(u.easting - e) < 1e-6, `${lat},${lon} easting ${u.easting} vs ${e}`);
    assert.ok(Math.abs(u.northing - n) < 1e-6, `${lat},${lon} northing ${u.northing} vs ${n}`);
  }
});

test('UTM back to latitude and longitude, to 1e-9 degrees', () => {
  const back: Array<[number, 'N' | 'S', number, number, number, number]> = [
    [4, 'N', 612345, 2358765, 21.32736478999274, -157.9166876850831],
    [56, 'S', 334368, 6250948, -33.8688030140165, 151.20929308730217],
    [18, 'N', 585628, 4511322, 40.74839601188732, -73.98570490632133],
    [33, 'S', 300000, 3800000, -55.90380878182524, 11.80054100786938],
  ];
  for (const [zone, h, e, n, lat, lon] of back) {
    const p = fromUtm(zone, h, e, n)!;
    assert.ok(Math.abs(p.latitude - lat) < 1e-9 && Math.abs(p.longitude - lon) < 1e-9, `${zone}${h} ${e} ${n}`);
  }
  // Round trip anywhere in range, including a zone's far edge.
  for (const [lat, lon] of [
    [72.5, 41.9],
    [-79.99, 179.99],
    [10, -0.0001],
  ] as const) {
    const u = toUtm({ latitude: lat, longitude: lon })!;
    const p = fromUtm(u.zone, u.hemisphere, u.easting, u.northing)!;
    assert.ok(Math.abs(p.latitude - lat) < 1e-10 && Math.abs(p.longitude - lon) < 1e-10);
  }
  assert.equal(fromUtm(0, 'N', 500000, 0), undefined);
  assert.equal(fromUtm(61, 'N', 500000, 0), undefined);
});

test('zones and bands: the standard rules, Norway and Svalbard, nothing past 80° S or 84° N', () => {
  assert.equal(utmZone(0, -180), 1);
  assert.equal(utmZone(0, 180), 60);
  assert.equal(utmZone(0, 179.9999), 60);
  assert.equal(utmZone(60, 4), 32, '32V covers 3°–12° E');
  assert.equal(utmZone(60, 2.9), 31);
  assert.equal(utmZone(55.9, 4), 31);
  assert.equal(utmZone(78, 8.9), 31);
  assert.equal(utmZone(78, 9), 33);
  assert.equal(utmZone(78, 21), 35);
  assert.equal(utmZone(78, 33), 37);
  assert.equal(utmZone(78, 42), 38);
  assert.equal(latitudeBand(-80), 'C');
  assert.equal(latitudeBand(-0.0001), 'M');
  assert.equal(latitudeBand(0), 'N');
  assert.equal(latitudeBand(72), 'X');
  assert.equal(latitudeBand(83.999), 'X');
  assert.equal(latitudeBand(84), undefined);
  assert.equal(latitudeBand(-80.001), undefined);
  assert.deepEqual(bandLatitudes('X'), { south: 72, north: 84 });
  assert.deepEqual(bandLatitudes('q'), { south: 16, north: 24 });
  assert.equal(bandLatitudes('I'), undefined);
  assert.equal(toUtm({ latitude: 84, longitude: 0 }), undefined, 'UTM stops at 84° N: the polar grid (UPS) takes over');
  assert.equal(toUtm({ latitude: -80.001, longitude: 0 }), undefined);
});

test('MGRS: the same references as GeographicLib, truncated, at every precision', () => {
  for (const [lat, lon, ref] of MGRS_VECTORS) assert.equal(formatMgrs(toMgrs({ latitude: lat, longitude: lon })!), ref);
  const p = { latitude: 21.307, longitude: -157.85831 };
  assert.equal(formatMgrs(toMgrs(p, 4)!), '4Q FJ 1841 5655');
  assert.equal(formatMgrs(toMgrs(p, 1)!), '4Q FJ 1 5');
  assert.equal(formatMgrs(toMgrs(p, 0)!), '4Q FJ');
  assert.equal(toMgrs(p, 6), undefined);
  assert.equal(formatUtm(toUtm(p)!), '4Q 618415mE 2356553mN');
});

test('reading MGRS: the middle of the square, any spacing or case; squares that cannot be in the band refused', () => {
  const read: Array<[string, number, number, number]> = [
    ['4QFJ1234567890', 21.40980115781444, -157.91607631748587, 1],
    ['4Q FJ 1234 5678', 21.30947809186552, -157.91681890577107, 10],
    ['4qfj123456', 21.20888696901305, -157.91750614363204, 100],
    ['4QFJ 12 34', 21.10815020536745, -157.91679417431553, 1000],
    ['4QFJ12', 21.02217280801696, -157.8933612914897, 10_000],
    ['4QFJ', 21.24546415770297, -157.55444146929807, 100_000],
    ['31UDQ4825111932', 48.8581983772081, 2.29449599814152, 1],
    ['56H LH 34368 50948', -33.86879858520177, 151.20929858481273, 1],
    ['33XWG0000058369', 77.99999923093944, 15.00002154260938, 1],
    ['32VKM7697958157', 60.00000243435176, 4.99999205166375, 1],
    ['1CEA0000005490', -72.04999912134166, -176.99998546420738, 1],
    ['01DEA0000016644', -71.95000056300523, -176.99998554202725, 1],
    ['60MXE9999999999', -0.00000452141701, 178.79704832120274, 1],
  ];
  for (const [text, lat, lon, precisionM] of read) {
    const r = parseMgrs(text);
    assert.ok(r && !('error' in r), text);
    assert.ok(
      Math.abs(r.latitude - lat) < 1e-9 && Math.abs(r.longitude - lon) < 1e-9,
      `${text} → ${r.latitude},${r.longitude}`,
    );
    assert.equal(r.precisionM, precisionM, text);
  }
  assert.equal((parseMgrs('4qfj 12345 67890') as { text: string }).text, '4Q FJ 12345 67890');
  assert.equal((parseMgrs('4QFJ') as { text: string }).text, '4Q FJ');
  // Refused as GeographicLib refuses them, each with the reason.
  for (const bad of ['4RFJ1234567890', '4QFV1234567890', '32XNA1234', '1CAA0457429893'])
    assert.match((parseMgrs(bad) as { error: string }).error, /is not in zone/, bad);
  assert.match(
    (parseMgrs('4QSJ1234567890') as { error: string }).error,
    /not in zone 4/,
    'column S is in zones 3, 6, 9 …',
  );
  assert.match((parseMgrs('4QFW12345678') as { error: string }).error, /row letter/);
  assert.match((parseMgrs('4QFI12345678') as { error: string }).error, /I or O/);
  assert.match((parseMgrs('61QFJ12345678') as { error: string }).error, /no UTM zone 61/);
  assert.match((parseMgrs('4QFJ1234567') as { error: string }).error, /even number/);
  assert.match((parseMgrs('4QFJ 1234 567') as { error: string }).error, /same number/);
  assert.match((parseMgrs('4QFJ123456789012') as { error: string }).error, /at most five/);
  assert.equal(parseMgrs('Honolulu'), undefined);
  assert.equal(parseMgrs('4Q'), undefined);
});

test('reading UTM: the band letter is checked; N and S read as hemispheres only when a band cannot be meant', () => {
  const ok = (text: string, lat: number, lon: number, written?: string) => {
    const r = parseUtm(text);
    assert.ok(r && !('error' in r), `${text}: ${r && 'error' in r ? r.error : 'undefined'}`);
    assert.ok(
      Math.abs(r.latitude - lat) < 1e-9 && Math.abs(r.longitude - lon) < 1e-9,
      `${text} → ${r.latitude},${r.longitude}`,
    );
    if (written) assert.equal(r.text, written);
  };
  ok('4Q 612345 2358765', 21.32736478999274, -157.9166876850831, '4Q 612345mE 2358765mN');
  ok('4q 612345mE 2358765mN', 21.32736478999274, -157.9166876850831);
  ok('4Q, 612345, 2358765', 21.32736478999274, -157.9166876850831);
  ok('18T 585628 4511322', 40.74839601188732, -73.98570490632133);
  // "N" meaning the northern hemisphere: band N (0°–8° N) cannot hold this point.
  ok('4N 612345 2358765', 21.32736478999274, -157.9166876850831, '4Q 612345mE 2358765mN');
  // "S" meaning the southern hemisphere: band S (32°–40° N) cannot hold a northing of 6,250 km.
  ok('56S 334368 6250948', -33.8688030140165, 151.20929308730217, '56H 334368mE 6250948mN');
  // But a northing that band S could hold is ambiguous.
  assert.match((parseUtm('33S 300000 3800000') as { error: string }).error, /could be latitude band S/);
  assert.match((parseUtm('18S 585628 4511322') as { error: string }).error, /could be latitude band S/);
  assert.match((parseUtm('4R 612345 2358765') as { error: string }).error, /not in latitude band R/);
  assert.match((parseUtm('4Q 1612345 2358765') as { error: string }).error, /easting/);
  assert.match((parseUtm('0Q 612345 2358765') as { error: string }).error, /no UTM zone 0/);
  assert.equal(parseUtm('4Q 612345'), undefined);
  assert.equal(parseUtm('21.3 -157.9'), undefined);
});

test('the polar caps: UPS and MGRS bands A, B, Y and Z, as GeoConvert gives them', () => {
  // GeoConvert -u -p 6 and -m -p 0.
  const ups: Array<[number, number, 'N' | 'S', number, number, string]> = [
    [85, 0, 'N', 2_000_000, 1_444_542.608617, 'Z AB 00000 44542'],
    [-85, -135, 'S', 1_607_232.311893, 1_607_232.311893, 'A UJ 07232 07232'],
    [-85, 90, 'S', 2_555_457.391383, 2_000_000, 'B HN 55457 00000'],
    [85, -90, 'N', 1_444_542.608617, 2_000_000, 'Y SH 44542 00000'],
    [89.9, 45, 'N', 2_007_850.571206, 1_992_149.428794, 'Z AG 07850 92149'],
    [-80.1, 0, 'S', 2_000_000, 3_101_768.01006, 'B AZ 00000 01768'],
  ];
  for (const [lat, lon, h, e, n, ref] of ups) {
    const u = toUps({ latitude: lat, longitude: lon })!;
    assert.equal(u.hemisphere, h);
    assert.ok(
      Math.abs(u.easting - e) < 1e-6 && Math.abs(u.northing - n) < 1e-6,
      `${lat},${lon}: ${u.easting} ${u.northing}`,
    );
    assert.equal(formatMgrs(toMgrs({ latitude: lat, longitude: lon })!), ref);
    const back = fromUps(h, u.easting, u.northing)!;
    assert.ok(Math.abs(back.latitude - lat) < 1e-10 && Math.abs(back.longitude - lon) < 1e-10, `${lat},${lon} back`);
  }
  assert.equal(formatUps(toUps({ latitude: 85, longitude: 0 })!), 'UPS N 2000000mE 1444542mN');
  // 180° and −180° are one meridian, east of 0° (band B), as GeoConvert has it.
  assert.equal(toMgrs({ latitude: -80.000001, longitude: -180 })!.band, 'B');
  // Read back: the middle of the square.
  const read: Array<[string, number, number]> = [
    ['ZAB0000044542', 84.99999902345982, 0.0000515753046],
    ['AUJ0723207232', -85.00000239171709, -135],
    ['YSH4454200000', 84.99999902345982, -90.0000515753046],
    ['Z AG 07850 92149', 89.90000090702202, 45],
    ['BAN12', -89.73740129247162, 30.96375653207352],
  ];
  for (const [text, lat, lon] of read) {
    const r = parseMgrs(text);
    assert.ok(r && !('error' in r), text);
    assert.ok(
      Math.abs(r.latitude - lat) < 1e-9 && Math.abs(r.longitude - lon) < 1e-9,
      `${text} → ${r.latitude},${r.longitude}`,
    );
  }
  assert.match((parseMgrs('ZAZ1234567890') as { error: string }).error, /not in polar band Z/);
  assert.match((parseMgrs('YAB1234567890') as { error: string }).error, /not in polar band Y/);
});
