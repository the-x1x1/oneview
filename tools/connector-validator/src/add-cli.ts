#!/usr/bin/env node
/**
 * pnpm connector:add --url <https://…> [--id <id>] [--name <name>] [--type <objectType>]
 *                    [--interval <seconds>] [--out <dir>] [--sample <file>] [--stdout]
 *
 * Fetches one sample of a source (or reads `--sample`), drafts a definition for it and
 * writes `<out>/<id>.json` (default connectors/drafts/). The draft is fail-closed —
 * user-configured, disabled, no policy opened — and lists what still has to be decided.
 * The URL is checked as the definition schema would (https, a public host, no credentials)
 * before anything is fetched. Nothing is sent but the GET.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl } from '@worldview/connector-sdk';
import { defaultConnectorRegistry } from '@worldview/connector-runtime';
import { draftDefinition } from './draft.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = opt('url');
const sampleFile = opt('sample');
const outDir = path.resolve(root, opt('out') ?? path.join('connectors', 'drafts'));
const toStdout = args.includes('--stdout');
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;

if (!url) {
  console.error(
    'usage: pnpm connector:add --url <https://…> [--id <id>] [--name <name>] [--type <objectType>] [--interval <s>] [--out <dir>] [--sample <file>] [--stdout]',
  );
  process.exit(2);
}
const bad = checkUrl(url, ['https:']);
if (bad) {
  console.error(`--url ${bad}`);
  process.exit(2);
}

let text: string;
let contentType: string | undefined;
if (sampleFile) {
  text = readFileSync(path.resolve(process.cwd(), sampleFile), 'utf8');
} else {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json, application/geo+json;q=0.9, text/csv;q=0.8, */*;q=0.1',
        'User-Agent': 'OneView connector:add',
      },
    });
    if (!res.ok) {
      console.error(`GET ${url} → ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    contentType = res.headers.get('content-type') ?? undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_SAMPLE_BYTES) {
      console.error(`the sample is ${buf.byteLength} bytes; more than ${MAX_SAMPLE_BYTES} is not drafted`);
      process.exit(1);
    }
    text = buf.toString('utf8');
  } catch (err) {
    console.error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

const interval = opt('interval');
const draft = draftDefinition(
  { url, text, ...(contentType ? { contentType } : {}) },
  {
    ...(opt('id') ? { id: opt('id')! } : {}),
    ...(opt('name') ? { name: opt('name')! } : {}),
    ...(opt('type') ? { objectType: opt('type')! } : {}),
    ...(interval ? { intervalSeconds: Number(interval) } : {}),
  },
);
const v = defaultConnectorRegistry.validate(draft.definition);
const id = String(draft.definition['id']);
const body = JSON.stringify(draft.definition, null, 2) + '\n';
if (toStdout) console.log(body);
else {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${id}.json`);
  if (existsSync(file)) {
    console.error(`${path.relative(root, file)} already exists; pass --id for another name or --stdout`);
    process.exit(1);
  }
  writeFileSync(file, body);
  console.log(`wrote ${path.relative(root, file)} (${draft.connector} connector)`);
}
for (const n of draft.notes) console.log(`  · ${n}`);
for (const t of draft.todo) console.log(`  TODO ${t}`);
if (!v.ok) for (const e of v.errors) console.log(`  ✗ ${e}`);
for (const w of v.warnings) console.log(`  ! ${w}`);
console.log(
  v.ok
    ? `\nThe draft validates. Next: fill in the TODOs, add a ${id}.test.json sidecar with fixtures, then pnpm connector:test ${toStdout ? '<file>' : path.relative(root, path.join(outDir, `${id}.json`))}`
    : '\nThe draft does not validate yet (see ✗ above); finish it by hand and run pnpm connector:test on it.',
);
