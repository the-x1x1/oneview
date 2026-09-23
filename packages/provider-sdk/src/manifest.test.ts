import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNameableHost, manifestSchema, type ProviderManifest } from './manifest.js';

const LOCAL: ProviderManifest = {
  id: 'local-thing',
  name: 'Local thing',
  version: '0.1.0',
  description: 'A receiver on the user’s machine.',
  objectTypes: ['aircraft'],
  categories: ['aviation'],
  transport: 'local-process',
  capabilities: { live: true, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 1000,
    minIntervalMs: 500,
    timeoutMs: 2000,
    maxRetries: 0,
    maxRequestsPerMinute: 120,
    staleWhileErrorMs: 0,
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: false,
  },
  attribution: { text: 'Local thing' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: ['127.0.0.1', 'localhost'],
  settings: [{ key: 'trustedHost', label: 'Receiver on another machine', kind: 'string' }],
  trustedHostSetting: 'trustedHost',
};

const problem = (m: ProviderManifest): string => {
  const r = manifestSchema.parse(m);
  return r.ok ? 'ok' : r.issues.map((i) => i.message).join('; ');
};

test('trustedHostSetting: a local transport naming one of its own string settings', () => {
  assert.equal(problem(LOCAL), 'ok');
  assert.match(problem({ ...LOCAL, transport: 'http', allowedHosts: ['example.org'] }), /local transports only/);
  assert.match(problem({ ...LOCAL, trustedHostSetting: 'nope' }), /names no string setting "nope"/);
  assert.match(
    problem({ ...LOCAL, settings: [{ key: 'trustedHost', label: 'x', kind: 'number' }] }),
    /names no string setting/,
  );
  const { trustedHostSetting: _omit, ...plain } = LOCAL;
  assert.equal(problem(plain), 'ok', 'optional');
});

test('a host a user may name: a DNS name or an IPv4 address, never a pattern or a URL', () => {
  for (const ok of ['raspberrypi.local', 'receiver', '192.168.1.20', 'adsb-1.home.arpa'])
    assert.ok(isNameableHost(ok), ok);
  for (const bad of ['', '*.lan', 'http://receiver', 'receiver:8080', '999.1.1.1', 'a..b', '-x.lan', 'Receiver.LAN'])
    assert.equal(isNameableHost(bad), false, bad);
});
