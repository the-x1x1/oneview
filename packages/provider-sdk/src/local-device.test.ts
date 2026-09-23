import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from './health.js';
import {
  LocalDeviceDetector,
  isLoopbackHost,
  numberSetting,
  resolveLocalEndpoint,
  stringSetting,
} from './local-device.js';
import type { ProviderLocalAccess } from './provider.js';

const opts = { label: 'station address', trustedHostSetting: 'host' };

test('a local endpoint is loopback, or exactly the one host the user named', () => {
  assert.deepEqual(resolveLocalEndpoint('http://127.0.0.1/v1/x', opts), {
    ok: true,
    url: 'http://127.0.0.1/v1/x',
    host: '127.0.0.1',
    trusted: false,
  });
  const lan = resolveLocalEndpoint('http://192.168.1.50/v1/current_conditions', opts);
  assert.equal(lan.ok, false);
  assert.match(!lan.ok ? lan.reason : '', /^station address host "192\.168\.1\.50" is not loopback; set host to/);
  assert.deepEqual(
    resolveLocalEndpoint('http://192.168.1.50/v1/current_conditions', { ...opts, trustedHost: '192.168.1.50' }),
    {
      ok: true,
      url: 'http://192.168.1.50/v1/current_conditions',
      host: '192.168.1.50',
      trusted: true,
    },
  );
  assert.equal(resolveLocalEndpoint('http://192.168.1.51/', { ...opts, trustedHost: '192.168.1.50' }).ok, false);
  assert.match((resolveLocalEndpoint('nope', opts) as { reason: string }).reason, /not a valid URL/);
  assert.match((resolveLocalEndpoint('file:///etc/passwd', opts) as { reason: string }).reason, /http or https/);
  assert.match((resolveLocalEndpoint('http://a:b@127.0.0.1/', opts) as { reason: string }).reason, /credentials/);
  assert.equal(isLoopbackHost('127.9.9.9'), true);
  assert.equal(isLoopbackHost('localhost.example'), false);
});

test('settings: strings trimmed (hosts lower-cased), numbers bounded', () => {
  assert.equal(stringSetting({ host: '  WLL.Local ' }, 'host', { host: true }), 'wll.local');
  assert.equal(stringSetting({ host: '   ' }, 'host'), undefined);
  assert.equal(stringSetting({ host: 7 }, 'host'), undefined);
  assert.equal(numberSetting({ lat: 21.3 }, 'lat', -90, 90), 21.3);
  assert.equal(numberSetting({ lat: '21.3' }, 'lat', -90, 90), 21.3);
  assert.equal(numberSetting({ lat: 91 }, 'lat', -90, 90), undefined);
  assert.equal(numberSetting({ lat: '' }, 'lat', -90, 90), undefined);
  assert.equal(numberSetting({}, 'lat', -90, 90), undefined);
});

test('detection: probe once, back off when nothing answers, probe again after a transport failure', async () => {
  let reachable = false;
  let probes = 0;
  const local: ProviderLocalAccess = {
    readGrantedFile: async () => new Uint8Array(),
    probeLocal: async () => {
      probes++;
      return reachable ? { reachable: true, status: 200 } : { reachable: false };
    },
  };
  const d = new LocalDeviceDetector({ what: 'WeatherLink Live', backoffMs: 30_000 });
  const url = 'http://192.168.1.50/v1/current_conditions';
  await assert.rejects(d.ensure(local, url, 0, 2000), (e: unknown) => {
    assert.ok(e instanceof ProviderError && e.code === 'OFFLINE');
    assert.equal(e.message, `WeatherLink Live not detected at ${url}`);
    assert.equal(e.retryAfterMs, 30_000);
    return true;
  });
  assert.equal(d.state, 'not-detected');
  reachable = true;
  await assert.rejects(d.ensure(local, url, 10_000, 2000), /not detected/, 'inside the back-off: no probe');
  assert.equal(probes, 1);
  assert.deepEqual(await d.ensure(local, url, 30_000, 2000), { newlyDetected: true, status: 200 });
  assert.deepEqual(await d.ensure(local, url, 31_000, 2000), { newlyDetected: false });
  assert.equal(probes, 2, 'a detected device is not probed before every poll');
  d.noteFailure(new ProviderError('MALFORMED', 'bad json'));
  assert.equal(d.state, 'detected', 'a bad answer is still an answer');
  d.noteFailure(new ProviderError('TIMEOUT', 'timed out'));
  assert.equal(d.state, 'unknown');
  await d.ensure(local, url, 32_000, 2000);
  assert.equal(probes, 3);
  d.reset();
  assert.equal(d.state, 'unknown');
});
