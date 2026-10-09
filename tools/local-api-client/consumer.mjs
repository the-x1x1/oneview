#!/usr/bin/env node
/**
 * A minimal consumer of WORLDVIEW's local read-only API (docs/adr/ADR-014-local-api.md): the
 * example a separate program — Formicaria, later — can start from. Node's own http client over
 * the Unix socket; no dependencies.
 *
 *   node consumer.mjs                                   # GET /v1
 *   node consumer.mjs /v1/objects?lat=21.3&lon=-157.9&radiusKm=50&type=aircraft
 *   node consumer.mjs /v1/own-position --socket /run/user/1000/worldview/api.sock
 *
 * Or from code: `import { getJson } from './consumer.mjs'`.
 *
 * The socket is `$XDG_RUNTIME_DIR/worldview/api.sock`, there only while WORLDVIEW runs with
 * Settings → Local API turned on, and only this user can open it. Every answer is JSON; an
 * error is `{ "error": { "code", "message" } }` with a 4xx/5xx status.
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function defaultSocket(env = process.env) {
  if (!env.XDG_RUNTIME_DIR) throw new Error('XDG_RUNTIME_DIR is not set: no session to find the socket in');
  return path.join(env.XDG_RUNTIME_DIR, 'worldview', 'api.sock');
}

/** GET a path; resolves `{ status, body }` (body parsed as JSON). Rejects if WORLDVIEW is not there. */
export function getJson(apiPath, { socketPath = defaultSocket(), timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: apiPath, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        // The API caps its answers at 4 MiB; anything bigger is not it.
        if (size > 5 * 1024 * 1024) req.destroy(new Error('answer too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) =>
      reject(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? new Error('WORLDVIEW is not running, or its local API is off (Settings → Local API)')
          : err.code === 'EACCES'
            ? new Error('this user may not open the socket (it belongs to another user)')
            : err,
      ),
    );
    req.end();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--socket');
  const socketPath = i >= 0 ? args[i + 1] : undefined;
  const apiPath = args.find((a, j) => !a.startsWith('--') && (i < 0 || j !== i + 1)) ?? '/v1';
  try {
    const { status, body } = await getJson(apiPath, socketPath ? { socketPath } : {});
    console.log(JSON.stringify(body, null, 2));
    process.exit(status >= 400 ? 1 : 0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
