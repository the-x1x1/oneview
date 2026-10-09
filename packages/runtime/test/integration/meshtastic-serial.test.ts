import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { testing } from '@worldview/provider-sdk';
import { createProvider, PORT_POSITION } from '@worldview/provider-meshtastic-local';
import type { Observation } from '@worldview/world-model';
import { createLocalAccess } from '../../src/support/provider-storage.js';
import { ptyDevice } from '../helpers/pty-device.js';
import {
  concat,
  deviceMetrics,
  fromRadio,
  nodeInfo,
  packet,
  position,
  user,
} from '../../../../providers/meshtastic-local/test/encode.js';

/**
 * A T-Beam over USB, simulated (docs/cyberdeck M4): a pseudo-terminal stands in for
 * /dev/ttyUSB0, and the runtime's own serial transport — the real `stty` line set-up, the
 * real reads and writes — carries the Meshtastic stream to the real provider. The node, its
 * neighbours and every place here are invented. Not hardware evidence: that is check H10.
 */
const onLinux = process.platform === 'linux';
const START = Date.parse('2026-10-08T20:00:00Z');
const NOW = START / 1000;
const OWN = 0x11223344;
const OTHER = 0x55667788;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

test(
  'a Meshtastic node on a serial port: own GPS fix, NO FIX, other nodes kept apart, unplugged',
  { skip: !onLinux },
  async () => {
    const dev = await ptyDevice();
    const resolved = realpathSync(dev.path);
    // The runtime's real serial transport, on an otherwise empty fixture host.
    const host = createLocalAccess({
      allowedHosts: ['127.0.0.1'],
      serial: { isAllowedPath: (p) => p === dev.path, isAllowedDevice: (d) => d === resolved },
    });
    const local = Object.assign(new testing.FixtureLocalAccess(), { openSerialStream: host.openSerialStream! });
    const ctx = testing.createFixtureContext({
      providerId: 'meshtastic-local',
      clock: new testing.VirtualClock(START),
      settings: { serialPort: dev.path } as never,
      local,
    });
    const p = createProvider({ flushIntervalMs: 0 });
    await p.initialize(ctx);
    await p.start();
    const batches: Array<{ observations: Observation[]; snapshot: boolean }> = [];
    const abort = new AbortController();
    try {
      await p.subscribe({ signal: abort.signal }, (observations, meta) =>
        batches.push({ observations, snapshot: meta?.snapshot ?? false }),
      );
      // The provider asks the node for its node list, over the serial line.
      await until(() => dev.received.some((b) => b[0] === 0x94 && b[1] === 0xc3 && b[4] === 0x18), 'want_config');

      // Debug log text first (a node prints it on the same line), then the node list: this
      // node (a T-Beam with a 3D GPS fix) and a neighbour with a fix of its own.
      dev.send(new TextEncoder().encode('DEBUG | 20:00:00 [GPS] fix ok\r\n'));
      dev.send(
        concat(
          fromRadio.myInfo(OWN),
          fromRadio.nodeInfo(
            nodeInfo({
              num: OWN,
              user: user({ longName: 'Deck', shortName: 'DCK', hwModel: 4 }),
              position: position({
                lat: 21.3001,
                lon: -157.8101,
                alt: 12,
                source: 2,
                fixTime: NOW - 10,
                fixType: 3,
                sats: 8,
                hdop: 120,
                accuracyMm: 3000,
              }),
              device: deviceMetrics({ battery: 76, voltage: 3.92 }),
            }),
          ),
          fromRadio.nodeInfo(
            nodeInfo({
              num: OTHER,
              user: user({ longName: 'Ridge' }),
              position: position({ lat: 21.4, lon: -157.9, source: 2, fixTime: NOW - 30, fixType: 3, sats: 11 }),
            }),
          ),
          fromRadio.configComplete(7),
        ),
      );
      await until(() => batches.flatMap((b) => b.observations).length >= 2, 'two nodes');
      const all = batches.flatMap((b) => b.observations);
      const own = all.find((o) => o.externalId === '!11223344')!;
      const other = all.find((o) => o.externalId === '!55667788')!;
      assert.equal(own.payload['thisNode'], true);
      assert.deepEqual(own.position, { latitude: 21.3001, longitude: -157.8101, altitudeM: 12 });
      assert.equal(own.provenance.sourceRef, `serial://${dev.path}`);
      assert.equal(own.observedAt, new Date((NOW - 10) * 1000).toISOString(), 'dated by its GPS fix');
      assert.deepEqual(own.payload['ownFix'], {
        kind: 'gps',
        source: 'own GPS',
        fixAt: new Date((NOW - 10) * 1000).toISOString(),
        accuracyM: 3.6,
        satellites: 8,
        fixType: '3D',
        hdop: 1.2,
      });
      assert.equal(own.quality.positionAccuracyM, 3.6);
      assert.equal(other.payload['thisNode'], false, 'a neighbour is never "this node"');
      assert.equal(other.payload['ownFix'], null);
      let h = await p.health();
      assert.equal(h.status, 'LIVE');
      assert.match(
        h.message!,
        /this node: Deck \(LilyGO T-Beam\), battery 76%, GPS fix \(3D, 8 satellites\), 10 s old, ±3\.6 m$/,
      );

      // A broken frame is counted and skipped; the stream carries on.
      const invalidBefore = p.stats.invalid;
      dev.send(Uint8Array.from([0x94, 0xc3, 0x00, 0x03, 0x0a, 0xff, 0xff]));
      await until(() => p.stats.invalid > invalidBefore, 'the broken frame');

      // The GPS loses its fix: this node reports no position. It comes off the map — the whole
      // set is sent again without it — and the neighbour's fix is never used in its place.
      const before = batches.length;
      dev.send(
        fromRadio.packet(
          packet({ from: OWN, portnum: PORT_POSITION, payload: position({ lat: 0, lon: 0, source: 2 }), rxTime: NOW }),
        ),
      );
      await until(() => batches.length > before, 'the redraw');
      const redraw = batches[batches.length - 1]!;
      assert.equal(redraw.snapshot, true);
      assert.deepEqual(
        redraw.observations.map((o) => o.externalId),
        ['!55667788'],
      );
      h = await p.health();
      assert.match(h.message!, /this node: Deck \(LilyGO T-Beam\), battery 76%, NO FIX$/);

      // Unplugged: OFFLINE, said plainly.
      await dev.unplug();
      await until(() => batches.length > before + 1, 'the drop');
      h = await p.health();
      assert.equal(h.status, 'OFFLINE');
      assert.match(h.message!, /went away/);
    } finally {
      abort.abort();
      await p.stop();
      await dev.unplug();
    }
  },
);
