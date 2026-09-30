import { useState } from 'react';
import { Icon } from '@worldview/ui';

const STORAGE_KEY = 'wv.attribution.collapsed';

/**
 * The credits line at the foot of the map, which the operator may fold away. With every
 * weather layer, the basemap and a few object sources it runs to several lines across the
 * bottom of the map, and it is read once, not watched.
 *
 * Folded, one short credit stays: the basemap's own lead ("Powered by Esri" — Esri's terms
 * ask for it wherever its imagery is shown), and a button to open the rest. Every source's
 * full notice is also always in Settings → About → Attribution. Whether it is folded is
 * remembered on this machine (browser storage; a view preference, not a setting).
 */
export function mapAttributionLead(first: string | undefined): string | undefined {
  if (!first) return undefined;
  const lead = first.split(' — ')[0]!.trim();
  return /^powered by /i.test(lead) ? lead : undefined;
}

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, v ? '1' : '0');
  } catch {
    // Storage refused (a locked profile): the choice lasts for this session only.
  }
}

export function MapAttribution({ credits }: { credits: readonly string[] }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  if (!credits.length) return null;
  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };
  const lead = mapAttributionLead(credits[0]);
  return (
    <div
      className={`wv-map__attribution${collapsed ? ' wv-map__attribution--collapsed' : ''}`}
      aria-label="Attribution"
    >
      <button
        type="button"
        className="wv-map__attribution-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? 'Show every source credited on the map' : 'Fold the source credits away'}
        onClick={toggle}
      >
        <Icon name={collapsed ? 'info' : 'chevronDown'} size={12} />
        {collapsed ? <span>Sources ({credits.length})</span> : null}
      </button>
      {collapsed ? (
        lead ? (
          <span className="wv-map__attribution-lead">{lead}</span>
        ) : null
      ) : (
        <span>{credits.join(' · ')}</span>
      )}
    </div>
  );
}
