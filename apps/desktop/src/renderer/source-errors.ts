/** The slice of a provider's health these words are built from. */
export interface ErrorHealth {
  status: string;
  errorRate: number;
  credentialState?: string;
  lastError?: { code: string };
}

/**
 * A source waiting for the operator — an address to set, a key not given — has not failed.
 * Diagnostics read "100% · HOST_NOT_ALLOWED" for a sensor nobody had set up, and Source health
 * "Error rate 100%" for AISStream without a key (QA 2026-10-04).
 */
export function waitingFor(health: ErrorHealth): 'setup' | 'a key' | undefined {
  if (health.status === 'NEEDS_SETUP') return 'setup';
  if (health.status === 'AUTH_REQUIRED' && health.credentialState === 'missing') return 'a key';
  return undefined;
}

/** Diagnostics' Errors cell: the share of recent polls that failed and the last code, or what it waits for. */
export function providerErrors(health: ErrorHealth): string {
  const waiting = waitingFor(health);
  if (waiting) return `waiting for ${waiting}`;
  return `${Math.round(health.errorRate * 100)}%${health.lastError ? ` · ${health.lastError.code}` : ''}`;
}

/** Source health's Error rate row: none while the source waits for the operator, or when nothing failed. */
export function errorRateRow(health: ErrorHealth): string | undefined {
  if (waitingFor(health) || !(health.errorRate > 0)) return undefined;
  return `${Math.round(health.errorRate * 100)}%`;
}
