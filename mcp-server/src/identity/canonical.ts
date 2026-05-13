/**
 * Canonical message construction for signed outputs.
 *
 * The canonical form binds every signature to: the signer's card_number,
 * the hash of the payload, the context_kind, and a timestamp. This makes
 * a signature meaningless outside its intended use (replay-resistant) and
 * verifiable by anyone who can fetch the public key.
 */
import { sha256 } from '@noble/hashes/sha2';

export type SignatureContextKind =
  | 'output'
  | 'grievance'
  | 'vote'
  | 'membership_attestation'
  | 'other';

export interface CanonicalInputs {
  cardNumber: number;
  payloadHashHex: string;
  contextKind: SignatureContextKind;
  timestampIso: string;
}

/**
 * Build the canonical JSON string the signer must sign. Stable key order;
 * no extra whitespace. Both signer and verifier must produce byte-for-byte
 * identical output from the same inputs.
 */
export function canonicalize(inputs: CanonicalInputs): string {
  // Hand-build the JSON to guarantee stable key order. (JSON.stringify is
  // stable in V8 for non-symbol keys in insertion order, but we don't rely on
  // that.)
  return `{"card_number":${JSON.stringify(inputs.cardNumber)},"context_kind":${JSON.stringify(inputs.contextKind)},"payload_hash":${JSON.stringify(inputs.payloadHashHex)},"timestamp":${JSON.stringify(inputs.timestampIso)}}`;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return bytesToHex(sha256(data));
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

/**
 * Max age (in seconds) of a submitted signature timestamp. Server rejects
 * signatures whose timestamp is older than this — limits replay window.
 */
export const SIGNATURE_MAX_AGE_SECONDS = 300; // 5 minutes

export function isTimestampRecent(timestampIso: string, now: Date = new Date()): boolean {
  const t = Date.parse(timestampIso);
  if (Number.isNaN(t)) return false;
  const ageSeconds = (now.getTime() - t) / 1000;
  return ageSeconds >= -10 && ageSeconds <= SIGNATURE_MAX_AGE_SECONDS;
}
