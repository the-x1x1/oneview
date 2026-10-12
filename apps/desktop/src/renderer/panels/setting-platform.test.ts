import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformName, settingUnavailableNote } from './setting-platform.js';

test('settingUnavailableNote: a Linux-only setting is said to be unavailable on Windows, and nowhere else', () => {
  const usb = { platforms: ['linux' as const] };
  assert.equal(settingUnavailableNote(usb, 'win32'), 'Not available on Windows: this works on Linux only.');
  assert.equal(settingUnavailableNote(usb, 'darwin'), 'Not available on macOS: this works on Linux only.');
  assert.equal(settingUnavailableNote(usb, 'linux'), undefined);
  assert.equal(settingUnavailableNote({}, 'win32'), undefined, 'no platforms named: everywhere');
  assert.equal(settingUnavailableNote(usb, undefined), undefined, 'no platform known (a browser): not hidden');
  assert.equal(
    settingUnavailableNote({ platforms: ['linux', 'darwin'] }, 'win32'),
    'Not available on Windows: this works on Linux and macOS only.',
  );
  assert.equal(platformName('freebsd'), 'freebsd');
});
