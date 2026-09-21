import { s, type Schema } from '@worldview/world-model';

/**
 * ProviderDataPolicy — mandatory, separate from software license. The runtime,
 * history store, worldpack builder and exporter enforce these flags.
 */
export interface ProviderDataPolicy {
  cacheAllowed: boolean;
  rawPayloadRetentionAllowed: boolean;
  normalizedRetentionAllowed: boolean;

  /** Upper bound for any retention (raw or normalized). Undefined = policy imposes no limit. */
  maxRetentionSeconds?: number;

  redistributionAllowed: boolean;
  offlinePackAllowed: boolean;
  exportAllowed: boolean;
  commercialUseAllowed: true | false | 'conditional' | 'unknown';

  attributionRequired: boolean;
  attributionText?: string;
  termsUrl?: string;
}

export interface CredentialRequirement {
  /** Key under which the secret is stored (e.g. "firms.mapKey"). Never the secret itself. */
  key: string;
  label: string;
  required: boolean;
  /** Where to obtain the credential. */
  helpUrl?: string;
  kind: 'api-key' | 'token' | 'basic' | 'url';
}

export interface RefreshPolicy {
  /** Base polling interval in ms (ignored for websocket/subscription transports). */
  intervalMs: number;
  /** Minimum interval the provider must respect even if the user asks for faster. */
  minIntervalMs: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Max consecutive retries before opening the circuit. */
  maxRetries: number;
  /** Max requests per minute the provider will issue (client-side rate limit). */
  maxRequestsPerMinute: number;
  /** Serve last good data for this long when upstream fails (0 = never). Bounded by dataPolicy. */
  staleWhileErrorMs: number;
  /** Object-type freshness overrides (seconds). */
  freshness?: Record<string, { liveSeconds: number; recentSeconds: number; expireSeconds?: number }>;
}

export interface AttributionDefinition {
  /** Short attribution shown in Data & Attribution and on selection. */
  text: string;
  /** Optional URL for the source. */
  url?: string;
  /** Required on-screen (map) credit, e.g. for map providers. */
  onScreen?: boolean;
  licenseId?: string;
}

export type ProviderTransport = 'http' | 'websocket' | 'filesystem' | 'local-process' | 'hardware';

export interface ProviderManifest {
  /** Stable kebab-case id, e.g. "usgs-earthquakes". */
  id: string;
  name: string;
  version: string;
  /** Short description for the source health panel. */
  description?: string;

  objectTypes: string[];
  /** Lens categories: earth, space, fire, aviation, maritime, weather, cameras, infrastructure, transit, traffic. */
  categories: string[];

  transport: ProviderTransport;

  capabilities: {
    live: boolean;
    historical: boolean;
    offline: boolean;
    boundsQuery: boolean;
  };

  credentials: CredentialRequirement[];

  refreshPolicy: RefreshPolicy;

  dataPolicy: ProviderDataPolicy;

  attribution: AttributionDefinition;

  /** Commercial review state copied from config/licenses/providers.json at build time. */
  commercialReview: 'approved' | 'conditional' | 'excluded' | 'manual-review-required';

  /** Whether the provider is enabled in a fresh install. Excluded/manual-review providers must be false. */
  enabledByDefault: boolean;

  /** Hostnames the provider is allowed to contact (allowlist enforced by the runtime network layer). */
  allowedHosts: string[];
}

const kebab = /^[a-z0-9][a-z0-9-]*$/;

export const dataPolicySchema: Schema<ProviderDataPolicy> = s.object({
  cacheAllowed: s.boolean(),
  rawPayloadRetentionAllowed: s.boolean(),
  normalizedRetentionAllowed: s.boolean(),
  maxRetentionSeconds: s.optional(s.number({ min: 0 })),
  redistributionAllowed: s.boolean(),
  offlinePackAllowed: s.boolean(),
  exportAllowed: s.boolean(),
  commercialUseAllowed: s.enum([true, false, 'conditional', 'unknown'] as const),
  attributionRequired: s.boolean(),
  attributionText: s.optional(s.string({ max: 500 })),
  termsUrl: s.optional(s.string({ max: 2048 })),
}) as Schema<ProviderDataPolicy>;

export const refreshPolicySchema: Schema<RefreshPolicy> = s.refine(
  s.object({
    intervalMs: s.number({ min: 0 }),
    minIntervalMs: s.number({ min: 0 }),
    timeoutMs: s.number({ min: 100, max: 600_000 }),
    maxRetries: s.number({ min: 0, max: 20, integer: true }),
    maxRequestsPerMinute: s.number({ min: 0, max: 100_000 }),
    staleWhileErrorMs: s.number({ min: 0 }),
    freshness: s.optional(s.record(s.object({ liveSeconds: s.number({ min: 0 }), recentSeconds: s.number({ min: 0 }), expireSeconds: s.optional(s.number({ min: 0 })) }), { keyPattern: kebab })),
  }),
  (r) => (r.intervalMs && r.intervalMs < r.minIntervalMs ? 'intervalMs below minIntervalMs' : undefined),
) as Schema<RefreshPolicy>;

export const manifestSchema: Schema<ProviderManifest> = s.refine(
  s.object({
    id: s.string({ min: 2, max: 64, pattern: kebab }),
    name: s.string({ min: 1, max: 120 }),
    version: s.string({ min: 1, max: 32, pattern: /^\d+\.\d+\.\d+/ }),
    description: s.optional(s.string({ max: 500 })),
    objectTypes: s.array(s.string({ min: 1, max: 64, pattern: kebab }), { min: 1, max: 32 }),
    categories: s.array(s.string({ min: 1, max: 64, pattern: kebab }), { min: 1, max: 16 }),
    transport: s.enum(['http', 'websocket', 'filesystem', 'local-process', 'hardware'] as const),
    capabilities: s.object({ live: s.boolean(), historical: s.boolean(), offline: s.boolean(), boundsQuery: s.boolean() }),
    credentials: s.array(
      s.object({
        key: s.string({ min: 1, max: 128, pattern: /^[a-zA-Z0-9_.-]+$/ }),
        label: s.string({ min: 1, max: 120 }),
        required: s.boolean(),
        helpUrl: s.optional(s.string({ max: 2048 })),
        kind: s.enum(['api-key', 'token', 'basic', 'url'] as const),
      }),
      { max: 8 },
    ),
    refreshPolicy: refreshPolicySchema,
    dataPolicy: dataPolicySchema,
    attribution: s.object({ text: s.string({ min: 1, max: 500 }), url: s.optional(s.string({ max: 2048 })), onScreen: s.optional(s.boolean()), licenseId: s.optional(s.string({ max: 100 })) }),
    commercialReview: s.enum(['approved', 'conditional', 'excluded', 'manual-review-required'] as const),
    enabledByDefault: s.boolean(),
    allowedHosts: s.array(s.string({ min: 1, max: 253, pattern: /^[a-z0-9.-]+$/ }), { max: 64 }),
  }),
  (m) => {
    if (m.enabledByDefault && (m.commercialReview === 'excluded' || m.commercialReview === 'manual-review-required')) return 'excluded/manual-review providers cannot be enabled by default';
    if (m.dataPolicy.attributionRequired && !m.dataPolicy.attributionText && !m.attribution.text) return 'attributionRequired but no attribution text';
    if (m.transport === 'http' || m.transport === 'websocket') {
      if (m.allowedHosts.length === 0) return 'network providers must declare allowedHosts';
    }
    if (m.dataPolicy.offlinePackAllowed && !m.dataPolicy.redistributionAllowed) return 'offlinePackAllowed requires redistributionAllowed';
    return undefined;
  },
) as Schema<ProviderManifest>;

/**
 * Policy helpers used by the history store, worldpack builder and exporter.
 * These are the single source of truth for "what may we keep".
 */
export function retentionCapSeconds(policy: ProviderDataPolicy, requestedSeconds: number | undefined): number | undefined {
  if (!policy.normalizedRetentionAllowed) return 0;
  if (policy.maxRetentionSeconds === undefined) return requestedSeconds;
  return requestedSeconds === undefined ? policy.maxRetentionSeconds : Math.min(requestedSeconds, policy.maxRetentionSeconds);
}

export function mayPersistRaw(policy: ProviderDataPolicy): boolean {
  return policy.rawPayloadRetentionAllowed;
}

export function mayIncludeInWorldpack(policy: ProviderDataPolicy): boolean {
  return policy.offlinePackAllowed && policy.redistributionAllowed;
}

export function mayExport(policy: ProviderDataPolicy): boolean {
  return policy.exportAllowed;
}

export function isCommerciallyDistributable(manifest: ProviderManifest): boolean {
  return manifest.commercialReview === 'approved' || manifest.commercialReview === 'conditional';
}

export function formatIssuesForManifest(issues: Array<{ path: string; message: string }>): string {
  return issues.slice(0, 6).map((i) => `${i.path || '<root>'}: ${i.message}`).join('; ');
}
