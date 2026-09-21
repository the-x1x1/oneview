import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ZIP_METHOD_STORE, ZipFormatError, ZipReader, ZipWriter, crc32, entryNameProblem } from './zip.js';
import { rawZip, tempDir, writeTemp, type RawEntry } from '../test/helpers/raw-zip.js';

const text = (s: string) => Buffer.from(s, 'utf8');

async function expectRejected(file: string, pattern: RegExp, limits?: Parameters<typeof ZipReader.open>[1]): Promise<void> {
  await assert.rejects(ZipReader.open(file, limits), (err: unknown) => err instanceof ZipFormatError && pattern.test(err.message), `expected ${pattern} for ${path.basename(file)}`);
}

test('zip: crc32 matches the reference value for "123456789"', () => {
  assert.equal(crc32(text('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('zip: round-trip of deflate and store entries, streamed from memory and from a file', async () => {
  const dir = await tempDir();
  const big = Buffer.from(Array.from({ length: 50_000 }, (_, i) => JSON.stringify({ i, v: Math.sin(i) })).join('\n'));
  const source = await writeTemp(dir, 'source.bin', big);
  const file = path.join(dir, 'rt.zip');
  const w = await ZipWriter.create(file, { mtime: new Date('2026-09-21T10:00:00Z') });
  const a = await w.add({ name: 'manifest.json', data: text('{"a":1}') });
  const b = await w.add({ name: 'data/big.ndjson', data: { file: source } });
  const c = await w.add({ name: 'maps/x.pmtiles', data: text('PMTiles\x03raw'), method: ZIP_METHOD_STORE });
  const done = await w.finish();
  assert.equal(done.entries.length, 3);
  assert.equal(a.uncompressedSize, 7);
  assert.equal(b.uncompressedSize, big.length);
  assert.ok(b.compressedSize < big.length);
  assert.equal(c.compressedSize, c.uncompressedSize);

  const r = await ZipReader.open(file);
  assert.deepEqual(r.entries().map((e) => e.name), ['manifest.json', 'data/big.ndjson', 'maps/x.pmtiles']);
  assert.equal((await r.readEntry('manifest.json')).toString(), '{"a":1}');
  const chunks: Buffer[] = [];
  const res = await r.streamEntry(r.entry('data/big.ndjson')!, (chunk) => { chunks.push(Buffer.from(chunk)); });
  assert.ok(Buffer.concat(chunks).equals(big));
  assert.equal(res.sha256, b.sha256);
  assert.equal(res.crc32, b.crc32);
  assert.equal((await r.readEntry('maps/x.pmtiles')).toString(), 'PMTiles\x03raw');
  await r.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('zip: writer refuses unsafe names and duplicates before writing', async () => {
  const dir = await tempDir();
  const w = await ZipWriter.create(path.join(dir, 'w.zip'));
  await assert.rejects(w.add({ name: '../x', data: text('x') }), /traversal/);
  await assert.rejects(w.add({ name: 'data/run.exe', data: text('x') }), /forbidden extension/);
  await w.add({ name: 'data/a.geojson', data: text('{}') });
  await assert.rejects(w.add({ name: 'DATA/A.geojson', data: text('{}') }), /duplicate/);
  await w.finish();
  await fs.rm(dir, { recursive: true, force: true });
});

test('zip: entry name policy', () => {
  const bad = ['', '/etc/passwd', '..', '../x', 'a/../b', 'a/./b', 'C:/x', 'c:\\x', 'data\\x.geojson', 'data/', 'data/.hidden', 'data/x.exe', 'data/X.EXE', 'search/index.js', 'a.mjs', 'run.ps1', 'x.sh', 'x.py', 'x.jar', 'con.geojson', 'data/nul', 'data/é.geojson', 'data/x y.geojson', 'a'.repeat(300)];
  for (const name of bad) assert.ok(entryNameProblem(name), `should reject "${name}"`);
  const good = ['manifest.json', 'maps/hawaii.pmtiles', 'data/places.geojson', 'search/index.json', 'licenses/NOTICES.md', 'data/earthquakes-usgs-earthquakes.ndjson'];
  for (const name of good) assert.equal(entryNameProblem(name), undefined, `should accept "${name}"`);
});

// ---- adversarial archives -----------------------------------------------------

const ok: RawEntry = { name: 'manifest.json', data: text('{}') };

test('adversarial: zip-slip and absolute/backslash/drive-letter names are rejected at open', async () => {
  const dir = await tempDir();
  const cases: Array<[string, RegExp]> = [
    ['../../evil.geojson', /traversal/],
    ['data/../../evil.geojson', /traversal/],
    ['/etc/passwd', /absolute/],
    ['data\\evil.geojson', /backslash/],
    ['C:/evil.geojson', /drive letter/],
    ['data/.env', /hidden/],
    ['data/', /directory|characters/],
  ];
  for (const [name, re] of cases) {
    const file = await writeTemp(dir, `slip-${cases.findIndex((c) => c[0] === name)}.zip`, rawZip([ok, { name, data: text('x') }]));
    await expectRejected(file, re);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: symlink attribute is rejected', async () => {
  const dir = await tempDir();
  const file = await writeTemp(dir, 'symlink.zip', rawZip([ok, { name: 'data/link.geojson', data: text('/etc/passwd'), externalAttributes: (0o120777 << 16) >>> 0 }]));
  await expectRejected(file, /symbolic link/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: executable entries are rejected whatever the case', async () => {
  const dir = await tempDir();
  for (const [i, name] of ['data/payload.exe', 'search/index.js', 'licenses/NOTICES.ps1', 'data/X.DLL', 'maps/x.Sh'].entries()) {
    const file = await writeTemp(dir, `exe-${i}.zip`, rawZip([ok, { name, data: text('x') }]));
    await expectRejected(file, /forbidden extension/);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: duplicate names (case-insensitive) are rejected', async () => {
  const dir = await tempDir();
  const file = await writeTemp(dir, 'dup.zip', rawZip([ok, { name: 'data/a.geojson', data: text('1') }, { name: 'DATA/A.GEOJSON', data: text('2') }]));
  await expectRejected(file, /duplicate/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: oversize declared sizes and totals are rejected before inflating', async () => {
  const dir = await tempDir();
  const huge = await writeTemp(dir, 'huge.zip', rawZip([ok, { name: 'data/a.geojson', data: text('x'), declaredUncompressed: 3 * 1024 * 1024 * 1024 }]));
  await expectRejected(huge, /limit/);
  const total = await writeTemp(dir, 'total.zip', rawZip([ok, { name: 'data/a.ndjson', data: Buffer.alloc(600, 0x41), method: 0 }, { name: 'data/b.ndjson', data: Buffer.alloc(600, 0x42), method: 0 }]));
  await expectRejected(total, /total declared size/, { maxTotalBytes: 1000 });
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: lying uncompressed size is caught while inflating (both directions)', async () => {
  const dir = await tempDir();
  const payload = Buffer.from(Array.from({ length: 2000 }, (_, i) => `row ${i} ${Math.cos(i)}`).join('\n'));
  const under = await writeTemp(dir, 'under.zip', rawZip([ok, { name: 'data/a.ndjson', data: payload, declaredUncompressed: 100 }]));
  let r = await ZipReader.open(under);
  await assert.rejects(r.streamEntry(r.entry('data/a.ndjson')!, () => undefined), /exceeds the declared/);
  await r.close();
  const over = await writeTemp(dir, 'over.zip', rawZip([ok, { name: 'data/a.ndjson', data: payload, declaredUncompressed: payload.length + 1 }]));
  r = await ZipReader.open(over);
  await assert.rejects(r.streamEntry(r.entry('data/a.ndjson')!, () => undefined), /declared/);
  await r.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: compression-bomb ratio is rejected at open', async () => {
  const dir = await tempDir();
  const zeros = Buffer.alloc(2 * 1024 * 1024, 0);
  const file = await writeTemp(dir, 'bomb.zip', rawZip([ok, { name: 'data/zeros.ndjson', data: zeros }]));
  await expectRejected(file, /ratio .* exceeds 200:1/);
  // The same payload stored (ratio 1:1) is fine structurally.
  const stored = await writeTemp(dir, 'stored.zip', rawZip([ok, { name: 'data/zeros.ndjson', data: zeros, method: 0 }]));
  const r = await ZipReader.open(stored);
  assert.equal(r.entries().length, 2);
  await r.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: CRC tampering and corrupt deflate data are caught', async () => {
  const dir = await tempDir();
  const payload = Buffer.from(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
  const wrongCrc = await writeTemp(dir, 'crc.zip', rawZip([ok, { name: 'data/a.ndjson', data: payload, declaredCrc: 0x12345678 }]));
  let r = await ZipReader.open(wrongCrc);
  await assert.rejects(r.streamEntry(r.entry('data/a.ndjson')!, () => undefined), /CRC-32 mismatch/);
  await r.close();
  const bytes = rawZip([ok, { name: 'data/a.ndjson', data: payload }]);
  const local = 30 + 'manifest.json'.length + 2 + 30 + 'data/a.ndjson'.length; // manifest entry ("{}" deflates to 2 bytes) + second local header
  bytes[local + 5] = bytes[local + 5]! ^ 0xff;
  bytes[local + 6] = bytes[local + 6]! ^ 0xff;
  const corrupt = await writeTemp(dir, 'corrupt.zip', bytes);
  r = await ZipReader.open(corrupt);
  await assert.rejects(r.streamEntry(r.entry('data/a.ndjson')!, () => undefined), /CRC-32 mismatch|inflate failed|declared/);
  await r.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: truncated archives and directory/data overruns are rejected', async () => {
  const dir = await tempDir();
  const full = rawZip([ok, { name: 'data/a.ndjson', data: Buffer.from('hello world '.repeat(100)) }]);
  const cut = await writeTemp(dir, 'cut.zip', full.subarray(0, full.length - 10));
  await expectRejected(cut, /end of central directory|truncated|trailing/);
  const tiny = await writeTemp(dir, 'tiny.zip', Buffer.from('PK'));
  await expectRejected(tiny, /too small/);
  const overrun = await writeTemp(dir, 'overrun.zip', rawZip([ok, { name: 'data/a.ndjson', data: text('abc'), method: 0, declaredCompressed: 5000, declaredUncompressed: 5000 }]));
  await expectRejected(overrun, /overruns/);
  const trailing = await writeTemp(dir, 'trailing.zip', Buffer.concat([full, Buffer.from('junk')]));
  await expectRejected(trailing, /end of central directory|trailing/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('adversarial: encryption, unknown methods, zip64 markers, store-size mismatch and local/central disagreement', async () => {
  const dir = await tempDir();
  const enc = await writeTemp(dir, 'enc.zip', rawZip([ok, { name: 'data/a.ndjson', data: text('x'), flags: 0x0001 }]));
  await expectRejected(enc, /encrypted/);
  const bz = await writeTemp(dir, 'bz.zip', rawZip([ok, { name: 'data/a.ndjson', data: text('x'), method: 12 }]));
  await expectRejected(bz, /unsupported compression method/);
  const z64 = await writeTemp(dir, 'z64.zip', rawZip([ok, { name: 'data/a.ndjson', data: text('x'), declaredUncompressed: 0xffffffff }]));
  await expectRejected(z64, /zip64|limit/);
  const z64extra = await writeTemp(dir, 'z64x.zip', rawZip([ok, { name: 'data/a.ndjson', data: text('x'), centralExtra: Buffer.from([0x01, 0x00, 0x00, 0x00]) }]));
  await expectRejected(z64extra, /zip64/);
  const z64count = await writeTemp(dir, 'z64c.zip', rawZip([ok], { totalEntries: 0xffff }));
  await expectRejected(z64count, /zip64/);
  const storeMismatch = await writeTemp(dir, 'store.zip', rawZip([ok, { name: 'data/a.ndjson', data: text('abcd'), method: 0, declaredUncompressed: 3 }]));
  await expectRejected(storeMismatch, /mismatched sizes/);
  const renamed = await writeTemp(dir, 'renamed.zip', rawZip([ok, { name: 'data/a.ndjson', data: text('abcd'), localName: 'data/b.ndjson' }]));
  const r = await ZipReader.open(renamed);
  await assert.rejects(r.streamEntry(r.entry('data/a.ndjson')!, () => undefined), /local header name differs/);
  await r.close();
  await fs.rm(dir, { recursive: true, force: true });
});
