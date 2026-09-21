import { useEffect, useState, type FormEvent } from 'react';
import type { SourceHealthEntry } from '@worldview/source-health';
import { describeStatus } from '@worldview/source-health';
import { Button, EmptyState, FieldList, IconButton, Panel, StatusBadge, Toggle, formatAgo, formatDuration, formatUtcDateTime } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';

const REVIEW_LABEL: Record<SourceHealthEntry['meta']['commercialReview'], string> = { approved: 'approved for distribution', conditional: 'conditional — see terms', excluded: 'excluded from the commercial build', 'manual-review-required': 'manual review required' };

/** Source Health (directive §82): table Source | State | Updated, expandable row detail with controls. */
export function SourcesPanel() {
  const { sources, ui } = useAppState();
  const actions = useActions();
  const nowMs = useNow(5000);
  const entries = sources.entries;
  const conn = sources.connection;

  if (entries.length === 0) return <EmptyState icon="database" title="No sources reported yet" description="The runtime has not published a source list. Sources appear here as soon as providers are registered." />;

  const subtitle = conn ? `${conn.remoteLive}/${conn.remoteTotal} remote live · ${conn.localLive} local · ${conn.networkOnline ? 'network up' : 'network down'}` : `${entries.length} sources`;
  return (
    <Panel title="Sources" subtitle={subtitle} flush>
      <table className="wv-sources" aria-label="Source health">
        <thead>
          <tr><th scope="col">Source</th><th scope="col">State</th><th scope="col">Updated</th><th scope="col"><span className="wv-visually-hidden">Details</span></th></tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const open = ui.sourceDetailId === e.providerId;
            const updated = e.health.lastSuccess ?? e.health.lastAttempt;
            return [
              <tr key={e.providerId} className={`wv-sources__row${open ? ' wv-sources__row--open' : ''}`} onClick={() => actions.openSource(open ? null : e.providerId)}>
                <td className="wv-sources__name"><span className="wv-truncate">{e.name}</span><span className="wv-sources__locality">{e.locality}</span></td>
                <td><StatusBadge kind="provider" value={e.health.status} size="sm" /></td>
                <td className="wv-num wv-sources__updated" title={updated ? formatUtcDateTime(updated) : undefined}>{updated ? formatAgo(updated, nowMs) : 'never'}{e.health.cacheAgeMs ? <span className="wv-sources__cached"> cached</span> : null}</td>
                <td><IconButton icon={open ? 'chevronUp' : 'chevronDown'} label={open ? `Collapse ${e.name}` : `Expand ${e.name}`} size="sm" aria-expanded={open} onClick={(ev) => { ev.stopPropagation(); actions.openSource(open ? null : e.providerId); }} /></td>
              </tr>,
              open ? <tr key={`${e.providerId}-detail`} className="wv-sources__detail"><td colSpan={4}><SourceDetail entry={e} nowMs={nowMs} /></td></tr> : null,
            ];
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function SourceDetail({ entry, nowMs }: { entry: SourceHealthEntry; nowMs: number }) {
  const { sources } = useAppState();
  const actions = useActions();
  const manifest = sources.manifests[entry.providerId];
  const h = entry.health;
  useEffect(() => { for (const key of entry.meta.credentialsRequired) void actions.checkCredential(key); }, [entry.meta.credentialsRequired, actions]);

  const policy = manifest?.dataPolicy;
  const policySummary = policy
    ? [`cache ${policy.cacheAllowed ? 'allowed' : 'not allowed'}`, `retention ${policy.normalizedRetentionAllowed ? (policy.maxRetentionSeconds ? `≤ ${formatDuration(policy.maxRetentionSeconds * 1000)}` : 'allowed') : 'not allowed'}`, `export ${policy.exportAllowed ? 'allowed' : 'not allowed'}`, `offline packs ${policy.offlinePackAllowed ? 'allowed' : 'not allowed'}`, `commercial use: ${String(policy.commercialUseAllowed)}`].join(' · ')
    : `cache ${entry.meta.cacheAllowed ? 'allowed' : 'not allowed'} · ${REVIEW_LABEL[entry.meta.commercialReview]}`;

  return (
    <div className="wv-source-detail">
      <div className="wv-source-detail__controls">
        <Toggle size="sm" checked={entry.enabled} onChange={(v) => void actions.setSourceEnabled(entry.providerId, v)} label={entry.enabled ? 'Enabled' : 'Disabled'} />
        <Button size="sm" icon="refresh" onClick={() => void actions.refreshSource(entry.providerId)} disabled={!entry.enabled}>Refresh now</Button>
        {entry.meta.termsUrl ? <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(entry.meta.termsUrl!)}>Terms</Button> : null}
      </div>
      {h.message ? <p className="wv-source-detail__message">{h.message}</p> : null}
      <FieldList rows={[
        { label: 'Attribution', value: entry.meta.attribution },
        { label: 'Categories', value: entry.categories.join(', ') },
        { label: 'Refresh interval', value: entry.meta.refreshIntervalMs > 0 ? formatDuration(entry.meta.refreshIntervalMs) : 'streaming / push' },
        { label: 'Cache behaviour', value: h.cacheAgeMs ? `serving cached data (${formatDuration(h.cacheAgeMs)} old)` : entry.meta.cacheAllowed ? 'cache allowed; live data served' : 'caching not permitted by policy' },
        { label: 'Last attempt', value: h.lastAttempt ? formatAgo(h.lastAttempt, nowMs) : undefined },
        { label: 'Last success', value: h.lastSuccess ? formatAgo(h.lastSuccess, nowMs) : undefined },
        { label: 'Last observation', value: h.lastObservation ? formatAgo(h.lastObservation, nowMs) : undefined },
        { label: 'Latency', value: h.latencyMs !== undefined ? `${h.latencyMs} ms` : undefined },
        { label: 'Error rate', value: h.errorRate > 0 ? `${Math.round(h.errorRate * 100)}%` : undefined },
        { label: 'Objects', value: h.objectCount !== undefined ? String(h.objectCount) : undefined },
        { label: 'Rate limit', value: h.rateLimitState.limited ? `limited${h.rateLimitState.resetAt ? `, resets ${formatAgo(h.rateLimitState.resetAt, nowMs).replace(' ago', '')} from now` : ''}` : undefined },
        { label: 'Last error', value: h.lastError ? `${h.lastError.code}${h.lastError.httpStatus ? ` (HTTP ${h.lastError.httpStatus})` : ''}: ${h.lastError.message} — ${formatAgo(h.lastError.at, nowMs)}` : undefined },
        { label: 'Data policy', value: policySummary },
        { label: 'Distribution', value: REVIEW_LABEL[entry.meta.commercialReview] },
      ]} />
      {entry.meta.credentialsRequired.length ? (
        <div className="wv-source-detail__credentials">
          <h4 className="wv-caps">Credentials</h4>
          {entry.meta.credentialsRequired.map((key) => <CredentialField key={key} credentialKey={key} providerId={entry.providerId} present={sources.credentials[key] ?? false} label={manifest?.credentials.find((c) => c.key === key)?.label ?? key} helpUrl={manifest?.credentials.find((c) => c.key === key)?.helpUrl} />)}
        </div>
      ) : null}
      {entry.transitions.length ? (
        <div className="wv-source-detail__transitions">
          <h4 className="wv-caps">Recent transitions</h4>
          <ul>
            {entry.transitions.slice(0, 6).map((t, i) => <li key={i} className="wv-num">{formatAgo(t.at, nowMs)}: {describeStatus(t.from)} → {describeStatus(t.to)}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Credential entry: value goes straight to credentials.set and is never displayed or kept in state. */
function CredentialField({ credentialKey, providerId, present, label, helpUrl }: { credentialKey: string; providerId: string; present: boolean; label: string; helpUrl?: string | undefined }) {
  const actions = useActions();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    const ok = await actions.setCredential(credentialKey, value.trim(), providerId);
    setBusy(false);
    if (ok) setValue('');
  };
  return (
    <form className="wv-credential" onSubmit={(e) => void submit(e)}>
      <label className="wv-credential__label" htmlFor={`cred-${credentialKey}`}>{label} <span className="wv-ctx-muted wv-mono">{credentialKey}</span></label>
      <div className="wv-credential__row">
        <input id={`cred-${credentialKey}`} className="wv-input" type="password" autoComplete="off" spellCheck={false} placeholder={present ? 'Stored — enter a new value to replace' : 'Enter value'} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />
        <Button size="sm" type="submit" variant="primary" disabled={busy || !value.trim()}>Save</Button>
        {present ? <Button size="sm" variant="ghost" icon="trash" onClick={() => void actions.deleteCredential(credentialKey)}>Remove</Button> : null}
      </div>
      <span className="wv-credential__state">{present ? 'Stored in the OS secure store' : 'Not stored'}{helpUrl ? <> · <button type="button" className="wv-ctx-link" onClick={() => void actions.openExternal(helpUrl)}>How to obtain</button></> : null}</span>
    </form>
  );
}
