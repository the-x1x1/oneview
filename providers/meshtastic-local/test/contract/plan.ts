import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider, PORT_POSITION, PORT_TELEMETRY, PORT_TEXT_MESSAGE } from '../../src/index.js';
import {
  concat,
  deviceMetrics,
  environment,
  fromRadio,
  nodeInfo,
  packet,
  position,
  telemetry,
  user,
} from '../encode.js';

const AT = Date.parse('2026-10-05T08:00:00.000Z') / 1000;

/**
 * Subscription over a byte stream: the checklist opens the provider's fixture stream and feeds
 * it what a node sends after `want_config_id` — its own number, its node list, the end of the
 * list — and then three packets heard on the mesh: a position, telemetry and a text message
 * (never read). Every node, name, place and reading is invented.
 */
const stream = concat(
  fromRadio.myInfo(0x0a0b0c0d),
  fromRadio.nodeInfo(
    nodeInfo({
      num: 0x0a0b0c0d,
      user: user({ longName: 'Base station', shortName: 'BASE' }),
      position: position({ lat: 21.3069, lon: -157.8583, alt: 12, fixTime: AT - 120 }),
      device: deviceMetrics({ battery: 101, voltage: 4.9 }),
    }),
  ),
  fromRadio.nodeInfo(nodeInfo({ num: 0x11111111, user: user({ longName: 'No fix yet' }) })),
  fromRadio.configComplete(1),
  fromRadio.packet(
    packet({
      from: 0xa1b2c3d4,
      portnum: PORT_POSITION,
      payload: position({ lat: 21.4, lon: -157.9, alt: 610, fixTime: AT - 30 }),
      rxTime: AT - 29,
      snr: 5.5,
      rssi: -97,
    }),
  ),
  fromRadio.packet(
    packet({
      from: 0xa1b2c3d4,
      portnum: PORT_TELEMETRY,
      payload: telemetry({ device: deviceMetrics({ battery: 72 }), environment: environment({ temperature: 19.5 }) }),
    }),
  ),
  fromRadio.packet(
    packet({
      from: 0xa1b2c3d4,
      portnum: PORT_TEXT_MESSAGE,
      payload: [...new TextEncoder().encode('see you at the ridge')],
    }),
  ),
);

export const plan = definePlan({
  providerDir: 'meshtastic-local',
  create: () => createProvider({ flushIntervalMs: 0 }),
  clockStartMs: AT * 1000,
  fixtures: {
    // Not used by a subscription provider, but required by the plan shape.
    normal: () => ({ status: 200, body: '' }),
  },
  // Cut where a TCP read might: inside a frame.
  subscription: { bytes: [stream.subarray(0, 40), stream.subarray(40)], minObservations: 2 },
  expectations: {
    objectTypes: ['sensor'],
    minObservations: 2,
    verify: (obs) => {
      const base = obs.find((o) => o.externalId === '!0a0b0c0d');
      const ridge = obs.filter((o) => o.externalId === '!a1b2c3d4').at(-1);
      if (!base || !ridge) return 'the base station or the ridge node is missing';
      if (obs.some((o) => o.externalId === '!11111111')) return 'a node without a position was drawn';
      if (base.payload['thisNode'] !== true || base.payload['externalPower'] !== true)
        return 'the base station is wrong';
      if (ridge.position?.latitude !== 21.4 || ridge.position.altitudeM !== 610) return 'the ridge position is wrong';
      if (ridge.payload['batteryPct'] !== 72 || ridge.payload['temperatureC'] !== 19.5) return 'telemetry not merged';
      if (ridge.provenance.origin !== 'local') return 'origin should be local';
      if (ridge.provenance.sourceRef !== 'tcp://127.0.0.1:4403') return `sourceRef ${ridge.provenance.sourceRef}`;
      if (JSON.stringify(obs).includes('see you')) return 'the text message was read';
      return undefined;
    },
  },
});
