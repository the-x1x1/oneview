import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * A pseudo-terminal standing in for a USB serial device (Linux, python3). The test side opens the
 * slave (`path`) the way WORLDVIEW opens /dev/ttyUSB0; this helper holds the master: `send`
 * writes bytes as the device would, `received` collects what was written to the device, and
 * `unplug` closes the master — the slave's reads then fail as they do when a cable is pulled.
 */
const SCRIPT = String.raw`
import os, pty, sys, select, binascii
m, s = pty.openpty()
print(os.ttyname(s), flush=True)
while True:
    r, _, _ = select.select([m, sys.stdin], [], [])
    if sys.stdin in r:
        line = sys.stdin.readline()
        if not line or line.strip() == 'unplug':
            os.close(m); os.close(s); sys.exit(0)
        os.write(m, binascii.unhexlify(line.strip()))
    if m in r:
        try:
            data = os.read(m, 4096)
        except OSError:
            sys.exit(0)
        print('R' + binascii.hexlify(data).decode(), flush=True)
`;

export interface PtyDevice {
  path: string;
  send(bytes: Uint8Array): void;
  received: Uint8Array[];
  unplug(): Promise<void>;
}

export async function ptyDevice(): Promise<PtyDevice> {
  const child: ChildProcessWithoutNullStreams = spawn('python3', ['-c', SCRIPT]);
  const lines = createInterface({ input: child.stdout });
  const received: Uint8Array[] = [];
  const path = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    lines.once('line', resolve);
  });
  lines.on('line', (l) => {
    if (l.startsWith('R')) received.push(Uint8Array.from(Buffer.from(l.slice(1), 'hex')));
  });
  return {
    path,
    send: (bytes) => child.stdin.write(`${Buffer.from(bytes).toString('hex')}\n`),
    received,
    unplug: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.stdin.write('unplug\n');
      }),
  };
}
