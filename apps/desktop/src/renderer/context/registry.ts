import type { ReactNode } from 'react';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import type { SourceHealthEntry } from '@worldview/source-health';
import type { ShellActions } from '../store/actions.js';
import type { TrackPoint } from '../store/types.js';

/**
 * Context panel registry (directive §62). The Selection panel is composed from
 * sections: defaults registered under '*' apply to every object type; type-specific
 * sections are registered under the object type and spliced in at `placement`.
 * Adding a context section for a new object type is `contextRegistry.register(type, [...])`
 * in a new module — no renderer, store or panel code changes.
 */
export interface ContextSectionProps {
  object: WorldObject;
  track: ReadonlyArray<TrackPoint>;
  related: { objects: WorldObject[]; events: WorldEvent[] };
  sources: ReadonlyArray<SourceHealthEntry>;
  actions: ShellActions;
  nowMs: number;
}

export interface ContextSection {
  /** Stable id; a type-specific section with the same id as a default replaces it. */
  id: string;
  title: string;
  /** Return null to omit the section when the object carries no data for it. */
  render: (props: ContextSectionProps) => ReactNode;
  /** Where type-specific sections go relative to defaults (default: after 'identity'). */
  placement?: { after: string } | { before: string } | 'end';
}

export class ContextRegistry {
  private readonly defaults: ContextSection[] = [];
  private readonly byType = new Map<string, ContextSection[]>();

  /** Register sections for an object type, or for every type with '*'. Returns an unregister function. */
  register(objectType: string, sections: ContextSection[]): () => void {
    const list = objectType === '*' ? this.defaults : (this.byType.get(objectType) ?? []);
    if (objectType !== '*') this.byType.set(objectType, list);
    for (const s of sections) {
      const idx = list.findIndex((x) => x.id === s.id);
      if (idx >= 0) list[idx] = s; else list.push(s);
    }
    return () => { for (const s of sections) { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); } };
  }

  types(): string[] { return [...this.byType.keys()]; }

  /** Composed, ordered sections for an object type. */
  sectionsFor(objectType: string): ContextSection[] {
    const out: ContextSection[] = [...this.defaults];
    const specific = this.byType.get(objectType) ?? [];
    for (const s of specific) {
      const existing = out.findIndex((x) => x.id === s.id);
      if (existing >= 0) { out[existing] = s; continue; }
      const placement = s.placement ?? { after: 'identity' };
      if (placement === 'end') { out.push(s); continue; }
      const anchor = 'after' in placement ? placement.after : placement.before;
      const at = out.findIndex((x) => x.id === anchor);
      if (at < 0) { out.push(s); continue; }
      out.splice('after' in placement ? at + 1 : at, 0, s);
    }
    return out;
  }
}

export const contextRegistry = new ContextRegistry();
