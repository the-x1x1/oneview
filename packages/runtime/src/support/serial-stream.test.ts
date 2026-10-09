import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@worldview/provider-sdk';
import { SERIAL_PATH, openSerialStream } from './serial-stream.js';
import { ptyDevice } from '../../test/helpers/pty-device.js';

const caps = { maxBytesPerSecond: 256 * 1024, maxWriteBytes: 1024, maxWritesPerMinute: 60 };
const onLinux = process.platform === 'linux';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await wait(20);
}

test('serial: only a named USB serial device, a real baud rate, on Linux', async () => {
  for (const p of [
    '/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0',
    '/dev/ttyUSB0',
    '/dev/ttyACM12',
  ])
    assert.ok(SERIAL_PATH.test(p), p);
  for (const p of [
    '/dev/sda',
    '/dev/ttyS0',
    '/dev/ttyUSB0/../sda',
    '/etc/passwd',
    'ttyUSB0',
    '/dev/serial/by-id/../../sda',
    '',
  ])
    assert.ok(!SERIAL_PATH.test(p), p);
  const events = { onData: () => undefined };
  await assert.rejects(
    openSerialStream({ path: '/dev/sda', baudRate: 115200 }, events, { ...caps, platform: 'linux' }),
    (e: ProviderError) => e.code === 'HOST_NOT_ALLOWED',
  );
  await assert.rejects(
    openSerialStream({ path: '/dev/ttyUSB0', baudRate: 12345 }, events, { ...caps, platform: 'linux' }),
    (e: ProviderError) => e.code === 'HOST_NOT_ALLOWED' && /baud/.test(e.message),
  );
  await assert.rejects(
    openSerialStream({ path: '/dev/ttyUSB0', baudRate: 115200 }, events, { ...caps, platform: 'win32' }),
    (e: ProviderError) => e.code === 'UNSUPPORTED',
  );
  // Nothing plugged in: OFFLINE, retried later.
  await assert.rejects(
    openSerialStream({ path: '/dev/ttyUSB97', baudRate: 115200 }, events, { ...caps, platform: 'linux' }),
    (e: ProviderError) => e.code === 'OFFLINE' && /nothing is plugged in/.test(e.message) && e.retryable,
  );
});

test(
  'serial: a pseudo-terminal device — bytes both ways, the real stty set-up, unplugging reported',
  { skip: !onLinux },
  async () => {
    const dev = await ptyDevice();
    const got: number[] = [];
    let closedWhy: string | undefined;
    let error: ProviderError | undefined;
    const handle = await openSerialStream(
      // A pty is not a USB serial path: the path rules are tested above and let through here.
      { path: dev.path, baudRate: 115200 },
      {
        onData: (b) => got.push(...b),
        onClose: (why) => (closedWhy = why),
        onError: (e) => (error = e),
      },
      // The real stty, on the pty.
      { ...caps, platform: 'linux', isAllowedPath: () => true, isAllowedDevice: () => true },
    );
    try {
      dev.send(Uint8Array.from([0x94, 0xc3, 0x00, 0x02, 0x10, 0x01]));
      await until(() => got.length >= 6);
      assert.deepEqual(
        got,
        [0x94, 0xc3, 0x00, 0x02, 0x10, 0x01],
        'what the device sent arrives byte for byte (raw: no echo, no translation)',
      );
      assert.equal(handle.write(Uint8Array.from([0x94, 0xc3, 0x00, 0x01, 0x18])), true);
      await until(() => dev.received.length > 0);
      assert.deepEqual([...dev.received.flatMap((r) => [...r])], [0x94, 0xc3, 0x00, 0x01, 0x18]);
      assert.equal(handle.write(new Uint8Array(2000)), false, 'a write over the cap is refused');
      await dev.unplug();
      await until(() => closedWhy !== undefined);
      assert.equal(closedWhy, 'the device went away');
      assert.equal(handle.write(Uint8Array.from([1])), false, 'nothing is written after it went away');
      if (error) assert.equal(error.code, 'OFFLINE', 'a failed read is reported as the device gone');
    } finally {
      handle.close();
      await dev.unplug();
    }
  },
);

test(
  'serial: closing it ourselves reports "closed" on a later turn, not inside close()',
  { skip: !onLinux },
  async () => {
    const dev = await ptyDevice();
    const reasons: string[] = [];
    const handle = await openSerialStream(
      { path: dev.path, baudRate: 115200 },
      { onData: () => undefined, onClose: (why) => reasons.push(String(why)) },
      { ...caps, platform: 'linux', isAllowedPath: () => true, isAllowedDevice: () => true },
    );
    try {
      assert.equal(handle.write(Uint8Array.from([1, 2, 3])), true);
      handle.close();
      assert.deepEqual(reasons, [], 'not while the caller is still inside close()');
      await until(() => reasons.length > 0);
      assert.deepEqual(reasons, ['closed']);
      assert.equal(handle.write(Uint8Array.from([1])), false);
    } finally {
      await dev.unplug();
    }
  },
);
