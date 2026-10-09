import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * A pseudo-terminal standing in for a USB serial device (Linux, python3). The test side opens the
 * slave (`path`) the way WORLDVIEW opens /dev/ttyUSB0; this helper holds the master: `send`
 * writes bytes as the device would, `received` collects what was written to the device, and
 * `unplug` closes the master — the slave's reads then fail as they do when a cable is pulled.
 */
// Commands are read from fd 0 with os.read and split into lines here: sys.stdin.readline()
// reads ahead into Python's own buffer, and a second command already sitting in that buffer
// never wakes select() — two sends close together then lost the second (seen in CI).
const SCRIPT = String.raw`
import os, pty, sys, select, binascii
m, s = pty.openpty()
print(os.ttyname(s), flush=True)
pending = b''
while True:
    r, _, _ = select.select([m, 0], [], [])
    if 0 in r:
        chunk = os.read(0, 65536)
        if not chunk:
            os.close(m); os.close(s); sys.exit(0)
        pending += chunk
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            line = line.strip()
            if line == b'unplug':
                os.close(m); os.close(s); sys.exit(0)
            if line:
                os.write(m, binascii.unhexlify(line))
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
