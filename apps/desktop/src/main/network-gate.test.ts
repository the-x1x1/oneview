import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockInternetRequests, gatedFetch, leavesThisComputer, WorkingOfflineError } from './network-gate.js';

test('leavesThisComputer: the internet and the LAN do, this computer and the app scheme do not', () => {
  for (const u of ['https://server.arcgisonline.com/x', 'http://192.168.1.20:8080/', 'wss://stream.example/ws'])
    assert.equal(leavesThisComputer(u), true, u);
  for (const u of [
    'http://127.0.0.1:1984/api',
    'http://localhost:8080/',
    'ws://[::1]:9000/',
    'http://camera.localhost/',
    'worldview://app/__tiles/esri/1/2/3',
    'file:///C:/x',
    'data:image/png;base64,AA',
    'not a url',
  ])
    assert.equal(leavesThisComputer(u), false, u);
});

test('gatedFetch: refuses without sending while offline; passes through otherwise and for loopback', async () => {
  let offline = true;
  const sent: string[] = [];
  const inner = (async (input: string | URL | Request) => {
    sent.push(String(input));
    return new Response('ok');
  }) as typeof fetch;
  const f = gatedFetch(inner, () => offline);
  await assert.rejects(f('https://earthquake.usgs.gov/feed'), (e: unknown) => {
    assert.ok(e instanceof WorkingOfflineError);
    assert.match(e.message, /earthquake\.usgs\.gov not asked/);
    return true;
  });
  assert.deepEqual(sent, []);
  await f('http://127.0.0.1:1984/api/frame.jpeg');
  offline = false;
  await f(new URL('https://earthquake.usgs.gov/feed'));
  assert.deepEqual(sent, ['http://127.0.0.1:1984/api/frame.jpeg', 'https://earthquake.usgs.gov/feed']);
});

test('blockInternetRequests: the session cancels what would leave this computer, only while offline', () => {
  let listener: ((d: { url: string }, cb: (r: { cancel?: boolean }) => void) => void) | undefined;
  let filter: string[] = [];
  const session = {
    webRequest: {
      onBeforeRequest(f: { urls: string[] }, l: typeof listener) {
        filter = f.urls;
        listener = l;
      },
    },
  };
  let offline = false;
  const blocked: string[] = [];
  blockInternetRequests(
    session,
    () => offline,
    (u) => blocked.push(u),
  );
  assert.deepEqual(filter, ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']);
  const ask = (url: string) => {
    let answer: { cancel?: boolean } = {};
    listener!({ url }, (r) => (answer = r));
    return answer.cancel === true;
  };
  assert.equal(ask('https://gibs.earthdata.nasa.gov/t.png'), false);
  offline = true;
  assert.equal(ask('https://gibs.earthdata.nasa.gov/t.png'), true);
  assert.equal(ask('http://127.0.0.1:5173/'), false);
  assert.deepEqual(blocked, ['https://gibs.earthdata.nasa.gov/t.png']);
});
