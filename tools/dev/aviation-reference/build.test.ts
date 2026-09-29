import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — a plain .mjs tool without declarations
import { FORMAT, baseModel, buildAirlines, buildTypes, parseCsv, typeName, wordPrefix } from './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * INVENTED CSV in the standing-data schema-01 layouts (airlines/schema-01/README.md,
 * model-type/schema-01/README.md): the names are made up where they are not plain facts.
 */
const AIRLINES = [
  '\ufeffCode,Name,ICAO,IATA,PositioningFlightPattern,CharterFlightPattern',
  '1B,Some Reservation System,,1B,,',
  'TST,"Test Air, Ltd",TST,T1,9\\d\\d\\d,',
  'TSX,Test Cargo,TSX,,,',
  'TST,Duplicate Test,TST,T2,,',
  'tsl,Lower Case,tsl,,,',
].join('\r\n');

const TYPES = [
  'ICAO,Manufacturer,Model,Engines,EngineTypeCode,EnginePlacementCode,SpeciesCode,WakeTurbulenceCode,IsActive',
  'T789,Testco,787-9 BBJ,2,J,,L,H,1',
  'T789,Testco,787-9 Dreamliner,2,J,,L,H,1',
  'T789,Testco,Old Name,2,J,,L,H,0',
  'TP12,Testco,PC-12,1,T,,L,L,1',
  'TP12,Testco,PC-12 Eagle,1,T,,L,L,1',
  'TP12,Testco,U-28,1,T,,L,L,1',
  'TF16,Maker A,F-16 Fighting Falcon,1,J,,L,M,1',
  'TF16,Maker A,NF-16 Other,1,J,,L,M,1',
  'TF16,Maker B,F-16 Fighting Falcon,1,J,,L,M,1',
  'GLID,,Glider,,,,,,0',
  '-GND,,Ground vehicle,,,,,,1',
].join('\n');

test('parseCsv: quotes, doubled quotes, CRLF and a BOM', () => {
  const rows = parseCsv('\ufeffa,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
  assert.deepEqual(rows, [
    { a: 'x, y', b: 'say "hi"' },
    { a: '1', b: '2' },
  ]);
});

test('airlines: three-letter ICAO designators only, first row wins, sorted', () => {
  assert.deepEqual(buildAirlines(parseCsv(AIRLINES)), [
    ['TSL', 'Lower Case'],
    ['TST', 'Test Air, Ltd', 'T1'],
    ['TSX', 'Test Cargo'],
  ]);
});

test('type names: common word prefix, the base model, the model most makers list; fake codes skipped', () => {
  assert.equal(wordPrefix(['787-9 BBJ', '787-9 Dreamliner']), '787-9');
  assert.equal(wordPrefix(['A-320', 'A-3200']), '', 'not a whole word');
  assert.equal(baseModel(['PC-12', 'PC-12 Eagle', 'U-28']), 'PC-12');
  assert.equal(baseModel(['ATR P-72', 'ATR-72-212A (600)', 'ATR-72-600']), 'ATR-72-600');
  assert.deepEqual(buildTypes(parseCsv(TYPES)), [
    ['GLID', 'Glider'],
    ['T789', 'Testco 787-9'],
    ['TF16', 'Maker A F-16 Fighting Falcon'],
    ['TP12', 'Testco PC-12'],
  ]);
  assert.equal(typeName([{ ICAO: 'X', Manufacturer: 'Airbus', Model: 'Airbus A-320', IsActive: '1' }]), 'Airbus A-320');
});

test('the shipped file is in the format the runtime reads, credited, and small', () => {
  const file = path.join(root, 'fixtures', 'aviation', 'aviation-reference.json');
  const text = readFileSync(file, 'utf8');
  const doc = JSON.parse(text) as {
    format: string;
    provenance: { license: string; credit: string };
    airlines: string[][];
    types: string[][];
  };
  assert.equal(doc.format, FORMAT);
  assert.match(doc.provenance.license, /CC0/);
  assert.ok(text.length < 400_000, `${text.length} bytes`);
  const sorted = (rows: string[][]) => rows.every((r, i) => i === 0 || rows[i - 1]![0]! < r[0]!);
  assert.ok(sorted(doc.airlines) && sorted(doc.types), 'deterministic order');
});
