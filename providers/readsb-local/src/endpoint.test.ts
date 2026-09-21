import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, parseReadsbSettings, resolveEndpoint } from './endpoint.js';
import { DEFAULT_READSB_ENDPOINT } from './manifest.js';

test('resolveEndpoint: default is loopback aircraft.json', () => {
  const r = resolveEndpoint({});
  assert.deepEqual(r, { ok: true, url: DEFAULT_READSB_ENDPOINT, host: '127.0.0.1', trusted: false });
});

test('resolveEndpoint: loopback variants accepted; non-loopback refused unless trustedHost matches exactly', () => {
  assert.equal(resolveEndpoint({ endpoint: 'http://localhost:8080/data/aircraft.json' }).ok, true);
  assert.equal(resolveEndpoint({ endpoint: 'http://127.0.0.5/data/aircraft.json' }).ok, true);
  assert.equal(resolveEndpoint({ endpoint: 'http://[::1]:8080/data/aircraft.json' }).ok, true);
  const lan = resolveEndpoint({ endpoint: 'http://piaware.lan/data/aircraft.json' });
  assert.equal(lan.ok, false);
  assert.match(!lan.ok ? lan.reason : '', /not loopback; set trustedHost to "piaware.lan"/);
  const trusted = resolveEndpoint({ endpoint: 'http://PiAware.lan/data/aircraft.json', trustedHost: 'piaware.lan' });
  assert.deepEqual(trusted, { ok: true, url: 'http://piaware.lan/data/aircraft.json', host: 'piaware.lan', trusted: true });
  const other = resolveEndpoint({ endpoint: 'http://10.0.0.7/data/aircraft.json', trustedHost: 'piaware.lan' });
  assert.equal(other.ok, false, 'trustedHost must equal the endpoint host');
});

test('resolveEndpoint: rejects bad URLs, non-http schemes and embedded credentials', () => {
  assert.match((resolveEndpoint({ endpoint: 'not a url' }) as { reason: string }).reason, /not a valid URL/);
  assert.match((resolveEndpoint({ endpoint: 'ftp://127.0.0.1/aircraft.json' }) as { reason: string }).reason, /must use http or https/);
  assert.match((resolveEndpoint({ endpoint: 'http://user:pw@127.0.0.1/aircraft.json' }) as { reason: string }).reason, /must not embed credentials/);
});

test('isLoopbackHost / parseReadsbSettings', () => {
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('127.255.0.1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('128.0.0.1'), false);
  assert.equal(isLoopbackHost('localhost.evil'), false);
  assert.deepEqual(parseReadsbSettings({ endpoint: ' http://127.0.0.1/x ', trustedHost: ' PiAware.LAN ' }), { endpoint: 'http://127.0.0.1/x', trustedHost: 'piaware.lan' });
  assert.deepEqual(parseReadsbSettings({ endpoint: 42, trustedHost: '' }), {});
});
