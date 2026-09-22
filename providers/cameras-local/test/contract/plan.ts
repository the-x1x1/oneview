import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider } from '../../src/index.js';

/**
 * cameras-local is settings-driven and never touches the network, so the "fixture"
 * is the settings object (the list the runtime writes from the gateway registry).
 * profile 'local' makes the checklist assert offline continuity instead of network
 * failure modes.
 */
export const SETTINGS = {
  cameras: [
    {
      cameraId: '3f2a9c1e7b04',
      name: 'Garage door',
      position: { latitude: 48.1374, longitude: 11.5755, altitudeM: 520 },
      headingDegrees: 270,
      gateway: 'direct',
      kind: 'mjpeg',
    },
    {
      cameraId: 'a1b2c3d4e5f6',
      name: 'Roof (RTSP via go2rtc)',
      position: { latitude: 48.138, longitude: 11.576 },
      headingDegrees: 45,
      gateway: 'go2rtc',
      kind: 'rtsp',
    },
    { cameraId: '0f0e0d0c0b0a', name: 'Still cam without position', kind: 'snapshot' },
    { cameraId: 'not-a-camera-id', name: 'invalid entry (dropped)' },
    { cameraId: '3f2a9c1e7b04', name: 'duplicate id (dropped)' },
    'garbage',
  ],
};

export const plan = definePlan({
  providerDir: 'cameras-local',
  profile: 'local',
  create: () => createProvider(),
  settings: SETTINGS,
  fixtures: {
    // Never consulted: the provider issues no HTTP requests (asserted by the Offline check).
    normal: () => ({ status: 404, body: '' }),
  },
  expectations: {
    objectTypes: ['camera'],
    minObservations: 3,
    expectObjectIds: [
      'camera:cameras-local:3f2a9c1e7b04',
      'camera:cameras-local:a1b2c3d4e5f6',
      'camera:cameras-local:0f0e0d0c0b0a',
    ],
    verify: (obs) => {
      if (obs.length !== 3) return `expected 3 cameras (2 invalid entries dropped), got ${obs.length}`;
      const garage = obs.find((o) => o.externalId === '3f2a9c1e7b04');
      if (!garage) return 'garage camera missing';
      if (garage.position?.latitude !== 48.1374 || garage.position.altitudeM !== 520) return 'position not carried';
      if (garage.payload['headingDegrees'] !== 270 || garage.payload['gateway'] !== 'direct')
        return 'heading/gateway not carried';
      const media = garage.payload['media'];
      if (!Array.isArray(media) || media.length !== 2) return 'expected snapshot + stream media refs';
      if ((media[0] as { ref?: unknown }).ref !== 'camera:3f2a9c1e7b04') return 'media ref must be camera:<cameraId>';
      if (garage.provenance.origin !== 'local') return 'origin must be local';
      if (JSON.stringify(obs).includes('http')) return 'observations must never contain URLs';
      const still = obs.find((o) => o.externalId === '0f0e0d0c0b0a');
      if (still?.position !== undefined || !still?.quality.flags?.includes('position-unknown'))
        return 'positionless camera must be flagged';
      if (!Array.isArray(still.payload['media']) || still.payload['media'].length !== 1)
        return 'still cameras get a snapshot ref only';
      if (obs.some((o) => o.rawPayloadHash)) return 'raw retention is not allowed for this provider';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 3 ? undefined : `objectCount ${h.objectCount}`),
  },
});
