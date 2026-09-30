import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, WorldObject } from '@worldview/world-model';
import {
  compassPoint,
  feltText,
  formatDay,
  formatVoyageEta,
  intensityText,
  magnitudeText,
  noPassesText,
  pagerText,
  passObserverText,
  passViews,
  satcatRows,
  satcatStatusNote,
  vesselFlag,
  vesselRows,
} from './object-knowledge.js';
import { firstPassEnd, mergeDetails } from './satellite-details.js';

const value = (rows: Array<{ label: string; value: string | undefined }>, label: string) =>
  rows.find((r) => r.label === label)?.value;

const vessel = (properties: Record<string, JsonValue>, id = 'vessel:mmsi:244123456') =>
  ({ id, labels: {}, properties }) as unknown as WorldObject;

test('compass points and days', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(22.5), 'NNE');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(-90), 'W');
  assert.equal(formatDay('1998-11-20'), '20 Nov 1998');
  assert.equal(formatDay('not a date'), 'not a date');
});

test('satcatRows: codes spelled out with the code beside them; decay said plainly', () => {
  const rows = satcatRows({
    objectTypeText: 'Payload',
    owner: 'ISS',
    ownerName: 'International Space Station partners',
    launchDate: '1998-11-20',
    launchSite: 'TYMSC',
    launchSiteName: 'Baikonur Cosmodrome (Tyuratam), Kazakhstan',
    opsStatusText: 'Operational',
    orbitClassText: 'Low Earth orbit (LEO)',
    orbitTypeText: 'In orbit',
  });
  assert.equal(value(rows, 'Owner / country'), 'International Space Station partners (ISS)');
  assert.equal(value(rows, 'Launched'), '20 Nov 1998');
  assert.equal(value(rows, 'Launch site'), 'Baikonur Cosmodrome (Tyuratam), Kazakhstan (TYMSC)');
  assert.equal(value(rows, 'Orbit class'), 'Low Earth orbit (LEO)');
  assert.equal(value(rows, 'Orbit'), undefined, '"In orbit" goes without saying');
  assert.equal(value(rows, 'Decayed'), undefined);
  const gone = satcatRows({ owner: 'ZZZ', decayDate: '1990-01-15', orbitTypeText: 'Impacted', rcsM2: 0.25 });
  assert.equal(value(gone, 'Owner / country'), 'ZZZ');
  assert.match(value(gone, 'Decayed')!, /^15 Jan 1990 — re-entered/);
  assert.equal(value(gone, 'Orbit'), 'Impacted');
  assert.equal(value(gone, 'Radar cross-section'), '0.25 m²');
  const geo = satcatRows({ orbitClassText: 'Geosynchronous orbit (GEO)', geostationary: true });
  assert.equal(value(geo, 'Orbit class'), 'Geosynchronous orbit (GEO), geostationary');
  assert.match(satcatStatusNote({ satcatStatus: 'not-listed' })!, /no record/);
  assert.match(satcatStatusNote({ satcatStatus: 'unavailable' })!, /could not be read/);
  assert.equal(satcatStatusNote({ satcatStatus: 'found' }), undefined);
});

test('passViews: upcoming passes in words; one in progress says so; one already over is left out', () => {
  const now = Date.parse('2008-09-20T22:50:00Z');
  const props = {
    passMinElevationDeg: 10,
    passes: [
      {
        riseAt: '2008-09-20T22:40:00.000Z',
        riseAzimuthDeg: 200,
        culminationAt: '2008-09-20T22:42:00.000Z',
        culminationAzimuthDeg: 180,
        maxElevationDeg: 20,
        setAt: '2008-09-20T22:45:00.000Z',
        setAzimuthDeg: 100,
      },
      {
        culminationAt: '2008-09-20T22:50:00.000Z',
        culminationAzimuthDeg: 90,
        maxElevationDeg: 60,
        setAt: '2008-09-20T22:52:30.000Z',
        setAzimuthDeg: 45,
      },
      {
        riseAt: '2008-09-21T00:25:44.000Z',
        riseAzimuthDeg: 249.7,
        culminationAt: '2008-09-21T00:28:35.000Z',
        culminationAzimuthDeg: 180,
        maxElevationDeg: 48.1,
        setAt: '2008-09-21T00:31:28.000Z',
        setAzimuthDeg: 43.3,
      },
      'junk',
    ],
  } as Record<string, JsonValue>;
  const views = passViews(props, now)!;
  assert.equal(views.length, 2);
  assert.equal(views[0]!.when, 'In view now · sets in 2m 30s');
  assert.equal(views[0]!.path, 'highest E at 22:50:00, sets NE');
  assert.equal(views[0]!.duration, undefined);
  assert.equal(views[1]!.when, '2008-09-21 00:25:44 UTC · in 1h 35m');
  assert.equal(views[1]!.peak, '48° max');
  assert.equal(views[1]!.path, 'rises WSW, highest S at 00:28:35, sets NE');
  assert.equal(views[1]!.duration, '5m 44s above 10°');
  assert.equal(passViews({}, now), undefined);
  assert.equal(firstPassEnd(props, now), Date.parse('2008-09-20T22:52:30.000Z'));
});

test('where the passes are for, and what is said when there are none', () => {
  assert.equal(
    passObserverText({ passObserver: { latitude: 40, longitude: -75 }, passMinElevationDeg: 10 }),
    'Over 40.000° N, 75.000° W (the middle of the view when asked), above 10° elevation',
  );
  assert.equal(
    passObserverText({ passObserver: { latitude: 21.3, longitude: -157.86 } }, 'home'),
    'Over 21.300° N, 157.860° W (your home view), above 10° elevation',
  );
  assert.equal(passObserverText({}), undefined);
  assert.equal(
    noPassesText({ passesAlwaysAbove: true, passes: [] }),
    'Always above the horizon from here — it does not rise or set.',
  );
  assert.equal(
    noPassesText({ passes: [], passesSearchedUntil: '2008-09-23T12:30:00.000Z' }),
    'No pass above 10° from here before 2008-09-23 12:30:00 UTC.',
  );
  assert.equal(noPassesText({ passes: [{ culminationAt: 'x', maxElevationDeg: 1 }] }), undefined);
});

test('mergeDetails: properties of every answer, each attribution once', () => {
  const merged = mergeDetails([
    { providerId: 'a', label: 'A', attribution: 'Source A', properties: { x: 1 } },
    { providerId: 'b', label: 'B', properties: { y: 2 } },
    { providerId: 'c', label: 'C', attribution: 'Source A', properties: { x: 3 } },
  ]);
  assert.deepEqual(merged, { properties: { x: 3, y: 2 }, attributions: ['Source A', 'B'] });
});

test('formatVoyageEta: month, day and time as broadcast; no year invented', () => {
  assert.equal(formatVoyageEta({ month: 10, day: 2, hour: 6, minute: 30 }), '2 Oct 06:30 UTC');
  assert.equal(formatVoyageEta({ month: 10, day: 2 }), '2 Oct');
  assert.equal(formatVoyageEta({ month: 10, day: 2, hour: 24, minute: 60 }), '2 Oct');
  assert.equal(formatVoyageEta({ month: 0, day: 2 }), undefined);
  assert.equal(formatVoyageEta('2026-10-02T06:30:00Z'), '2026-10-02 06:30:00 UTC');
  assert.equal(formatVoyageEta(undefined), undefined);
});

test('vesselRows: the AIS fields as broadcast, the flag from the MMSI, numeric codes with their text', () => {
  const rows = vesselRows(
    vessel({
      mmsi: '244123456',
      flag: 'Netherlands',
      flagMid: '244',
      imo: '9876543',
      callSign: 'PABC',
      shipType: 71,
      shipTypeText: 'cargo',
      navStatus: 0,
      navStatusText: 'under way using engine',
      destination: 'NLRTM',
      eta: { month: 10, day: 2, hour: 6, minute: 30 },
      lengthM: 190,
      beamM: 30,
      draughtM: 11.2,
    }),
  );
  assert.equal(value(rows, 'Flag (from MMSI)'), 'Netherlands (MID 244)');
  assert.equal(value(rows, 'Ship type (as broadcast)'), 'Cargo (71)');
  assert.equal(value(rows, 'Navigation status'), 'Under way using engine');
  assert.equal(value(rows, 'Destination (as broadcast)'), 'NLRTM');
  assert.equal(value(rows, 'ETA (as broadcast)'), '2 Oct 06:30 UTC');
  assert.equal(value(rows, 'Length × beam (as broadcast)'), '190 m × 30 m');
  assert.equal(value(rows, 'Draught (as broadcast)'), '11.2 m');
  assert.equal(value(rows, 'IMO (as broadcast)'), '9876543');
  assert.equal(value(rows, 'Station'), undefined, 'a ship');
});

test('vesselFlag: read from the MMSI when an older record carries no flag; a buoy is not a ship', () => {
  assert.deepEqual(vesselFlag(vessel({ mmsi: '366123456' })), { flag: 'United States (MID 366)' });
  assert.deepEqual(vesselFlag(vessel({}, 'vessel:mmsi:992351234')), {
    flag: 'United Kingdom (MID 235)',
    kind: 'aid-to-navigation',
  });
  assert.deepEqual(vesselFlag(vessel({ mmsi: '970123456' })), { kind: 'emergency-device' });
  assert.equal(
    value(vesselRows(vessel({ mmsi: '992351234', mmsiKind: 'aid-to-navigation' })), 'Station'),
    'Aid to navigation',
  );
});

test('earthquake words: magnitude type, PAGER level, felt reports and intensity', () => {
  assert.equal(magnitudeText(6.14, 'mww'), 'M 6.1 mww — moment magnitude (W-phase)');
  assert.equal(magnitudeText(2.3, 'ml'), 'M 2.3 ml — local magnitude');
  assert.equal(magnitudeText(2.3, 'xx'), 'M 2.3 xx');
  assert.equal(magnitudeText(2.3, undefined), 'M 2.3');
  assert.equal(magnitudeText(undefined, 'ml'), undefined);
  assert.match(pagerText('orange')!, /^Orange — significant casualties \(100–999\)/);
  assert.match(pagerText('GREEN')!, /^Green/);
  assert.equal(pagerText('purple'), 'purple');
  assert.equal(pagerText(undefined), undefined);
  assert.equal(intensityText(4.3), 'IV');
  assert.equal(intensityText(12.4), 'XII');
  assert.equal(intensityText(0.5), undefined);
  assert.equal(feltText(34, 4.1), '34 reports · strongest felt intensity IV');
  assert.equal(feltText(1, undefined), '1 report');
  assert.equal(feltText(undefined, undefined), undefined);
});
