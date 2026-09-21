import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnFn, SpawnedProcess } from '@worldview/camera-gateway';
import { startRuntime } from '../helpers/harness.js';

/**
 * The optional go2rtc sidecar (ADR-009) composed into the runtime: it exists in every
 * build so `camera.status` can answer honestly, but it is inert until the operator
 * supplies a binary, and it is never downloaded, discovered or started on their behalf.
 */

interface Spawned { command: string; args: string[] }

function recordingSpawn(): { fn: SpawnFn; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const fn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const listeners: Array<(code: number | null, signal: string | null) => void> = [];
    const proc: SpawnedProcess = {
      pid: 4242,
      kill: () => { for (const l of listeners) l(0, null); return true; },
      on: (event: string, listener: (...a: never[]) => void) => {
        if (event === 'exit') listeners.push(listener as (code: number | null, signal: string | null) => void);
        return proc;
      },
    } as unknown as SpawnedProcess;
    return proc;
  };
  return { fn, calls };
}

test('go2rtc: unconfigured is the default — nothing is spawned and the status says so', async () => {
  const spawn = recordingSpawn();
  const h = await startRuntime({ spawnImpl: spawn.fn });
  try {
    assert.equal(h.runtime.core.settings.get().cameras.go2rtcPath, '', 'no path out of the box');
    assert.equal(h.runtime.core.go2rtc.configured(), false);
    assert.equal(await h.runtime.core.ensureGo2rtc(), false, 'ensure is a no-op when unconfigured');
    assert.equal(spawn.calls.length, 0, 'no child process was started');

    const diagnostics = await h.client.request('diagnostics.get', undefined);
    const entry = diagnostics.sidecars.find((s) => s.id === 'go2rtc');
    assert.ok(entry, 'the sidecar is reported so its state is visible in Diagnostics');
    assert.equal(entry.status, 'not-configured');
  } finally { await h.dispose(); }
});

test('go2rtc: an RTSP camera without the sidecar is refused, not silently dropped', async () => {
  const spawn = recordingSpawn();
  const h = await startRuntime({ spawnImpl: spawn.fn });
  try {
    await assert.rejects(
      () => h.client.request('camera.register', { name: 'Yard', url: 'rtsp://10.0.0.9:554/stream' }),
      (err: Error) => /go2rtc|sidecar|UNSUPPORTED_SCHEME/i.test(err.message),
      'the error names the missing sidecar',
    );
    assert.equal(spawn.calls.length, 0);
    assert.deepEqual(await h.client.request('camera.list', undefined), []);
  } finally { await h.dispose(); }
});

test('go2rtc: a configured path that does not exist reports not-configured and never spawns', async () => {
  const spawn = recordingSpawn();
  const h = await startRuntime({ spawnImpl: spawn.fn });
  try {
    await h.client.request('settings.set', { cameras: { go2rtcPath: '/opt/worldview/go2rtc-does-not-exist' } });
    assert.equal(h.runtime.core.go2rtc.configured(), true, 'the setting is applied without a restart');
    assert.equal(await h.runtime.core.ensureGo2rtc(), false);
    assert.equal(spawn.calls.length, 0, 'a missing binary is detected before spawning');
    assert.match(h.runtime.core.go2rtc.status().message ?? '', /not found/i);
  } finally { await h.dispose(); }
});

test('go2rtc: settings reject a relative binary path', async () => {
  const h = await startRuntime({});
  try {
    await assert.rejects(
      () => h.client.request('settings.set', { cameras: { go2rtcPath: 'go2rtc' } }),
      /absolute/i,
      'a relative path could resolve to an attacker-planted binary',
    );
    assert.equal(h.runtime.core.settings.get().cameras.go2rtcPath, '');
  } finally { await h.dispose(); }
});

test('go2rtc: clearing the path stops the sidecar and returns it to not-configured', async () => {
  const spawn = recordingSpawn();
  const h = await startRuntime({ spawnImpl: spawn.fn });
  try {
    await h.client.request('settings.set', { cameras: { go2rtcPath: '/opt/worldview/go2rtc' } });
    assert.equal(h.runtime.core.go2rtc.status().status, 'stopped', 'configured but not running');
    await h.client.request('settings.set', { cameras: { go2rtcPath: '' } });
    assert.equal(h.runtime.core.go2rtc.configured(), false);
    assert.equal(h.runtime.core.go2rtc.status().status, 'not-configured');
  } finally { await h.dispose(); }
});
