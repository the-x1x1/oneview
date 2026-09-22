import type { ConfidenceClass, FreshnessClass, SeverityClass } from '@worldview/world-model';
import type { ConnectionState, SourceHealthEntry } from '@worldview/source-health';
import { describeStatus } from '@worldview/source-health';

/** Provider status as exposed through source-health (ui does not depend on provider-sdk directly). */
export type ProviderStatus = SourceHealthEntry['health']['status'];
import './status-badge.css';

export type StatusBadgeProps =
  | { kind: 'freshness'; value: FreshnessClass; size?: 'sm' | 'md' | undefined; title?: string | undefined }
  | { kind: 'connection'; value: ConnectionState; size?: 'sm' | 'md' | undefined; title?: string | undefined }
  | { kind: 'provider'; value: ProviderStatus; size?: 'sm' | 'md' | undefined; title?: string | undefined }
  | { kind: 'severity'; value: SeverityClass; size?: 'sm' | 'md' | undefined; title?: string | undefined }
  | { kind: 'confidence'; value: ConfidenceClass; size?: 'sm' | 'md' | undefined; title?: string | undefined }
  | { kind: 'recorded'; value?: undefined; size?: 'sm' | 'md' | undefined; title?: string | undefined }
  | { kind: 'cached'; value?: undefined; size?: 'sm' | 'md' | undefined; title?: string | undefined };

const FRESHNESS_LABEL: Record<FreshnessClass, string> = {
  LIVE: 'LIVE',
  RECENT: 'RECENT',
  STALE: 'STALE',
  HISTORICAL: 'HISTORICAL',
  UNKNOWN: 'UNKNOWN',
};
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  CONNECTED: 'LIVE',
  DEGRADED: 'DEGRADED',
  OFFLINE: 'OFFLINE',
};
const SEVERITY_LABEL: Record<SeverityClass, string> = {
  INFO: 'Info',
  MINOR: 'Minor',
  MODERATE: 'Moderate',
  SEVERE: 'Severe',
  EXTREME: 'Extreme',
};
const CONFIDENCE_LABEL: Record<ConfidenceClass, string> = {
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
  UNKNOWN: 'Unknown confidence',
};

/** Text and semantic token suffix for a badge; exported so tests can assert labels without rendering. */
export function badgeLabel(props: StatusBadgeProps): { text: string; tone: string } {
  switch (props.kind) {
    case 'freshness':
      return { text: FRESHNESS_LABEL[props.value], tone: `fresh-${props.value.toLowerCase()}` };
    case 'connection':
      return { text: CONNECTION_LABEL[props.value], tone: `conn-${props.value.toLowerCase()}` };
    case 'provider':
      return { text: describeStatus(props.value), tone: `status-${props.value.toLowerCase().replace(/_/g, '-')}` };
    case 'severity':
      return { text: SEVERITY_LABEL[props.value], tone: `sev-${props.value.toLowerCase()}` };
    case 'confidence':
      return { text: CONFIDENCE_LABEL[props.value], tone: `conf-${props.value.toLowerCase()}` };
    case 'recorded':
      return { text: 'RECORDED DATA', tone: 'recorded' };
    case 'cached':
      return { text: 'cached', tone: 'cached' };
  }
}

/** Compact pill with a status dot; colour comes from the semantic tokens, text always carries the meaning. */
export function StatusBadge(props: StatusBadgeProps) {
  const { text, tone } = badgeLabel(props);
  const size = props.size ?? 'md';
  return (
    <span
      className={`wv-badge wv-badge--${size} wv-badge--${tone}`}
      data-kind={props.kind}
      data-value={props.value ?? ''}
      title={props.title}
    >
      <span className="wv-badge__dot" aria-hidden="true" />
      <span className="wv-badge__text">{text}</span>
    </span>
  );
}

export interface SourceBadgeProps {
  name: string;
  status: ProviderStatus;
  /** Provider id used for data attribute (never displayed). */
  providerId?: string | undefined;
  size?: 'sm' | 'md' | undefined;
  onClick?: (() => void) | undefined;
}

/** Provider name with its health status; clickable when a handler is given (opens the source row). */
export function SourceBadge({ name, status, providerId, size = 'md', onClick }: SourceBadgeProps) {
  const tone = `status-${status.toLowerCase().replace(/_/g, '-')}`;
  const content = (
    <>
      <span className={`wv-badge__dot wv-badge__dot--${tone}`} aria-hidden="true" />
      <span className="wv-source-badge__name wv-truncate">{name}</span>
      <span className="wv-source-badge__status">{describeStatus(status)}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`wv-source-badge wv-source-badge--${size} wv-source-badge--button`}
        data-provider={providerId}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={`wv-source-badge wv-source-badge--${size}`} data-provider={providerId}>
      {content}
    </span>
  );
}
