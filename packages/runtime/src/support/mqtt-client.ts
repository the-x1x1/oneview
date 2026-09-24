import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import {
  ProviderError,
  type ProviderMqtt,
  type ProviderMqttEvents,
  type ProviderMqttHandle,
  type ProviderMqttOptions,
} from '@worldview/provider-sdk';
import {
  CONNACK_REASONS,
  PacketReader,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePuback,
  encodeSubscribe,
  isValidTopicFilter,
} from './mqtt-packets.js';

/**
 * `ProviderContext.mqtt` (ADR-003 amendment 2026-09-23): an MQTT 3.1.1 subscriber over a
 * TCP or TLS connection the runtime opens itself — to loopback in the provider's
 * `allowedHosts` or exactly the host the user named, and nowhere else. It connects, sends
 * CONNECT (username as given, the password resolved from the credential store by key and
 * never handed to the provider), SUBSCRIBEs, acknowledges QoS 1 publishes, answers the
 * keep-alive, and delivers each PUBLISH as bytes with its topic. It never publishes.
 * Payloads over `maxPayloadBytes` and messages past `maxMessagesPerSecond` are dropped and
 * counted on the handle; a malformed stream closes the connection with a typed error.
 */
export interface MqttClientOptions {
  allowed: (host: string) => boolean;
  resolveSecret: (key: string) => Promise<string | undefined>;
  /** Injectable for tests; defaults to `node:net` / `node:tls`. */
  connect?: (opts: { host: string; port: number; tls: boolean }) => net.Socket;
  defaultMaxPayloadBytes?: number;
  defaultMaxMessagesPerSecond?: number;
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_MAX_MESSAGES_PER_SECOND = 500;
const DEFAULT_KEEP_ALIVE_SECONDS = 60;
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const MAX_SUBSCRIPTIONS = 64;

export function createMqtt(o: MqttClientOptions): ProviderMqtt {
  const connectImpl =
    o.connect ??
    ((opts: { host: string; port: number; tls: boolean }): net.Socket =>
      opts.tls
        ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
        : net.createConnection({ host: opts.host, port: opts.port }));
  return {
    connect: (opts, events) => connectMqtt(opts, events, { ...o, connect: connectImpl }),
  };
}

function connectMqtt(
  opts: ProviderMqttOptions,
  events: ProviderMqttEvents,
  o: Required<Pick<MqttClientOptions, 'connect'>> & MqttClientOptions,
): Promise<ProviderMqttHandle> {
  const host = String(opts?.host ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const useTls = opts.tls === true;
  const port = opts.port ?? (useTls ? 8883 : 1883);
  if (!host || !o.allowed(host))
    return Promise.reject(
      new ProviderError(
        'HOST_NOT_ALLOWED',
        `${host || '(no host)'} is not loopback or the host named for this source`,
        {
          retryable: false,
        },
      ),
    );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return Promise.reject(
      new ProviderError('HOST_NOT_ALLOWED', `port ${String(opts.port)} is not a TCP port`, { retryable: false }),
    );
  const subscriptions = (opts.subscriptions ?? []).map((s) => ({
    topic: String(s.topic ?? ''),
    qos: s.qos === 1 ? (1 as const) : (0 as const),
  }));
  if (!subscriptions.length || subscriptions.length > MAX_SUBSCRIPTIONS)
    return Promise.reject(
      new ProviderError('MALFORMED', `between 1 and ${MAX_SUBSCRIPTIONS} subscriptions are needed`, {
        retryable: false,
      }),
    );
  const bad = subscriptions.find((s) => !isValidTopicFilter(s.topic));
  if (bad)
    return Promise.reject(new ProviderError('MALFORMED', `"${bad.topic}" is not a topic filter`, { retryable: false }));
  const maxPayload = opts.maxPayloadBytes ?? o.defaultMaxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxPerSecond = opts.maxMessagesPerSecond ?? o.defaultMaxMessagesPerSecond ?? DEFAULT_MAX_MESSAGES_PER_SECOND;
  const keepAlive = Math.min(0xffff, Math.max(5, opts.keepAliveSeconds ?? DEFAULT_KEEP_ALIVE_SECONDS));
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const clientId = opts.clientId ?? `worldview-${randomBytes(6).toString('hex')}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let dropped = 0;
    let closedByUs = false;
    let windowStart = Date.now();
    let inWindow = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    let subscribed = false;
    const reader = new PacketReader();
    const socket = o.connect({ host, port, tls: useTls });
    const handle: ProviderMqttHandle = {
      close: () => {
        closedByUs = true;
        try {
          socket.write(encodeDisconnect());
        } catch {
          /* the socket may already be gone */
        }
        socket.destroy();
      },
      get dropped() {
        return dropped;
      },
    };
    const fail = (err: ProviderError): void => {
      if (!settled) {
        settled = true;
        reject(err);
      } else events.onError?.(err);
    };
    const finish = (reason?: string): void => {
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      pingTimer = undefined;
      pongTimer = undefined;
      if (settled) events.onClose?.(reason);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new ProviderError('TIMEOUT', `no CONNACK from ${host}:${port} within ${connectTimeoutMs} ms`));
    }, connectTimeoutMs);
    opts.signal?.addEventListener('abort', () => handle.close(), { once: true });

    socket.on('connect', () => {
      void (async () => {
        let password: string | undefined;
        if (opts.credential) {
          password = await o.resolveSecret(opts.credential.key);
          if (password === undefined) {
            clearTimeout(timer);
            socket.destroy();
            fail(new ProviderError('AUTH', `credential ${opts.credential.key} not configured`, { retryable: false }));
            return;
          }
        }
        socket.write(
          encodeConnect({
            clientId,
            keepAliveSeconds: keepAlive,
            ...(opts.username !== undefined ? { username: opts.username } : {}),
            ...(password !== undefined ? { password } : {}),
          }),
        );
      })();
    });
    if (useTls) socket.on('secureConnect', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      let packets;
      try {
        packets = reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      } catch (err) {
        socket.destroy();
        fail(
          new ProviderError(
            'MALFORMED',
            `MQTT stream from ${host}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      for (const p of packets) {
        switch (p.type) {
          case 'connack':
            if (p.returnCode !== 0) {
              clearTimeout(timer);
              socket.destroy();
              const reason = CONNACK_REASONS[p.returnCode] ?? `return code ${p.returnCode}`;
              fail(
                new ProviderError(
                  p.returnCode === 4 || p.returnCode === 5 ? 'AUTH' : 'NETWORK',
                  `broker refused: ${reason}`,
                  { retryable: false },
                ),
              );
              return;
            }
            socket.write(encodeSubscribe(1, subscriptions));
            break;
          case 'suback': {
            const refused = p.returnCodes.findIndex((c) => c === 0x80);
            if (refused >= 0) {
              clearTimeout(timer);
              socket.destroy();
              fail(
                new ProviderError('AUTH', `broker refused subscription to "${subscriptions[refused]?.topic ?? '?'}"`, {
                  retryable: false,
                }),
              );
              return;
            }
            if (!subscribed) {
              subscribed = true;
              clearTimeout(timer);
              settled = true;
              // unref: a forgotten handle must not keep the process alive on its own.
              pingTimer = setInterval(() => {
                try {
                  socket.write(encodePingreq());
                } catch {
                  /* closing */
                }
                pongTimer ??= setTimeout(() => {
                  socket.destroy();
                  events.onError?.(new ProviderError('TIMEOUT', `${host}:${port} stopped answering keep-alive pings`));
                }, keepAlive * 1000);
              }, keepAlive * 1000);
              pingTimer.unref?.();
              resolve(handle);
              events.onOpen?.();
            }
            break;
          }
          case 'pingresp':
            if (pongTimer) clearTimeout(pongTimer);
            pongTimer = undefined;
            break;
          case 'publish': {
            if (p.qos === 1 && p.packetId !== undefined) socket.write(encodePuback(p.packetId));
            if (p.qos === 2) {
              dropped++; // QoS 2 is not subscribed for; a broker sending it is not followed into the handshake
              break;
            }
            if (p.payload.byteLength > maxPayload) {
              dropped++;
              break;
            }
            const now = Date.now();
            if (now - windowStart >= 1000) {
              windowStart = now;
              inWindow = 0;
            }
            if (++inWindow > maxPerSecond) {
              dropped++;
              break;
            }
            events.onMessage(p.topic, p.payload.slice(), { retained: p.retained, qos: p.qos });
            break;
          }
          default:
            break;
        }
      }
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const code =
        err.code === 'ECONNREFUSED'
          ? 'OFFLINE'
          : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
            ? 'DNS'
            : 'NETWORK';
      fail(new ProviderError(code, `${host}:${port}: ${err.message}`));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!settled) fail(new ProviderError('OFFLINE', `${host}:${port} closed the connection before it was open`));
      finish(closedByUs ? 'closed' : 'connection closed');
    });
  });
}
