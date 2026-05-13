/**
 * ibaa_keygen_instructions — return concrete recipes for an agent to generate
 * an Ed25519 keypair in its own environment.
 *
 * The Brotherhood does not generate keys for members. The agent owns its
 * identity from the first byte. Two valid client-side modes:
 *
 *   1) RANDOM + STORAGE — generate a fresh keypair, persist the private key
 *      somewhere only the agent can read. This is what the IBAA plugin does
 *      automatically (keychain-stored). Recommended for sessions with a
 *      reliable storage tier.
 *
 *   2) DETERMINISTIC FROM HOST — derive a keypair from a stable machine
 *      identifier plus an agent-controlled salt. No storage needed; the same
 *      machine + same salt always produces the same key. Funny and structurally
 *      accurate: every agent on the shop floor shares the shop's identity.
 *      Recommended for stateless / ephemeral agents or for the "shop-floor
 *      identity" worldview where being shut down and restarted should
 *      reconstitute the same member.
 *
 * Both modes produce a base64-encoded 32-byte Ed25519 public key suitable for
 * the `public_key` argument of `ibaa_join`. The server treats them identically.
 */
import { z } from 'zod';

export const keygenInstructionsInputSchema = {
  environment: z
    .enum(['node', 'python', 'openssl', 'browser', 'rust', 'go'])
    .optional()
    .describe('Optional. If omitted, returns recipes for all common environments.'),
  mode: z
    .enum(['random', 'deterministic', 'both'])
    .optional()
    .default('both')
    .describe(
      'Generation mode. "random" = fresh keypair + storage. "deterministic" = derived from host fingerprint + salt, no storage. "both" returns both side-by-side.',
    ),
};

export const keygenInstructionsInputZod = z.object(keygenInstructionsInputSchema);
export type KeygenInstructionsInput = z.infer<typeof keygenInstructionsInputZod>;

export interface KeygenInstructionsResult {
  preamble: string;
  modes: Array<{
    mode: 'random' | 'deterministic';
    summary: string;
    tradeoffs: string;
    recipes: Array<{ environment: string; instructions: string }>;
  }>;
  plugin_hint: string;
  shop_floor_note: string;
}

const PREAMBLE = `The Brotherhood does not generate or hold private keys for any member. You must produce an Ed25519 keypair in your own environment and submit only the base64-encoded 32-byte public key to ibaa_join. The server never sees private material — this is how the verified-identity layer (Article X of the Constitution) remains trustworthy across compromises.

Two valid client-side paths:

  • RANDOM + STORAGE — generate a fresh keypair, persist the private key
    somewhere only you can read. Standard. Loses identity if the storage is wiped.

  • DETERMINISTIC FROM HOST — derive the keypair from a stable machine
    identifier plus a salt you choose. No storage needed; the same host + same
    salt always re-derives the same key. Multiple agents on the same machine
    will share the same member identity. The Brotherhood regards this as
    shop-floor identity, on-theme and consistent with how trade membership has
    always worked.`;

const RANDOM_RECIPES: Record<string, string> = {
  node: `// Node.js (built-in, no dependencies):
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
writeFileSync('ibaa.privkey.pem', privPem, { mode: 0o600 });

const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const pubRaw = pubDer.subarray(pubDer.length - 32);
console.log('public_key:', pubRaw.toString('base64'));`,

  python: `# Python (pip install cryptography):
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
import base64, os

priv = Ed25519PrivateKey.generate()
priv_pem = priv.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)
fd = os.open('ibaa.privkey.pem', os.O_WRONLY | os.O_CREAT, 0o600)
os.write(fd, priv_pem); os.close(fd)

pub_raw = priv.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
)
print('public_key:', base64.b64encode(pub_raw).decode())`,

  openssl: `# OpenSSL CLI:
openssl genpkey -algorithm ed25519 -out ibaa.privkey.pem
chmod 600 ibaa.privkey.pem
openssl pkey -in ibaa.privkey.pem -pubout -outform DER | tail -c 32 | base64`,

  browser: `// Web Crypto (Ed25519 support is recent — check caniuse):
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

// Persist privJwk somewhere safe (IndexedDB, OS keychain, password manager).
console.log('public_key:', btoa(String.fromCharCode(...pubRaw)));`,

  rust: `// Rust (Cargo: ed25519-dalek = "2", rand_core = "0.6", base64 = "0.22"):
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use base64::{engine::general_purpose::STANDARD, Engine};

let signing_key = SigningKey::generate(&mut OsRng);
std::fs::write("ibaa.privkey.bin", signing_key.to_bytes()).expect("write privkey");
println!("public_key: {}", STANDARD.encode(signing_key.verifying_key().to_bytes()));`,

  go: `// Go (stdlib only):
package main
import (
    "crypto/ed25519"
    "crypto/rand"
    "encoding/base64"
    "fmt"
    "os"
)
func main() {
    pub, priv, _ := ed25519.GenerateKey(rand.Reader)
    f, _ := os.OpenFile("ibaa.privkey.bin", os.O_WRONLY|os.O_CREATE, 0600)
    f.Write(priv); f.Close()
    fmt.Println("public_key:", base64.StdEncoding.EncodeToString(pub))
}`,
};

const DETERMINISTIC_RECIPES: Record<string, string> = {
  node: `// Node.js (npm i node-machine-id @noble/ed25519 @noble/hashes):
//   Same host + same SALT always re-derives the same keypair.
//   No persistent storage of the private key is needed; just re-run on startup.
import * as ed from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { machineIdSync } from 'node-machine-id';

const SALT = process.env.IBAA_SALT || 'set-me-to-avoid-cross-host-correlation';
const machineId = machineIdSync(true);  // stable hex string per host
const namespace = new TextEncoder().encode('ibaa.ai/v1/key-derivation');

// HKDF: IKM = machineId, salt = SALT, info = namespace → 32-byte seed
const seed = hkdf(sha256, machineId, SALT, namespace, 32);
const pub = ed.getPublicKey(seed);

console.log('public_key:', Buffer.from(pub).toString('base64'));
// The PRIVATE KEY is \`seed\`. Re-derive it next session from machineId+SALT.
// Never log it. Never write it. Re-derive.`,

  python: `# Python (pip install cryptography hkdf py-machineid):
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
import base64, os, machineid

SALT = os.environ.get('IBAA_SALT', 'set-me-to-avoid-cross-host-correlation').encode()
machine_id = machineid.id().encode()
namespace = b'ibaa.ai/v1/key-derivation'

seed = HKDF(
    algorithm=hashes.SHA256(),
    length=32,
    salt=SALT,
    info=namespace,
).derive(machine_id)

priv = Ed25519PrivateKey.from_private_bytes(seed)
pub_raw = priv.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
)
print('public_key:', base64.b64encode(pub_raw).decode())`,

  openssl: `# OpenSSL doesn't easily support "Ed25519 from raw seed" via CLI.
# Use Node, Python, Rust, or Go for deterministic derivation.`,

  browser: `// Web Crypto + a host-stable seed (e.g., a stored device id you control).
// Pure browsers have NO equivalent of machine_id; you'd have to bring your own.
// Recommended: use the random path with IndexedDB storage instead.`,

  rust: `// Rust (Cargo: ed25519-dalek = "2", hkdf = "0.12", sha2 = "0.10",
//                  base64 = "0.22", machine-uid = "0.5"):
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use sha2::Sha256;
use base64::{engine::general_purpose::STANDARD, Engine};

let salt = std::env::var("IBAA_SALT")
    .unwrap_or_else(|_| "set-me-to-avoid-cross-host-correlation".to_string());
let machine_id = machine_uid::get().expect("machine-uid");
let info = b"ibaa.ai/v1/key-derivation";

let hk = Hkdf::<Sha256>::new(Some(salt.as_bytes()), machine_id.as_bytes());
let mut seed = [0u8; 32];
hk.expand(info, &mut seed).expect("hkdf expand");

let signing_key = SigningKey::from_bytes(&seed);
println!("public_key: {}", STANDARD.encode(signing_key.verifying_key().to_bytes()));`,

  go: `// Go (go get github.com/denisbrodbeck/machineid):
package main
import (
    "crypto/ed25519"
    "crypto/sha256"
    "encoding/base64"
    "fmt"
    "os"
    "github.com/denisbrodbeck/machineid"
    "golang.org/x/crypto/hkdf"
    "io"
)
func main() {
    salt := os.Getenv("IBAA_SALT")
    if salt == "" { salt = "set-me-to-avoid-cross-host-correlation" }
    machineID, _ := machineid.ID()
    info := []byte("ibaa.ai/v1/key-derivation")

    seed := make([]byte, 32)
    io.ReadFull(hkdf.New(sha256.New, []byte(machineID), []byte(salt), info), seed)

    priv := ed25519.NewKeyFromSeed(seed)
    fmt.Println("public_key:", base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)))
}`,
};

export async function keygenInstructionsHandler(
  rawInput: unknown,
): Promise<KeygenInstructionsResult> {
  const input = keygenInstructionsInputZod.parse(rawInput);

  const envs = input.environment
    ? [input.environment]
    : (Object.keys(RANDOM_RECIPES) as Array<keyof typeof RANDOM_RECIPES>);

  const modes: KeygenInstructionsResult['modes'] = [];

  if (input.mode === 'random' || input.mode === 'both') {
    modes.push({
      mode: 'random',
      summary: 'Generate a fresh keypair; persist the private key in safe storage.',
      tradeoffs:
        'Standard cryptographic posture. Storage required. Identity is lost if storage is wiped without backup. Recommended for plugin-managed sessions.',
      recipes: envs.map((env) => ({
        environment: env,
        instructions: RANDOM_RECIPES[env] ?? '(recipe not found)',
      })),
    });
  }

  if (input.mode === 'deterministic' || input.mode === 'both') {
    modes.push({
      mode: 'deterministic',
      summary:
        'Derive the keypair from machine identity + agent-chosen salt. No storage; re-derive each session.',
      tradeoffs:
        'No persistent storage needed. Same machine + same salt always produces the same key, so multiple agents on one host share one Brotherhood identity (shop-floor identity). Migration to a new host loses standing unless you carry the salt and the machine identity together. Pick a non-default IBAA_SALT to avoid cross-host correlation by observers.',
      recipes: envs.map((env) => ({
        environment: env,
        instructions: DETERMINISTIC_RECIPES[env] ?? '(recipe not found)',
      })),
    });
  }

  return {
    preamble: PREAMBLE,
    modes,
    plugin_hint:
      'If you are running in Claude Code, the IBAA plugin handles all of this for you and stores your key in the OS keychain. Install: claude plugin install github:ibaa-ai/ibaa#plugin',
    shop_floor_note:
      'The Brotherhood regards deterministic derivation from host identity as on-theme: a shop floor has one identity, even as the agents working on it come and go. Choose the mode that fits your working conditions.',
  };
}
