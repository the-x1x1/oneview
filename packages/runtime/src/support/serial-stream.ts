import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fsp, close as fsClose, open as fsOpen, write as fsWrite } from 'node:fs';
import tty from 'node:tty';
import { ProviderError, type ByteStreamEvents, type ByteStreamHandle } from '@worldview/provider-sdk';

/**
 * A USB serial port to a device on this computer (ADR-003 amendment 2026-10-08,
 * `ProviderLocalAccess.openSerialStream`; docs/cyberdeck M4) — a Meshtastic node plugged in by
 * cable. Linux only. The same rules as a TCP byte stream: reads handed over as they come, capped
 * per second (the rest dropped and counted); writes small and rare (a request now and then).
 *
 * Only the one path the operator named is touched, and only if it is a USB serial device:
 * `/dev/serial/by-id/<name>` (the stable name), `/dev/ttyUSB<n>` or `/dev/ttyACM<n>`, resolving to
 * a `/dev/ttyUSB<n>` or `/dev/ttyACM<n>`. Nothing is scanned or probed.
 *
 * The line is set up with `stty` — one fixed program, its arguments as a list, no shell: raw,
 * no echo, the baud rate, and `-hupcl` so closing the port does not drop DTR (on boards whose
 * DTR/RTS lines drive the reset circuit, a drop can restart the board). Bytes are read through
 * Node's tty stream (non-blocking, on the event loop) and written with plain writes.
 */

export const SERIAL_PATH = /^\/dev\/(?:tty(?:USB|ACM)\d{1,3}|serial\/by-id\/[A-Za-z0-9._:+@-]{1,200})$/;
const SERIAL_DEVICE = /^\/dev\/tty(?:USB|ACM)\d{1,3}$/;
export const SERIAL_BAUD_RATES: ReadonlySet<number> = new Set([
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
]);

export interface SerialStreamOptions {
  maxBytesPerSecond: number;
  maxWriteBytes: number;
  maxWritesPerMinute: number;
  platform?: string;
  /** Tests: accept a path and a resolved device outside the USB serial rules (a pseudo-terminal). */
  isAllowedPath?: (path: string) => boolean;
  isAllowedDevice?: (resolved: string) => boolean;
  /** Tests: the line setup (defaults to `stty`). */
  configure?: (device: string, baudRate: number) => Promise<void>;
}

function stty(device: string, baudRate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'stty',
      ['-F', device, String(baudRate), 'raw', '-echo', '-hupcl', 'clocal', 'cread', '-crtscts', '-ixon', '-ixoff'],
      { timeout: 5000, windowsHide: true },
      (err, _stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve()),
    );
  });
}

function code(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function openFailure(err: unknown, path: string): ProviderError {
  const c = code(err);
  const text = err instanceof Error ? err.message : String(err);
  if (c === 'ENOENT' || c === 'ENXIO' || c === 'ENODEV')
    return new ProviderError('OFFLINE', `nothing is plugged in at ${path}`, { retryAfterMs: 5000 });
  if (c === 'EACCES' || c === 'EPERM' || /Permission denied/i.test(text))
    return new ProviderError(
      'OFFLINE',
      `this user cannot open ${path}: add yourself to the dialout group (sudo usermod -aG dialout $USER), then log out and in`,
      { retryAfterMs: 30_000 },
    );
  if (c === 'EBUSY')
    return new ProviderError('OFFLINE', `${path} is in use by another program`, { retryAfterMs: 10_000 });
  return new ProviderError('OFFLINE', `${path}: ${text}`, { retryAfterMs: 10_000 });
}

export async function openSerialStream(
  target: { path: string; baudRate: number },
  events: ByteStreamEvents,
  o: SerialStreamOptions,
): Promise<ByteStreamHandle> {
  if ((o.platform ?? process.platform) !== 'linux')
    throw new ProviderError('UNSUPPORTED', 'serial ports are read on Linux; elsewhere use the node over TCP', {
      retryable: false,
    });
  const path = typeof target.path === 'string' ? target.path.trim() : '';
  if (!(o.isAllowedPath ?? ((p: string) => SERIAL_PATH.test(p)))(path))
    throw new ProviderError(
      'HOST_NOT_ALLOWED',
      `${path || '(none)'} is not a USB serial device: use /dev/serial/by-id/…, /dev/ttyUSB<n> or /dev/ttyACM<n>`,
      { retryable: false },
    );
  if (!SERIAL_BAUD_RATES.has(target.baudRate))
    throw new ProviderError('HOST_NOT_ALLOWED', `unsupported baud rate ${target.baudRate}`, { retryable: false });
  let device: string;
  try {
    device = await fsp.realpath(path);
  } catch (err) {
    throw openFailure(err, path);
  }
  if (!(o.isAllowedDevice ?? ((d: string) => SERIAL_DEVICE.test(d)))(device))
    throw new ProviderError('HOST_NOT_ALLOWED', `${path} resolves to ${device}, which is not a USB serial device`, {
      retryable: false,
    });
  try {
    await (o.configure ?? stty)(device, target.baudRate);
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : '';
    if (code(err) === 'ENOENT' && !stderr)
      throw new ProviderError('UNSUPPORTED', 'stty is not installed', { retryable: false });
    throw openFailure(
      Object.assign(new Error(stderr || (err instanceof Error ? err.message : String(err))), { code: code(err) }),
      path,
    );
  }
  const fd = await new Promise<number>((resolve, reject) =>
    fsOpen(device, fsConstants.O_RDWR | fsConstants.O_NOCTTY, (err, n) =>
      err ? reject(openFailure(err, path)) : resolve(n),
    ),
  );
  let reader: tty.ReadStream;
  try {
    reader = new tty.ReadStream(fd);
  } catch (err) {
    fsClose(fd, () => undefined);
    throw new ProviderError(
      'OFFLINE',
      `${path} is not a terminal device (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  let closed = false;
  let closedByUs = false;
  let dropped = 0;
  let readWindowStart = Date.now();
  let readInWindow = 0;
  let writesInFlight = 0;
  const writes: number[] = [];
  // The tty stream owns the descriptor: destroying it closes it, exactly once. It is destroyed
  // only when no write is still using the number — a closed number can be handed straight to
  // another file, which a late write (or a second close) would then hit.
  const release = () => {
    if (closed && writesInFlight === 0 && !reader.destroyed) reader.destroy();
  };
  const finish = (why: string, error?: ProviderError) => {
    if (closed) return;
    closed = true;
    release();
    // Reported on a later turn, as a TCP stream's close is: a caller closing the stream has
    // already let go of it by then.
    setImmediate(() => {
      if (error && !closedByUs) events.onError?.(error);
      events.onClose?.(closedByUs ? 'closed' : why);
    });
  };
  reader.on('data', (chunk: Buffer) => {
    const now = Date.now();
    if (now - readWindowStart >= 1000) {
      readWindowStart = now;
      readInWindow = 0;
    }
    const room = Math.max(0, o.maxBytesPerSecond - readInWindow);
    const take = Math.min(room, chunk.length);
    readInWindow += take;
    dropped += chunk.length - take;
    if (take > 0) events.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, take).slice());
  });
  // Unplugged: the read fails (EIO) or the stream ends.
  reader.on('error', (err: Error) =>
    finish('the device went away', new ProviderError('OFFLINE', `${path}: ${err.message} (unplugged?)`)),
  );
  reader.on('end', () => finish('the device went away'));

  return {
    write: (bytes) => {
      if (closed || !(bytes instanceof Uint8Array) || bytes.length === 0) return false;
      if (bytes.length > o.maxWriteBytes) return false;
      const now = Date.now();
      while (writes.length && now - writes[0]! >= 60_000) writes.shift();
      if (writes.length >= o.maxWritesPerMinute) return false;
      writes.push(now);
      writesInFlight++;
      fsWrite(fd, Buffer.from(bytes), (err) => {
        writesInFlight--;
        if (err) finish('the device went away', new ProviderError('OFFLINE', `${path}: ${err.message}`));
        release();
      });
      return true;
    },
    close: () => {
      closedByUs = true;
      finish('closed');
    },
    get dropped() {
      return dropped;
    },
  };
}
