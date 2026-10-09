import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardwareLines, scanLocalHardware } from './local-hardware.js';

/** A fake /sys and /dev laid out the way the Linux kernel lays them out. */
async function fakeMachine(opts: {
  rtl?: { usbId?: string; driver?: string; node?: boolean };
  serial?: { usbId: string; tty: string; byId: string; node?: boolean };
  dvbLoaded?: boolean;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-hw-'));
  const sys = path.join(root, 'sys');
  const dev = path.join(root, 'dev');
  const usb = path.join(sys, 'bus', 'usb', 'devices');
  await fs.mkdir(usb, { recursive: true });
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${text}\n`);
  };
  if (opts.rtl) {
    const [vendor, product] = (opts.rtl.usbId ?? '0bda:2838').split(':');
    const d = path.join(usb, '1-2');
    await write(path.join(d, 'idVendor'), vendor!);
    await write(path.join(d, 'idProduct'), product!);
    await write(path.join(d, 'busnum'), '1');
    await write(path.join(d, 'devnum'), '5');
    await write(path.join(d, 'product'), 'RTL2838UHIDIR');
    await write(path.join(d, 'serial'), '00000001');
    if (opts.rtl.driver) {
      const drivers = path.join(sys, 'bus', 'usb', 'drivers', opts.rtl.driver);
      await fs.mkdir(drivers, { recursive: true });
      await fs.mkdir(path.join(usb, '1-2:1.0'), { recursive: true });
      await fs.symlink(drivers, path.join(usb, '1-2:1.0', 'driver'));
    }
    if (opts.rtl.node !== false) await write(path.join(dev, 'bus', 'usb', '001', '005'), '');
  }
  if (opts.serial) {
    const [vendor, product] = opts.serial.usbId.split(':');
    const usbDevice = path.join(sys, 'devices', 'usb1', '1-3');
    const iface = path.join(usbDevice, '1-3:1.0');
    await write(path.join(usbDevice, 'idVendor'), vendor!);
    await write(path.join(usbDevice, 'idProduct'), product!);
    await write(path.join(usbDevice, 'product'), 'CP2102 USB to UART Bridge Controller');
    await fs.mkdir(iface, { recursive: true });
    await fs.mkdir(path.join(sys, 'class', 'tty', opts.serial.tty), { recursive: true });
    await fs.symlink(iface, path.join(sys, 'class', 'tty', opts.serial.tty, 'device'));
    if (opts.serial.node !== false) await write(path.join(dev, opts.serial.tty), '');
    await fs.mkdir(path.join(dev, 'serial', 'by-id'), { recursive: true });
    await fs.symlink(`../../${opts.serial.tty}`, path.join(dev, 'serial', 'by-id', opts.serial.byId));
  }
  if (opts.dvbLoaded) await fs.mkdir(path.join(sys, 'module', 'dvb_usb_rtl28xxu'), { recursive: true });
  return { sysRoot: sys, devRoot: dev };
}

test('hardware: nothing plugged in reads as "no RTL-SDR", and an empty machine is not an error', async () => {
  const roots = await fakeMachine({});
  const scan = await scanLocalHardware(roots);
  assert.deepEqual(scan, { rtlSdr: [], serial: [], dvbDriverLoaded: false });
  assert.deepEqual(hardwareLines(scan), [
    { id: 'rtl-sdr', status: 'not-configured', message: 'no RTL-SDR (RTL2832U) plugged in' },
  ]);
  // A machine without sysfs at all (not Linux) is the same: empty.
  assert.deepEqual(await scanLocalHardware({ sysRoot: '/nonexistent/sys', devRoot: '/nonexistent/dev' }), {
    rtlSdr: [],
    serial: [],
    dvbDriverLoaded: false,
  });
});

test('hardware: an RTL-SDR the DVB-T driver holds says so, with the blacklist line', async () => {
  const roots = await fakeMachine({ rtl: { driver: 'dvb_usb_rtl28xxu' }, dvbLoaded: true });
  const scan = await scanLocalHardware({ ...roots, canOpen: async () => true });
  assert.equal(scan.rtlSdr.length, 1);
  const r = scan.rtlSdr[0]!;
  assert.equal(r.usbId, '0bda:2838');
  assert.equal(r.devNode, path.join(roots.devRoot, 'bus', 'usb', '001', '005'));
  assert.equal(r.kernelDriver, 'dvb_usb_rtl28xxu');
  assert.equal(scan.dvbDriverLoaded, true);
  const [line] = hardwareLines(scan);
  assert.equal(line?.status, 'error');
  assert.match(line?.message ?? '', /apt install rtl-sdr .*blacklists .*modprobe -r dvb_usb_rtl28xxu/);
});

test('hardware: an RTL-SDR this user cannot open says how to fix it; one it can is present', async () => {
  const roots = await fakeMachine({ rtl: {} });
  const denied = await scanLocalHardware({ ...roots, canOpen: async () => false });
  assert.equal(denied.rtlSdr[0]?.access, 'no-permission');
  assert.match(hardwareLines(denied)[0]?.message ?? '', /udev rules .*rtl-sdr/);
  const ok = await scanLocalHardware({ ...roots, canOpen: async () => true });
  const line = hardwareLines(ok)[0];
  assert.equal(line?.status, 'running');
  assert.match(
    line?.message ?? '',
    /RTL2832U .*"RTL2838UHIDIR" \(0bda:2838\) on USB bus 1 device 5: present and openable/,
  );
});

test('hardware: other USB devices are not mistaken for an RTL-SDR', async () => {
  const roots = await fakeMachine({ rtl: { usbId: '046d:c52b' } });
  assert.deepEqual((await scanLocalHardware(roots)).rtlSdr, []);
});

test('hardware: a USB-serial port is named by its bridge, never assumed to be a T-Beam; dialout advice when closed', async () => {
  const serial = {
    usbId: '10c4:ea60',
    tty: 'ttyUSB0',
    byId: 'usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0',
  };
  const roots = await fakeMachine({ serial });
  const open = await scanLocalHardware({ ...roots, canOpen: async () => true });
  assert.equal(open.serial.length, 1);
  const s = open.serial[0]!;
  assert.equal(s.path, path.join(roots.devRoot, 'ttyUSB0'));
  assert.equal(s.usbId, '10c4:ea60');
  assert.equal(s.bridge, 'Silicon Labs CP210x USB-serial');
  const line = hardwareLines(open).find((l) => l.id === 'serial:ttyUSB0');
  assert.equal(line?.status, 'running');
  assert.doesNotMatch(line?.message ?? '', /T-Beam/i);
  const closed = await scanLocalHardware({ ...roots, canOpen: async () => false });
  assert.match(hardwareLines(closed).find((l) => l.id === 'serial:ttyUSB0')?.message ?? '', /dialout/);
});
