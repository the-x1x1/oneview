#!/usr/bin/env node
/**
 * pnpm release:assert-version [--tag vX.Y.Z] [--require-tag]
 *
 * Fails unless every release artifact is the apps/desktop version and HEAD's commit
 * (assert-version.ts). The tag is `--tag`, else GITHUB_REF_NAME on a tag build, else the tag
 * pointing at HEAD, if any. Run after `release:package`, `sbom` and `release:verify`.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertReleaseVersion, formatAssertVersion } from './assert-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const git = (args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};
const argTag = (() => {
  const i = process.argv.indexOf('--tag');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const envTag = process.env['GITHUB_REF_TYPE'] === 'tag' ? process.env['GITHUB_REF_NAME'] : undefined;
const headTag = git(['tag', '--points-at', 'HEAD'])
  ?.split(/\r?\n/)
  .find((t) => /^v\d/.test(t));
const tag = argTag ?? envTag ?? headTag;
const commit = git(['rev-parse', 'HEAD']);
const result = assertReleaseVersion({
  root,
  ...(tag ? { tag } : {}),
  ...(commit ? { commit } : {}),
  requireTag: process.argv.includes('--require-tag'),
});
console.log(formatAssertVersion(result));
process.exit(result.ok ? 0 : 1);
