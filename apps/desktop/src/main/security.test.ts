import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USGS_MANIFEST } from '@worldview/provider-usgs';
import {
  CredentialStore,
  CredentialStoreError,
  ENCRYPTION_UNAVAILABLE_MESSAGE,
  type SafeStorageLike,
} from './credential-store.js';
import { buildCsp, buildCspDirectives, mergeSecurityHeaders } from './csp.js';
import { STATIC_EXTERNAL_HOSTS, buildExternalHostAllowlist, checkExternalUrl } from './external-links.js';
import { APP_ORIGIN, isTrustedRendererUrl } from '../shared/app-origin.js';
import { contentTypeFor, resolveRendererAsset, serveRenderer } from './app-protocol.js';

/** Fake safeStorage: reversible transform so round trips are observable, never plaintext at rest. */
function fakeSafeStorage(available = true): SafeStorageLike & { encrypted: number } {
  const key = 0x5a;
  return {
    encrypted: 0,
    isEncryptionAvailable: () => available,
    encryptString(plain) {
      this.encrypted++;
      return Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ key));
    },
    decryptString(buf) {
      return Buffer.from(buf.map((b) => b ^ key)).toString('utf8');
    },
  };
}

test('credential store: round trip with encryption; file never contains plaintext; renderer-visible has() only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-cred-'));
  const file = path.join(dir, 'credentials.json');
  const safe = fakeSafeStorage();
  const store = new CredentialStore({ file, safeStorage: safe, now: () => Date.parse('2026-09-21T00:00:00Z') });
  assert.equal(await store.has('firms.mapKey'), false);
  await store.set('firms.mapKey', 'my-secret-map-key');
  assert.equal(await store.has('firms.mapKey'), true);
  assert.equal(await store.get('firms.mapKey'), 'my-secret-map-key');
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('my-secret-map-key'), 'ciphertext only on disk');
  assert.equal(safe.encrypted, 1);

  const reopened = new CredentialStore({ file, safeStorage: fakeSafeStorage() });
  assert.deepEqual(await reopened.load(), { status: 'loaded', keys: 1 });
  assert.equal(await reopened.get('firms.mapKey'), 'my-secret-map-key');
  await reopened.delete('firms.mapKey');
  assert.equal(await reopened.has('firms.mapKey'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, entries: {} });

  await assert.rejects(store.set('../evil', 'x'), (e: CredentialStoreError) => e.code === 'INVALID_KEY');
  await assert.rejects(store.set('ok.key', ''), (e: CredentialStoreError) => e.code === 'INVALID_VALUE');
  await assert.rejects(store.set('ok.key', 'x'.repeat(5000)), (e: CredentialStoreError) => e.code === 'INVALID_VALUE');
});

test('credential store: refuses to store when OS encryption is unavailable, with a clear message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-cred-'));
  const file = path.join(dir, 'credentials.json');
  const store = new CredentialStore({ file, safeStorage: fakeSafeStorage(false) });
  assert.equal(store.encryptionAvailable, false);
  await assert.rejects(
    store.set('firms.mapKey', 'secret'),
    (e: CredentialStoreError) => e.code === 'ENCRYPTION_UNAVAILABLE' && e.message === ENCRYPTION_UNAVAILABLE_MESSAGE,
  );
  await assert.rejects(fs.access(file), 'nothing written');
  assert.equal(await store.has('firms.mapKey'), false);

  // Existing ciphertext from a working system cannot be read here: get() degrades to undefined, never throws to callers.
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, entries: { 'firms.mapKey': { cipher: 'AAAA', updatedAt: '2026-09-21T00:00:00Z' } } }),
  );
  const store2 = new CredentialStore({ file, safeStorage: fakeSafeStorage(false) });
  assert.equal(await store2.has('firms.mapKey'), true);
  assert.equal(await store2.get('firms.mapKey'), undefined);
});

test('credential store: corrupt file starts empty and is preserved', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-cred-'));
  const file = path.join(dir, 'credentials.json');
  await fs.writeFile(file, '{ nope');
  const store = new CredentialStore({ file, safeStorage: fakeSafeStorage() });
  assert.deepEqual(await store.load(), { status: 'corrupt', keys: 0 });
  assert.equal(await fs.readFile(file, 'utf8'), '{ nope');
});

test('csp: production policy is strict; dev adds only the Vite origin', () => {
  const csp = buildCsp();
  assert.equal(
    csp,
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*",
      "font-src 'self' data:",
      "media-src 'self' blob: https: http://127.0.0.1:* http://localhost:*",
      "connect-src 'self' https: wss: http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "object-src 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  );
  assert.ok(!csp.includes("'unsafe-eval'"), 'no JavaScript eval');
  assert.ok(!csp.includes('unsafe-inline') || /style-src[^;]*'unsafe-inline'/.test(csp));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts');
  // Loopback is allowed only where the camera relay needs it; it is never a general
  // http: escape hatch for scripts, styles or arbitrary hosts.
  for (const directive of ['default-src', 'script-src', 'style-src', 'font-src', 'worker-src', 'child-src']) {
    const values = buildCspDirectives()[directive]!;
    assert.ok(!values.some((v) => v.startsWith('http://')), `${directive} must not allow plain http`);
  }
  for (const directive of ['img-src', 'media-src', 'connect-src']) {
    const values = buildCspDirectives()[directive]!;
    assert.ok(
      !values.some((v) => v === 'http:' || /^http:\/\/(?!127\.0\.0\.1|localhost)/.test(v)),
      `${directive} allows loopback only`,
    );
  }
  const dev = buildCspDirectives({ dev: true });
  assert.ok(dev['script-src']!.includes('http://127.0.0.1:5173'));
  assert.ok(dev['connect-src']!.includes('ws://127.0.0.1:5173'));
  assert.ok(!buildCspDirectives({ dev: false })['script-src']!.includes('http://127.0.0.1:5173'));

  const merged = mergeSecurityHeaders({ 'content-security-policy': ['default-src *'], 'Content-Type': ['text/html'] });
  assert.deepEqual(merged['Content-Type'], ['text/html']);
  assert.equal(
    Object.keys(merged).filter((k) => k.toLowerCase() === 'content-security-policy').length,
    1,
    'upstream CSP replaced, not duplicated',
  );
  assert.deepEqual(merged['Content-Security-Policy'], [csp]);
  assert.deepEqual(merged['X-Content-Type-Options'], ['nosniff']);
});

test('openExternal allowlist: https only, known hosts only, derived from manifests', () => {
  const allow = buildExternalHostAllowlist([USGS_MANIFEST]);
  assert.ok(allow.has('www.usgs.gov'), 'termsUrl host');
  assert.ok(allow.has('earthquake.usgs.gov'), 'attribution host');
  for (const h of STATIC_EXTERNAL_HOSTS) assert.ok(allow.has(h));
  assert.equal(
    checkExternalUrl('https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits', allow)
      .allowed,
    true,
  );
  assert.equal(checkExternalUrl('https://sub.earthquake.usgs.gov/x', allow).allowed, true);
  assert.equal(checkExternalUrl('https://evil.example/', allow).allowed, false);
  assert.equal(checkExternalUrl('https://usgs.gov.evil.example/', allow).allowed, false);
  assert.equal(checkExternalUrl('http://www.usgs.gov/', allow).allowed, false);
  assert.equal(checkExternalUrl('file:///etc/passwd', allow).allowed, false);
  assert.equal(checkExternalUrl('javascript:alert(1)', allow).allowed, false);
  assert.equal(checkExternalUrl('https://user:pw@www.usgs.gov/', allow).allowed, false);
  assert.equal(
    checkExternalUrl('https://93.184.216.34/', new Set(['93.184.216.34'])).allowed,
    false,
    'ip literals refused even if listed',
  );
  assert.equal(checkExternalUrl('not a url', allow).allowed, false);
  assert.equal(checkExternalUrl('https://www.usgs.gov/' + 'a'.repeat(3000), allow).allowed, false);
});

test('renderer origin lock: only the app scheme or the dev server', () => {
  assert.equal(isTrustedRendererUrl(`${APP_ORIGIN}/`, { dev: false }), true);
  assert.equal(isTrustedRendererUrl(`${APP_ORIGIN}/assets/index-abc123.js`, { dev: false }), true);
  // A `file:` renderer is what broke the packaged app: Vite's crossorigin module script and
  // stylesheet are CORS fetches, and a file: document has an opaque origin, so Chromium
  // blocked the bundle and the window came up empty. It is not a trusted origin any more.
  assert.equal(
    isTrustedRendererUrl('file:///C:/Program%20Files/WorldView/resources/app.asar/dist/renderer/index.html', {
      dev: false,
    }),
    false,
  );
  assert.equal(isTrustedRendererUrl('file:///C:/Users/x/evil.html', { dev: false }), false);
  // A host that merely starts with ours must not pass as a prefix.
  assert.equal(isTrustedRendererUrl('worldview://app.evil.example/', { dev: false }), false);
  assert.equal(isTrustedRendererUrl('worldview://other/', { dev: false }), false);
  assert.equal(isTrustedRendererUrl('https://example.com/', { dev: false }), false);
  assert.equal(isTrustedRendererUrl(`${APP_ORIGIN}/`, { dev: true }), false, 'dev trusts only the dev server');
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/', { dev: true }), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/src/main.tsx', { dev: true }), true);
  assert.equal(isTrustedRendererUrl('http://localhost:5174/', { dev: true }), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173.evil.example/', { dev: true }), false);
});

test('app protocol: serves the bundle, and nothing outside it', () => {
  const dir = path.join('C:', 'app', 'dist', 'renderer');
  const at = (...parts: string[]): string => path.resolve(dir, ...parts);

  assert.equal(resolveRendererAsset(dir, `${APP_ORIGIN}/`), at('index.html'), 'the root is the document');
  assert.equal(resolveRendererAsset(dir, `${APP_ORIGIN}`), at('index.html'));
  assert.equal(resolveRendererAsset(dir, `${APP_ORIGIN}/assets/index-abc.js`), at('assets', 'index-abc.js'));
  assert.equal(
    resolveRendererAsset(dir, `${APP_ORIGIN}/cesium/Workers/transferTypedArrayTest.js`),
    at('cesium', 'Workers', 'transferTypedArrayTest.js'),
  );

  // Containment is the security boundary: a handler that joined blindly would hand any file
  // on the disk to a page that asked for it. Traversal never reaches the resolver — the URL
  // parser collapses `..`, and `%2e%2e` with it, while building `pathname` — so what matters
  // is that whatever comes out the far end is still inside the bundle. Asserted directly
  // rather than trusting the parser to keep doing that.
  const root = path.resolve(dir);
  for (const attempt of [
    '/../../../etc/passwd',
    '/assets/../../secrets.json',
    '/%2e%2e/%2e%2e/secrets.json',
    '/./../../etc/shadow',
  ]) {
    const resolved = resolveRendererAsset(dir, `${APP_ORIGIN}${attempt}`);
    assert.ok(
      resolved === undefined || resolved.startsWith(root + path.sep),
      `${attempt} escaped the bundle: ${String(resolved)}`,
    );
  }
  assert.equal(resolveRendererAsset(dir, `${APP_ORIGIN}/a%00b`), undefined, 'null byte');
  assert.equal(resolveRendererAsset(dir, 'file:///etc/passwd'), undefined, 'wrong scheme');
  assert.equal(resolveRendererAsset(dir, 'worldview://other/index.html'), undefined, 'wrong host');
});

test('app protocol: a module script must not be served as application/octet-stream', () => {
  // Chromium rejects a module script whose type is not a JavaScript MIME type, which would
  // reproduce the blank window through a different door.
  assert.match(contentTypeFor('/x/index-abc.js'), /^text\/javascript/);
  assert.match(contentTypeFor('/x/index.mjs'), /^text\/javascript/);
  assert.match(contentTypeFor('/x/index.css'), /^text\/css/);
  assert.match(contentTypeFor('/x/index.html'), /^text\/html/);
  assert.equal(contentTypeFor('/x/terrain.wasm'), 'application/wasm');
  assert.equal(contentTypeFor('/x/tile.ktx2'), 'image/ktx2');
  assert.equal(contentTypeFor('/x/unknown.bin'), 'application/octet-stream');
});

test('csp: the renderer document carries no policy of its own', () => {
  const html = readFileSync(path.join(import.meta.dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(
    !/http-equiv=["']Content-Security-Policy["']/i.test(html),
    'index.html declares a CSP. Policies combine by intersection, so a second copy can only ever be more restrictive than buildCsp() — and this one silently blocked map tiles and camera frames. The policy lives in csp.ts.',
  );
});

test('app protocol: /__tiles/ goes to the tile cache, same origin; everything else is still the bundle', async () => {
  const handlers: Array<(r: Request) => Promise<Response> | Response> = [];
  const protocol = {
    registerSchemesAsPrivileged: () => undefined,
    handle: (_scheme: string, h: (r: Request) => Promise<Response> | Response) => void handlers.push(h),
  };
  const asked: string[] = [];
  serveRenderer(protocol, '/nonexistent-bundle', undefined, {
    tiles: async (pathname) => {
      asked.push(pathname);
      return new Response('tile', { status: 200 });
    },
  });
  const handle = handlers[0]!;
  assert.equal((await handle(new Request(`${APP_ORIGIN}/__tiles/esri-world-imagery/3/1/2`))).status, 200);
  assert.deepEqual(asked, ['/__tiles/esri-world-imagery/3/1/2']);
  assert.equal((await handle(new Request(`${APP_ORIGIN}/index.html`))).status, 404, 'a bundle path is not a tile');
  assert.deepEqual(asked, ['/__tiles/esri-world-imagery/3/1/2']);
});
