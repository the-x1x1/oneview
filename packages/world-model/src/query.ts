import type { GeoRegion } from './geo.js';
import type { TimeRange } from './time.js';
import type { JsonValue } from './json.js';

/**
 * WorldQuery — the single deterministic query shape used by search, lenses,
 * watch zones, "what changed" and the IPC world.query action.
 */
export interface WorldQuery {
  objectTypes?: string[];
  eventTypes?: string[];

  /** Free text (already parsed by the search parser into the other fields where possible). */
  text?: string;

  region?: GeoRegion;

  /** Absent = live state now. Present = history/replay query. */
  time?: TimeRange;

  filters?: WorldFilter[];

  sort?: SortDefinition;

  limit?: number;

  /** Restrict to these providers. */
  providerIds?: string[];
}

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';

export interface WorldFilter {
  /** Dotted path into properties/labels/motion, e.g. "properties.magnitude", "labels.callsign", "motion.speedMps". */
  field: string;
  op: FilterOperator;
  value?: JsonValue;
}

export interface SortDefinition {
  field: string;
  direction: 'asc' | 'desc';
}

export interface WorldQueryResult<T> {
  items: T[];
  total: number;
  truncated: boolean;
  /** Evaluated against live state ('live') or history ('historical'). */
  basis: 'live' | 'historical';
  evaluatedAt: string;
}
