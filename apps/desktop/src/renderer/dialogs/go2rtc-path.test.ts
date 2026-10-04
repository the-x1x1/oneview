import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go2rtcPathProblem } from './settings-dialog.js';

test('a go2rtc path is checked in words before it is saved', () => {
  assert.equal(go2rtcPathProblem(''), undefined, 'empty clears the setting');
  assert.equal(go2rtcPathProblem('C:\\Tools\\go2rtc\\go2rtc.exe'), undefined);
  assert.equal(go2rtcPathProblem('c:/tools/go2rtc.exe'), undefined);
  assert.equal(go2rtcPathProblem('\\\\server\\share\\go2rtc.exe'), undefined);
  assert.equal(go2rtcPathProblem('/opt/go2rtc/go2rtc'), undefined);
  assert.match(go2rtcPathProblem('go2rtc.exe') ?? '', /full path .* e\.g\. C:\\Tools/);
  assert.match(go2rtcPathProblem('Tools\\go2rtc.exe') ?? '', /full path/);
});
