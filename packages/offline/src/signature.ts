import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

/**
 * Pack signatures (ADR-007, roadmap 0.2): who built a pack, not only whether it arrived intact.
 *
 * A signed `.worldpack` carries `manifest.sig` beside `manifest.json`: an Ed25519 signature
 * over the manifest's exact bytes, with the signer's public key. The manifest already holds
 * a SHA-256 for every file, so signing it signs the whole pack. The signature file is never
 * listed in the manifest (it cannot be: it signs the manifest).
 *
 * Three answers, kept apart:
 *   - unsigned  — no signature file. Integrity is still checked file by file; who built the
 *                 pack is not known.
 *   - invalid   — a signature file that is malformed, or does not verify against these
 *                 manifest bytes. The pack was altered after signing, or the file is forged:
 *                 always refused, whatever the trust settings.
 *   - signed    — verifies. `trusted` says whether the key is one the operator has added as a
 *                 publisher; a valid signature from an unknown key proves only that the pack
 *                 is unchanged since that key signed it.
 *
 * Trust compares the full public key, never the short key id, which is for reading aloud.
 * Nothing here trusts a key by default: there is no built-in publisher (a key is made and
 * kept by a person — `pnpm worldpack keygen`).
 */
export const WORLDPACK_SIGNATURE_PATH = 'manifest.sig';
export const SIGNATURE_FORMAT = 'worldview-pack-signature@1';
export const PUBLISHER_KEY_FORMAT = 'worldview-pack-publisher@1';
export const MAX_SIGNATURE_BYTES = 4096;

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PackSignatureFile {
  format: typeof SIGNATURE_FORMAT;
  algorithm: 'ed25519';
  keyId: string;
  /** Base64 of the 32-byte raw Ed25519 public key. */
  publicKey: string;
  /** Base64 of the 64-byte signature over manifest.json's bytes. */
  signature: string;
}

export interface TrustedPublisher {
  keyId: string;
  /** Base64 raw public key. */
  publicKey: string;
  name: string;
  addedAt: string;
}

export type PackSignature =
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: string }
  /** Well-formed, but this runtime could not run the check (no Ed25519): not proof either way. */
  | { status: 'unchecked'; keyId: string; publicKey: string; reason: string }
  | { status: 'signed'; keyId: string; publicKey: string; trusted: boolean; publisher?: string };

/** Short, readable id of a raw public key: the first 16 hex digits of its SHA-256. */
export function keyIdOf(rawPublicKey: Uint8Array): string {
  return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16);
}

/** `a1b2 c3d4 e5f6 0718` — how a key id is shown to a person comparing it by eye. */
export function formatKeyId(keyId: string): string {
  return keyId.replace(/(.{4})(?=.)/g, '$1 ');
}

function rawKey(b64: string): Buffer | undefined {
  if (!B64.test(b64)) return undefined;
  const raw = Buffer.from(b64, 'base64');
  return raw.length === 32 ? raw : undefined;
}

/** A new Ed25519 key pair: the private key as PKCS#8 PEM, the public key raw in base64. */
export function generatePackKeyPair(): { privateKeyPem: string; publicKey: string; keyId: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = spki.subarray(ED25519_SPKI_PREFIX.length);
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: raw.toString('base64'),
    keyId: keyIdOf(raw),
  };
}

/** The public half of a private key (PEM), raw in base64. */
export function publicKeyOf(privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
}

/** Sign a manifest's exact bytes; the result is the content of `manifest.sig`. */
export function signManifest(manifestBytes: Uint8Array, privateKeyPem: string): Uint8Array {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
  const publicKey = publicKeyOf(privateKeyPem);
  const file: PackSignatureFile = {
    format: SIGNATURE_FORMAT,
    algorithm: 'ed25519',
    keyId: keyIdOf(Buffer.from(publicKey, 'base64')),
    publicKey,
    signature: sign(null, manifestBytes, key).toString('base64'),
  };
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** What a signature file says about these manifest bytes, against the operator's publishers. */
export function checkSignature(
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array | undefined,
  trusted: readonly TrustedPublisher[] = [],
): PackSignature {
  if (signatureBytes === undefined) return { status: 'unsigned' };
  if (signatureBytes.length > MAX_SIGNATURE_BYTES)
    return { status: 'invalid', reason: `${WORLDPACK_SIGNATURE_PATH} is larger than ${MAX_SIGNATURE_BYTES} bytes` };
  let file: Partial<PackSignatureFile>;
  try {
    file = JSON.parse(Buffer.from(signatureBytes).toString('utf8')) as Partial<PackSignatureFile>;
  } catch {
    return { status: 'invalid', reason: `${WORLDPACK_SIGNATURE_PATH} is not JSON` };
  }
  if (!file || typeof file !== 'object' || file.format !== SIGNATURE_FORMAT)
    return { status: 'invalid', reason: `${WORLDPACK_SIGNATURE_PATH} is not a ${SIGNATURE_FORMAT} file` };
  if (file.algorithm !== 'ed25519') return { status: 'invalid', reason: 'unsupported signature algorithm' };
  const raw = typeof file.publicKey === 'string' ? rawKey(file.publicKey) : undefined;
  if (!raw) return { status: 'invalid', reason: 'public key is not a 32-byte Ed25519 key' };
  const keyId = keyIdOf(raw);
  if (file.keyId !== keyId) return { status: 'invalid', reason: 'key id does not belong to the public key' };
  const sig =
    typeof file.signature === 'string' && B64.test(file.signature) ? Buffer.from(file.signature, 'base64') : null;
  if (!sig || sig.length !== 64) return { status: 'invalid', reason: 'signature is not 64 bytes' };
  let ok: boolean;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    ok = verify(null, manifestBytes, key, sig);
  } catch (err) {
    return {
      status: 'unchecked',
      keyId,
      publicKey: file.publicKey!,
      reason: `Ed25519 is not available here: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!ok)
    return { status: 'invalid', reason: 'signature does not match the manifest — the pack changed after signing' };
  const publisher = trusted.find((t) => t.publicKey === file.publicKey);
  return {
    status: 'signed',
    keyId,
    publicKey: file.publicKey!,
    trusted: publisher !== undefined,
    ...(publisher ? { publisher: publisher.name } : {}),
  };
}

/** The shareable public half: what a publisher hands out for others to trust. */
export interface PublisherKeyFile {
  format: typeof PUBLISHER_KEY_FORMAT;
  name: string;
  keyId: string;
  publicKey: string;
}

export function publisherKeyFile(name: string, publicKey: string): string {
  const raw = rawKey(publicKey);
  if (!raw) throw new Error('not a 32-byte Ed25519 public key');
  const file: PublisherKeyFile = { format: PUBLISHER_KEY_FORMAT, name, keyId: keyIdOf(raw), publicKey };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A publisher key file → its name and key, or why it is not one. */
export function parsePublisherKeyFile(text: string):
  | { ok: true; name: string; publicKey: string; keyId: string }
  | {
      ok: false;
      reason: string;
    } {
  let file: Partial<PublisherKeyFile>;
  try {
    file = JSON.parse(text) as Partial<PublisherKeyFile>;
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!file || typeof file !== 'object' || file.format !== PUBLISHER_KEY_FORMAT)
    return { ok: false, reason: `not a ${PUBLISHER_KEY_FORMAT} file` };
  const raw = typeof file.publicKey === 'string' ? rawKey(file.publicKey) : undefined;
  if (!raw) return { ok: false, reason: 'public key is not a 32-byte Ed25519 key' };
  const keyId = keyIdOf(raw);
  if (file.keyId !== undefined && file.keyId !== keyId) return { ok: false, reason: 'key id does not match the key' };
  const name = typeof file.name === 'string' ? file.name.trim().slice(0, 80) : '';
  return { ok: true, name: name || `Publisher ${formatKeyId(keyId)}`, publicKey: file.publicKey!, keyId };
}
