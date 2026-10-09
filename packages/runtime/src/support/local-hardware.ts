import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * What radio hardware is plugged into this computer, read from Linux sysfs and /dev only
 * (docs/cyberdeck M3/M4). Nothing is opened, claimed or configured, nothing on any network is
 * asked, and nothing runs on a timer: Diagnostics calls this when the operator opens it.
 *
 * It answers the three questions that decide whether a receiver works before any software is
 * involved: is the device there, may this user open it, and has a kernel driver taken it first
 * (the DVB-T TV driver grabs RTL2832U sticks on most distributions). A serial port is reported
 * by its USB bridge; it is never assumed to be a particular board.
 */

/** RTL2832U dongles: the generic Realtek IDs most sticks (RTL-SDR Blog, NooElec, …) use. */
const RTL_SDR_IDS: ReadonlyMap<string, string> = new Map([
  ['0bda:2838', 'RTL2832U (generic, RTL-SDR Blog and most dongles)'],
  ['0bda:2832', 'RTL2832U (generic)'],
]);

/** The kernel's TV driver for these sticks: while it holds the device, no SDR software can. */
const DVB_DRIVER = 'dvb_usb_rtl28xxu';

/** USB-serial bridges seen on ESP32 LoRa boards (a LilyGO T-Beam carries one of these). */
const SERIAL_BRIDGES: ReadonlyMap<string, string> = new Map([
  ['10c4:ea60', 'Silicon Labs CP210x USB-serial'],
  ['1a86:55d4', 'WCH CH9102 USB-serial'],
  ['1a86:7523', 'WCH CH340 USB-serial'],
  ['303a:1001', 'Espressif ESP32-S3 native USB'],
]);

export type DeviceAccess = 'ok' | 'no-permission' | 'no-device-node' | 'unknown';

export interface RtlSdrDevice {
  usbId: string;
  name: string;
  product?: string;
  serial?: string;
  bus: number;
  device: number;
  devNode: string;
  access: DeviceAccess;
  /** The kernel driver bound to its first interface, if any. */
  kernelDriver?: string;
}

export interface SerialDevice {
  /** The stable name under /dev/serial/by-id. */
  byId: string;
  /** The tty it points at (/dev/ttyUSB0, /dev/ttyACM0 …). */
  path: string;
  usbId?: string;
  bridge?: string;
  product?: string;
  access: DeviceAccess;
}

export interface LocalHardwareScan {
  rtlSdr: RtlSdrDevice[];
  serial: SerialDevice[];
  /** The DVB-T driver module is loaded (it claims RTL2832U sticks as they are plugged in). */
  dvbDriverLoaded: boolean;
}

export interface ScanOptions {
  sysRoot?: string;
  devRoot?: string;
  /** Read+write access check; injectable because tests run as root, where it always passes. */
  canOpen?: (file: string) => Promise<boolean>;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

async function defaultCanOpen(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function access(file: string, canOpen: (f: string) => Promise<boolean>): Promise<DeviceAccess> {
  try {
    await fs.stat(file);
  } catch {
    return 'no-device-node';
  }
  return (await canOpen(file)) ? 'ok' : 'no-permission';
}

/** Scan USB devices and serial ports. Off Linux, or with no sysfs, everything is empty. */
export async function scanLocalHardware(opts: ScanOptions = {}): Promise<LocalHardwareScan> {
  const sys = opts.sysRoot ?? '/sys';
  const dev = opts.devRoot ?? '/dev';
  const canOpen = opts.canOpen ?? defaultCanOpen;
  const usbDir = path.join(sys, 'bus', 'usb', 'devices');
  const rtlSdr: RtlSdrDevice[] = [];
  for (const name of (await fs.readdir(usbDir).catch(() => [] as string[])).sort()) {
    if (name.includes(':')) continue; // an interface, not a device
    const d = path.join(usbDir, name);
    const vendor = await readText(path.join(d, 'idVendor'));
    const productId = await readText(path.join(d, 'idProduct'));
    if (!vendor || !productId) continue;
    const usbId = `${vendor}:${productId}`.toLowerCase();
    const known = RTL_SDR_IDS.get(usbId);
    if (!known) continue;
    const bus = Number(await readText(path.join(d, 'busnum')));
    const device = Number(await readText(path.join(d, 'devnum')));
    const devNode = path.join(dev, 'bus', 'usb', String(bus).padStart(3, '0'), String(device).padStart(3, '0'));
    const driverLink = await fs.readlink(path.join(usbDir, `${name}:1.0`, 'driver')).catch(() => undefined);
    const product = await readText(path.join(d, 'product'));
    const serial = await readText(path.join(d, 'serial'));
    rtlSdr.push({
      usbId,
      name: known,
      ...(product ? { product } : {}),
      ...(serial ? { serial } : {}),
      bus,
      device,
      devNode,
      access: Number.isFinite(bus) && Number.isFinite(device) ? await access(devNode, canOpen) : 'unknown',
      ...(driverLink ? { kernelDriver: path.basename(driverLink) } : {}),
    });
  }

  const serial: SerialDevice[] = [];
  const byIdDir = path.join(dev, 'serial', 'by-id');
  for (const byId of (await fs.readdir(byIdDir).catch(() => [] as string[])).sort()) {
    const link = path.join(byIdDir, byId);
    const target = await fs.readlink(link).catch(() => undefined);
    if (!target) continue;
    const tty = path.resolve(byIdDir, target);
    // /sys/class/tty/<tty>/device is the USB interface; its parent is the USB device.
    const iface = await fs
      .realpath(path.join(sys, 'class', 'tty', path.basename(tty), 'device'))
      .catch(() => undefined);
    let usbId: string | undefined;
    let product: string | undefined;
    for (const candidate of iface ? [path.dirname(iface), path.dirname(path.dirname(iface))] : []) {
      const v = await readText(path.join(candidate, 'idVendor'));
      const p = await readText(path.join(candidate, 'idProduct'));
      if (v && p) {
        usbId = `${v}:${p}`.toLowerCase();
        product = await readText(path.join(candidate, 'product'));
        break;
      }
    }
    const bridge = usbId ? SERIAL_BRIDGES.get(usbId) : undefined;
    serial.push({
      byId,
      path: tty,
      ...(usbId ? { usbId } : {}),
      ...(bridge ? { bridge } : {}),
      ...(product ? { product } : {}),
      access: await access(tty, canOpen),
    });
  }

  const dvbDriverLoaded = await fs
    .stat(path.join(sys, 'module', DVB_DRIVER))
    .then(() => true)
    .catch(() => false);
  return { rtlSdr, serial, dvbDriverLoaded };
}

export interface HardwareLine {
  id: string;
  status: 'not-configured' | 'stopped' | 'running' | 'error';
  message: string;
}

/** Diagnostics lines: what is there, and for anything that cannot work yet, the one-line fix. */
export function hardwareLines(scan: LocalHardwareScan): HardwareLine[] {
  const lines: HardwareLine[] = [];
  if (scan.rtlSdr.length === 0)
    lines.push({
      id: 'rtl-sdr',
      status: 'not-configured',
      message: 'no RTL-SDR (RTL2832U) plugged in',
    });
  for (const r of scan.rtlSdr) {
    const where = `${r.name}${r.product ? ` "${r.product}"` : ''} (${r.usbId}) on USB bus ${r.bus} device ${r.device}`;
    if (r.kernelDriver === DVB_DRIVER)
      lines.push({
        id: 'rtl-sdr',
        status: 'error',
        message: `${where}: held by the kernel's DVB-T TV driver (${DVB_DRIVER}), so no decoder can open it. sudo apt install rtl-sdr (it blacklists that driver and adds udev rules), then sudo modprobe -r ${DVB_DRIVER} or unplug and replug the stick`,
      });
    else if (r.access === 'no-permission')
      lines.push({
        id: 'rtl-sdr',
        status: 'error',
        message: `${where}: ${r.devNode} cannot be opened by this user. Install the rtl-sdr package's udev rules (sudo apt install rtl-sdr), then replug — the decoder's own service user needs the same`,
      });
    else
      lines.push({
        id: 'rtl-sdr',
        status: 'running',
        message: `${where}: present${r.access === 'ok' ? ' and openable' : ''}${r.kernelDriver ? `, interface driver ${r.kernelDriver}` : ''}. The decoder (readsb) owns it; aircraft appear in Sources → Local ADS-B receiver`,
      });
  }
  for (const s of scan.serial) {
    const what = s.bridge ?? (s.usbId ? `USB serial ${s.usbId}` : 'serial port');
    lines.push({
      id: `serial:${path.basename(s.path)}`,
      status: s.access === 'ok' ? 'running' : s.access === 'no-permission' ? 'error' : 'stopped',
      message:
        s.access === 'no-permission'
          ? `${what} at ${s.path} (${s.byId}): this user cannot open it. Add yourself to the dialout group (sudo usermod -aG dialout $USER), then log out and in`
          : `${what} at ${s.path} (${s.byId})${s.product ? `, "${s.product}"` : ''}`,
    });
  }
  return lines;
}
