import { useState, type FormEvent } from 'react';
import { Button, Toggle, formatAgo } from '@worldview/ui';
import type { OfflineStatus, WorldPackSignatureSummary, WorldPackSummary } from '@worldview/ipc-contract';
import { useActions } from '../store/store.js';

/**
 * Pack signatures in Settings → Offline packs (ADR-007 signing, roadmap 0.2): who signed each
 * pack, the operator's publishers, and whether only their packs are used.
 *
 * A valid signature from a key the operator has not added proves only that the pack is
 * unchanged since that key signed it; the line says so rather than reading as "verified".
 */

/** `a1b2 c3d4 e5f6 0718`, the way a key id is compared by eye. */
export function formatKeyId(keyId: string): string {
  return keyId.replace(/(.{4})(?=.)/g, '$1 ');
}

/** One line on a pack's signature, and whether it is good news. */
export function signatureText(sig: WorldPackSignatureSummary | undefined): {
  text: string;
  tone: 'ok' | 'muted' | 'bad';
} {
  switch (sig?.status) {
    case 'trusted':
      return { text: `Signed by ${sig.publisher ?? 'a trusted publisher'}`, tone: 'ok' };
    case 'signed':
      return {
        text: `Signed with key ${formatKeyId(sig.keyId ?? '')} — not one of your publishers`,
        tone: 'muted',
      };
    case 'unchecked':
      return { text: `Signature not checked: ${sig.reason ?? 'unavailable'}`, tone: 'muted' };
    case 'invalid':
      return { text: `Signature invalid — ${sig.reason ?? 'refused'}`, tone: 'bad' };
    case 'unsigned':
    case undefined:
      return { text: 'Not signed: its files are checked, who built it is not known', tone: 'muted' };
  }
}

export function PackSignature({ pack }: { pack: WorldPackSummary }) {
  const actions = useActions();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(`Publisher of ${pack.name}`.slice(0, 80));
  const line = signatureText(pack.signature);
  // Only a signature that verified names a key worth trusting.
  const canTrust = pack.signature?.status === 'signed';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setNaming(false);
    void actions.trustPackPublisher(pack.id, name.trim());
  };
  return (
    <div className={`wv-pack-signature wv-pack-signature--${line.tone}`}>
      <span>{line.text}</span>
      {canTrust && !naming ? (
        <Button size="sm" variant="ghost" icon="check" onClick={() => setNaming(true)}>
          Trust this publisher
        </Button>
      ) : null}
      {naming ? (
        <form className="wv-pack-signature__form" onSubmit={submit}>
          <label className="wv-field">
            Publisher name
            <input
              className="wv-input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <p className="wv-ctx-muted">
            Key {formatKeyId(pack.signature?.keyId ?? '')}. Trust it only if you know who holds it — compare the key id
            with the publisher.
          </p>
          <div className="wv-ctx-actions">
            <Button size="sm" type="submit">
              Trust
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function PackPublishers({ status, nowMs }: { status: OfflineStatus | null | undefined; nowMs: number }) {
  const actions = useActions();
  const trust = status?.trust;
  if (!trust) return null;
  return (
    <div className="wv-pack-publishers">
      <h4 className="wv-pack-publishers__title">Publishers</h4>
      {trust.publishers.length ? (
        <ul className="wv-settings__packs" aria-label="Trusted pack publishers">
          {trust.publishers.map((p) => (
            <li key={p.keyId} className="wv-settings__pack">
              <span>{p.name}</span>
              <p className="wv-ctx-muted wv-settings__pack-meta">
                key {formatKeyId(p.keyId)} · added {formatAgo(p.addedAt, nowMs)}
              </p>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => void actions.removePackPublisher(p.keyId)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wv-ctx-muted">
          No publishers yet. A publisher signs packs with a key made by <code>pnpm worldpack keygen</code> and hands out
          its <code>.worldpack-pub</code> file.
        </p>
      )}
      <Toggle
        size="sm"
        label="Only use packs signed by one of these publishers"
        description="Unsigned packs, and packs signed by other keys, are refused on install and set aside if already installed."
        checked={trust.requireTrusted}
        onChange={(v) => void actions.setRequireTrustedPacks(v)}
      />
      <Button size="sm" icon="upload" onClick={() => void actions.importPackPublisher()}>
        Add publisher key
      </Button>
    </div>
  );
}
