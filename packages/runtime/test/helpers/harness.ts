import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import {
  createInProcessClient,
  createWorldRuntime,
  type ComposedWorldRuntime,
  type WorldRuntimeDeps,
} from '../../src/index.js';
import type { HostBridge } from '../../src/deps.js';
import type { WorldClient } from '@worldview/ipc-contract';

/** Shared setup for the runtime integration suites: a temp data dir, a fake network and a fake shell. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export function fixture(...parts: string[]): string {
  return path.join(repoRoot, 'fixtures', ...parts);
}

export async function readFixture(...parts: string[]): Promise<string> {
  return fs.readFile(fixture(...parts), 'utf8');
}

export interface RecordedFetch {
  impl: typeof fetch;
  calls: string[];
}

/** A fetch that answers from a URL → body table and records every call. */
export function tableFetch(table: Record<string, () => Response | Promise<Response>>): RecordedFetch {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, responder] of Object.entries(table)) {
      if (url.startsWith(prefix)) return responder();
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

/** A fetch that always fails, so a test can prove nothing reached the network. */
export function offlineFetch(calls: { count: number }): typeof fetch {
  return (async () => {
    calls.count++;
    throw new Error('network is off (WORLDVIEW_NETWORK=off)');
  }) as typeof fetch;
}

export interface FakeHost extends HostBridge {
  /** Files the next pickOpenFile / pickSaveFile call returns, in order. */
  openQueue: string[];
  saveQueue: string[];
  notifications: Array<{ title: string; body: string }>;
  externalUrls: string[];
}

export function fakeHost(): FakeHost {
  const host: FakeHost = {
    openQueue: [],
    saveQueue: [],
    notifications: [],
    externalUrls: [],
    pickOpenFile: async () => {
      const next = host.openQueue.shift();
      return next ? { path: next } : { cancelled: true };
    },
    pickSaveFile: async () => {
      const next = host.saveQueue.shift();
      return next ? { path: next } : { cancelled: true };
    },
    openExternal: async (url) => {
      host.externalUrls.push(url);
      return true;
    },
    showNotification: (n) => {
      host.notifications.push(n);
    },
    appPaths: () => ({}),
  };
  return host;
}

export interface Harness {
  runtime: ComposedWorldRuntime;
  client: WorldClient;
  clock: testing.VirtualClock;
  host: FakeHost;
  dataDir: string;
  dispose(): Promise<void>;
}

export async function startRuntime(deps: WorldRuntimeDeps & { tmpPrefix?: string } = {}): Promise<Harness> {
  const dataDir = deps.dataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), deps.tmpPrefix ?? 'worldview-runtime-')));
  const clock =
    (deps.clock as testing.VirtualClock | undefined) ??
    new testing.VirtualClock(Date.parse('2026-09-21T08:05:00.000Z'));
  const host = (deps.host as FakeHost | undefined) ?? fakeHost();
  const runtime = await createWorldRuntime({
    manualScheduling: true,
    disableReachabilityProbe: true,
    flushDelayMs: 0,
    ...deps,
    dataDir,
    clock,
    host,
  });
  await runtime.start();
  return {
    runtime,
    client: createInProcessClient(runtime, 'test-client'),
    clock,
    host,
    dataDir,
    dispose: async () => {
      await runtime.stop();
      if (!deps.dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Wait for queued asynchronous work (history writes, projections) to settle. */
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
