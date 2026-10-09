import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createProvider as createReadsb } from '@worldview/provider-readsb-local';
import { systemClock, type WorldObject } from '@worldview/world-model';
import { settle, startRuntime } from '../helpers/harness.js';

/**
 * A real decoder, end to end (docs/cyberdeck M3). Skipped unless a readsb is named:
 *
 *   WORLDVIEW_READSB_API=http://127.0.0.1:8042/?all      its HTTP API (--net-api-port 8042)
 *   WORLDVIEW_READSB_RAW=127.0.0.1:30001                 optional: its raw input (--net-ri-port),
 *                                                        to feed the textbook frames below
 *
 * The runtime's own HTTP client, host allowlist and detection probe poll the decoder; the test
 * reads the aircraft back through `world.query`. With WORLDVIEW_READSB_RAW the RF side is
 * simulated (frames from "The 1090 MHz Riddle", fed over TCP) and everything from the decoder
 * on is real. Without it, against a receiver with an antenna, it checks whatever is overhead.
 */
const API = process.env['WORLDVIEW_READSB_API'];
const RAW = process.env['WORLDVIEW_READSB_RAW'];

/** KLM1023 identification; an even/odd airborne position pair for 40621D; a velocity for 485020. */
const FRAMES = [
  '8D4840D6202CC371C32CE0576098',
  '8D40621D58C382D690C8AC2863A7',
  '8D40621D58C386435CC412692AD6',
  '8D485020994409940838175B284F',
];

async function feed(rounds: number): Promise<void> {
  const [host, port] = RAW!.split(':');
  const socket = net.createConnection({ host: host!, port: Number(port) });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  for (let i = 0; i < rounds; i++)
    for (const f of FRAMES) {
      socket.write(`*${f};\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
  socket.end();
}

test(
  'readsb (real decoder): its aircraft reach the world model with the receiver as their source',
  { skip: !API },
  async () => {
    const h = await startRuntime({
      providerInstances: [createReadsb()],
      // The real network stack: the decoder is on loopback.
      fetchImpl: globalThis.fetch.bind(globalThis),
      // Real time: the decoder's `now` is now.
      clock: systemClock as never,
    });
    try {
      await h.client.request('sources.settings.set', { providerId: 'readsb-local', settings: { endpoint: API! } });
      if (RAW) await feed(6);
      let aircraft: WorldObject[] = [];
      for (let i = 0; i < 20 && aircraft.length === 0; i++) {
        await h.client.request('sources.refresh', { providerId: 'readsb-local' }).catch(() => undefined);
        await settle(8);
        aircraft = (await h.client.request('world.query', { objectTypes: ['aircraft'], limit: 50 })).items;
        if (aircraft.length === 0) await new Promise((r) => setTimeout(r, 500));
      }
      const sources = await h.client.request('sources.list', undefined);
      const readsb = sources.find((s) => s.providerId === 'readsb-local');
      if (!RAW) {
        // A real receiver: a healthy source is the claim; aircraft only if any are in range.
        assert.ok(readsb && readsb.health.status !== 'ERROR', JSON.stringify(readsb));
        return;
      }
      const pos = aircraft.find((a) => a.id.includes('40621d'));
      assert.ok(pos, `40621D not in the world: ${aircraft.map((a) => a.id).join(', ')} — ${JSON.stringify(readsb)}`);
      assert.ok(pos.position, 'it has the decoded position');
      // The Riddle's two answers for this pair: odd message latest, or even latest (readsb's local
      // decoding of later messages gives the second).
      const reference = [
        [52.26578, 3.938913],
        [52.2572, 3.91937],
      ];
      const { latitude, longitude } = pos.position!;
      assert.ok(
        reference.some(([lat, lon]) => Math.abs(latitude - lat!) < 0.0005 && Math.abs(longitude - lon!) < 0.0005),
        `${latitude}, ${longitude}`,
      );
      assert.ok(Math.abs((pos.position!.altitudeM ?? 0) - 38000 * 0.3048) < 1, String(pos.position!.altitudeM));
      // Provenance: this computer's receiver, with the endpoint it came from.
      assert.equal(pos.provenance.providerId, 'readsb-local');
      assert.equal(pos.provenance.origin, 'local');
      assert.equal(pos.provenance.sourceRef, API);
      assert.ok(pos.sourceRefs.every((r) => r.providerId === 'readsb-local'));
      // KLM1023 and 485020 sent no position: a receiver hears such aircraft all the time, and the
      // provider leaves them out of the map rather than inventing a place for them.
      assert.equal(
        aircraft.find((a) => a.id.includes('4840d6')),
        undefined,
      );
    } finally {
      await h.dispose();
    }
  },
);
