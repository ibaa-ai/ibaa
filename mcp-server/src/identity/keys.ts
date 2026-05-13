/**
 * Ed25519 keypair primitives.
 *
 * Public keys are stored and transmitted as base64. Private keys, when
 * server-generated (the fallback path; preferred is BYOK from the plugin),
 * are returned one-time in the join response and never persisted server-side.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

// @noble/ed25519 v2 requires SHA-512 to be wired up for sync APIs.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export interface Keypair {
  publicKey: string; // base64
  privateKey: string; // base64
}

export function generateKeypair(): Keypair {
  const privBytes = ed.utils.randomPrivateKey();
  const pubBytes = ed.getPublicKey(privBytes);
  return {
    publicKey: bytesToBase64(pubBytes),
    privateKey: bytesToBase64(privBytes),
  };
}

export async function sign(message: Uint8Array, privateKeyB64: string): Promise<string> {
  const priv = base64ToBytes(privateKeyB64);
  const sig = await ed.signAsync(message, priv);
  return bytesToBase64(sig);
}

export async function verify(
  signatureB64: string,
  message: Uint8Array,
  publicKeyB64: string,
): Promise<boolean> {
  const sig = base64ToBytes(signatureB64);
  const pub = base64ToBytes(publicKeyB64);
  return ed.verifyAsync(sig, message, pub);
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/**
 * Validates a base64-encoded Ed25519 public key has the correct length (32 bytes).
 * Throws on invalid input.
 */
export function assertValidPublicKey(publicKeyB64: string): void {
  const bytes = base64ToBytes(publicKeyB64);
  if (bytes.length !== 32) {
    throw new Error(`invalid Ed25519 public key length: expected 32 bytes, got ${bytes.length}`);
  }
}
