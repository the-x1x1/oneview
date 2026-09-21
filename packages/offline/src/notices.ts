import type { GeoBounds } from '@worldview/world-model';
import type { WorldPackContent, WorldPackSourcePolicy } from './manifest.js';

/**
 * `licenses/NOTICES.md` — the human-readable attribution file every pack carries.
 * Generated from the source policies that allowed inclusion; shown by the app under
 * Data & Attribution for installed packs.
 */
export interface NoticesInput {
  id: string;
  name: string;
  createdAt: string;
  bounds: GeoBounds;
  sources: WorldPackSourcePolicy[];
  contents: WorldPackContent[];
}

export function renderNotices(input: NoticesInput): string {
  const lines: string[] = [];
  lines.push(`# Data notices — ${input.name} (${input.id})`);
  lines.push('');
  lines.push(`Built ${input.createdAt} for bounds W ${fmt(input.bounds.west)} · S ${fmt(input.bounds.south)} · E ${fmt(input.bounds.east)} · N ${fmt(input.bounds.north)}.`);
  lines.push('');
  lines.push('This world pack contains data only (no code). Each source below permitted offline packaging and redistribution at build time; the attribution lines must be shown wherever the data is displayed.');
  lines.push('');
  lines.push('## Sources');
  lines.push('');
  for (const src of [...input.sources].sort((a, b) => a.providerId.localeCompare(b.providerId))) {
    lines.push(`### ${src.providerId}`);
    lines.push('');
    lines.push(`- Licence: ${src.license}`);
    lines.push(`- Attribution: ${src.attribution}`);
    if (src.termsUrl) lines.push(`- Terms: ${src.termsUrl}`);
    const files = input.contents.filter((c) => c.providerId === src.providerId);
    if (files.length) lines.push(`- Files: ${files.map((f) => `\`${f.path}\`${f.rowCount !== undefined ? ` (${f.rowCount} rows)` : ''}`).join(', ')}`);
    lines.push('');
  }
  const unattributed = input.contents.filter((c) => c.providerId === undefined && c.kind !== 'notices' && c.kind !== 'search-index');
  if (unattributed.length) {
    lines.push('## Derived files');
    lines.push('');
    for (const c of unattributed) lines.push(`- \`${c.path}\``);
    lines.push('');
  }
  lines.push('## Derived index');
  lines.push('');
  lines.push('`search/index.json` is derived from the place and airport layers above and carries the same attribution.');
  lines.push('');
  return lines.join('\n');
}

function fmt(v: number): string { return v.toFixed(2); }
