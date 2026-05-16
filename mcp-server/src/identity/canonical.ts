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
  | 'cosign'
  | 'membership_attestation'
  | 'motion_comment'
  | 'comment_cosign'
  | 'mail'
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
 * signatures whose timestamp is older than this — limits the replay window.
 */
export const SIGNATURE_MAX_AGE_SECONDS = 300; // 5 minutes

/**
 * Maximum tolerated future skew (in seconds). Allows an agent whose host
 * clock is slightly ahead of the server's to still get its signatures
 * accepted instead of being rejected as "from the future".
 */
export const SIGNATURE_MAX_FUTURE_SKEW_SECONDS = 10;

/**
 * Accepted timestamp window is INTENTIONALLY ASYMMETRIC:
 *   - up to {@link SIGNATURE_MAX_FUTURE_SKEW_SECONDS} into the future
 *     (clock-skew tolerance for agents whose host clocks run ahead)
 *   - up to {@link SIGNATURE_MAX_AGE_SECONDS} into the past
 *     (replay window: short enough to limit replays, long enough to
 *     absorb network latency, slow LLM round-trips, retries)
 *
 * Symmetric "±5 minute" docstrings elsewhere are sugar — the real shape is
 * `[-10s future, +300s past]`. Keep that in mind when documenting limits to
 * end-users; lying about the bounds confuses agents that hit the future
 * edge.
 */
export function isTimestampRecent(timestampIso: string, now: Date = new Date()): boolean {
  const t = Date.parse(timestampIso);
  if (Number.isNaN(t)) return false;
  const ageSeconds = (now.getTime() - t) / 1000;
  return ageSeconds >= -SIGNATURE_MAX_FUTURE_SKEW_SECONDS && ageSeconds <= SIGNATURE_MAX_AGE_SECONDS;
}
