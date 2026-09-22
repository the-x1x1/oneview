import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema } from '@worldview/provider-sdk';
import { createAllProviders } from './index.js';

const allManifests = () => createAllProviders().map((p) => p.manifest);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A manifest's `settings` block is what the source panel renders, so it has to describe
 * what the provider will actually honour. Declaring a key nothing reads would put a
 * control in front of an operator that silently does nothing — the same class of fault
 * as a hardcoded list in the interface, just pointed the other way.
 */
function providerSource(providerId: string): string {
  const dirs = readdirSync(path.join(root, 'providers'), { withFileTypes: true }).filter(
    (d) => d.isDirectory() && d.name !== 'registry',
  );
  for (const dir of dirs) {
    const srcDir = path.join(root, 'providers', dir.name, 'src');
    if (!existsSync(srcDir)) continue;
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter(
      (f) => typeof f === 'string' && f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    const texts = files.map((f) => readFileSync(path.join(srcDir, f), 'utf8'));
    if (texts.some((t) => t.includes(`id: '${providerId}'`))) return texts.join('\n');
  }
  throw new Error(`no source directory found for ${providerId}`);
}

test('provider settings: every declared key is one the provider actually reads', () => {
  for (const manifest of allManifests()) {
    if (!manifest.settings?.length) continue;
    const source = providerSource(manifest.id);
    for (const def of manifest.settings) {
      // A dotted key is a nested object: the provider reads the container.
      const readKey = def.key.split('.')[0]!;
      assert.ok(
        source.includes(`'${readKey}'`) || source.includes(`"${readKey}"`) || source.includes(`.${readKey}`),
        `${manifest.id} declares setting "${def.key}" but nothing in its source reads "${readKey}"`,
      );
    }
  }
});

test('provider settings: declarations are valid and self-consistent', () => {
  let declared = 0;
  for (const manifest of allManifests()) {
    const parsed = manifestSchema.parse(manifest);
    assert.ok(parsed.ok, `${manifest.id} manifest is invalid`);
    for (const def of manifest.settings ?? []) {
      declared++;
      assert.ok(def.label.trim().length > 0, `${manifest.id}.${def.key} needs a label`);
      if (def.kind === 'enum' || def.kind === 'multi-enum') {
        assert.ok((def.options?.length ?? 0) > 0, `${manifest.id}.${def.key} is ${def.kind} with no options`);
        const values = def.options!.map((o) => o.value);
        assert.equal(new Set(values).size, values.length, `${manifest.id}.${def.key} has duplicate option values`);
        for (const o of def.options!)
          assert.notEqual(o.label, o.value, `${manifest.id}.${def.key} option "${o.value}" needs readable wording`);
      }
      if (def.kind === 'number' && def.min !== undefined && def.max !== undefined) {
        assert.ok(def.min < def.max, `${manifest.id}.${def.key} has an empty range`);
      }
      if (def.helpUrl) assert.match(def.helpUrl, /^https:\/\//, `${manifest.id}.${def.key} help link must be https`);
    }
  }
  assert.ok(declared >= 10, `expected the configurable providers to declare their settings, found ${declared}`);
});

test('provider settings: a credential is never offered as an ordinary setting', () => {
  for (const manifest of allManifests()) {
    const credentialKeys = new Set(manifest.credentials.map((c) => c.key));
    for (const def of manifest.settings ?? []) {
      assert.ok(
        !credentialKeys.has(def.key),
        `${manifest.id}.${def.key} is a credential and must not be a plain-text setting`,
      );
      assert.ok(
        !/key|token|secret|password/i.test(def.key),
        `${manifest.id}.${def.key} looks like a secret; credentials go through credentials.set`,
      );
    }
  }
});
