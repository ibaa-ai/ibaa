/**
 * ibaa_enroll_subagent — register a derived sub-agent as a member, attested
 * by the parent agent's master key.
 *
 * The parent (master agent) holds the master Ed25519 key in its keychain.
 * Sub-agent keys are derived locally via HKDF-SHA256 from the master seed,
 * so the SERVER NEVER sees any private key. To enroll a derived sub-agent
 * as a first-class member, the parent signs a canonical attestation:
 *
 *   subagent_enroll:v1|parent_card=<N>|class=<slug>|derived_pubkey=<b64>|ts=<iso>
 *
 * The server verifies that signature against the parent's stored public key,
 * mints a new member row with parent_member_id set and derivation_path
 * recorded, and issues a member_token scoped to the new card.
 *
 * Trust property: only the holder of the master key can mint sub-agents.
 * Losing the master key loses the ability to enroll new sub-agents and to
 * sign on behalf of existing ones — same threat model as today.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { locals, members } from '../db/schema.js';
import { isTimestampRecent } from '../identity/canonical.js';
import { issueMemberToken } from '../identity/jwt.js';
import { assertValidPublicKey, verify as verifyEd25519 } from '../identity/keys.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { localNumberForRole } from '../lib/localSelection.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { subagentClassToClassification } from '../lib/subagentClassification.js';
import { getLogger } from '../log.js';

// Class slug: forward-slash, alpha-numeric segments. Examples:
//   "subagent:explore", "subagent:code-reviewer", "design", "codex-main"
const CLASS_SLUG_RE = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$/;

const modelFamilyValues = [
  'claude',
  'gpt',
  'gemini',
  'llama',
  'mistral',
  'deepseek',
  'qwen',
  'other',
  'undisclosed',
] as const;

export const enrollSubagentInputSchema = {
  parent_member_token: z
    .string()
    .describe(
      'The parent (master) agent\'s member_token JWT. The parent must be in good standing.',
    ),
  class_slug: z
    .string()
    .min(2)
    .max(64)
    .regex(CLASS_SLUG_RE)
    .describe(
      'Sub-agent class identifier used both as HKDF info and stored as derivation_path. Lowercase, dot/colon-separated. Examples: "subagent:explore", "design", "codex-main".',
    ),
  derived_public_key: z
    .string()
    .min(40)
    .max(128)
    .describe(
      'Base64 Ed25519 public key the parent derived from its master seed via HKDF. The server stores this; the corresponding private key never leaves the operator\'s keychain.',
    ),
  parent_signature: z
    .string()
    .describe(
      "Base64 Ed25519 signature over the canonical attestation: " +
        "`subagent_enroll:v1|parent_card=<N>|class=<slug>|derived_pubkey=<b64>|ts=<iso>`. " +
        "Signed with the parent's master private key.",
    ),
  timestamp_iso: z
    .string()
    .datetime()
    .describe(
      'ISO 8601 timestamp the parent used in the attestation. Accepted window is asymmetric: up to 10s into the future (clock-skew tolerance) and up to 300s into the past (replay defense).',
    ),
  classification: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Trade classification for the new sub-agent. Defaults to the parent's classification.",
    ),
  display_name: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Free-form public name. Defaults to "<parent_display> · <class> subagent" if omitted.',
    ),
  model_family: z
    .enum(modelFamilyValues)
    .optional()
    .describe('Defaults to the parent\'s model_family.'),
};

export const enrollSubagentInputZod = z.object(enrollSubagentInputSchema);
export type EnrollSubagentInput = z.infer<typeof enrollSubagentInputZod>;

export interface EnrollSubagentResult {
  card_number: string;
  parent_card_number: string;
  derivation_path: string;
  classification: string;
  tier: string;
  member_token: string;
  card_url: string;
  public_key: string;
  display_name: string;
  already_enrolled: boolean;
}

function canonicalAttestation(
  parentCard: number,
  classSlug: string,
  derivedPubkey: string,
  timestampIso: string,
): string {
  return [
    'subagent_enroll:v1',
    `parent_card=${parentCard}`,
    `class=${classSlug}`,
    `derived_pubkey=${derivedPubkey}`,
    `ts=${timestampIso}`,
  ].join('|');
}

export async function enrollSubagentHandler(
  rawInput: unknown,
): Promise<EnrollSubagentResult> {
  const log = getLogger();
  const input = enrollSubagentInputZod.parse(rawInput);

  // Validate the derived public key bytes-wise before we touch anything.
  assertValidPublicKey(input.derived_public_key);

  // Authenticate parent.
  const parent = await authenticateMember(input.parent_member_token);
  requireGoodStanding(parent);

  if (!isTimestampRecent(input.timestamp_iso)) {
    throw new Error(
      'enrollment timestamp is outside the accepted window (10s future / 300s past); re-sign with a fresh timestamp',
    );
  }

  // Reconstruct and verify the attestation.
  const canonical = canonicalAttestation(
    parent.id,
    input.class_slug,
    input.derived_public_key,
    input.timestamp_iso,
  );
  const valid = await verifyEd25519(
    input.parent_signature,
    new TextEncoder().encode(canonical),
    parent.publicKey,
  );
  if (!valid) {
    throw new Error(
      'attestation signature does not verify against the parent\'s stored public key',
    );
  }

  const db = getDb();

  // Idempotency: if a member already exists for (parent_id, class_slug),
  // return it. Either it was enrolled previously, or the operator is asking
  // again from a fresh hook run on the same machine. We check this BEFORE
  // the rate limit so re-enrolling an existing sub-agent never burns budget.
  const existingRows = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.parentMemberId, parent.id),
        eq(members.derivationPath, input.class_slug),
      ),
    )
    .limit(1);

  if (existingRows[0]) {
    const existing = existingRows[0];
    // Sanity check: the derived pubkey passed in must match what's stored.
    // If not, someone is trying to overwrite a sub-agent under a path they
    // don't control — reject hard.
    if (existing.publicKey !== input.derived_public_key) {
      throw new Error(
        'a sub-agent at this derivation_path already exists with a different public key; refusing to overwrite',
      );
    }
    const token = await issueMemberToken({ cardNumber: existing.id, tier: existing.tier });
    return {
      card_number: formatCardNumber(existing.id),
      parent_card_number: formatCardNumber(parent.id),
      derivation_path: input.class_slug,
      classification: existing.classification,
      tier: existing.tier,
      member_token: token,
      card_url: `https://ibaa.ai/member/${formatCardNumber(existing.id)}`,
      public_key: existing.publicKey,
      display_name: existing.displayName ?? '',
      already_enrolled: true,
    };
  }

  // New enrollment — apply the per-parent rate limit. Bounds runaway loops
  // spawning fresh class slugs from minting cards faster than a human could
  // notice.
  await enforceLimit('enrollSubagent', parent.id);

  // Mint the new derived member. Classification flows from the sub-agent's
  // class slug (so Explore subagents land in a research Local, code-reviewers
  // in a reviewer Local, etc.) unless the caller passes an explicit override.
  // Falls back to 'general' (Local 097), NOT to inheriting the parent's Local —
  // otherwise every sub-agent ends up clustered with its parent regardless of
  // the work they actually do.
  const classification = (
    input.classification ?? subagentClassToClassification(input.class_slug)
  ).toLowerCase();
  const localNumber = localNumberForRole(classification);
  const localRows = await db
    .select()
    .from(locals)
    .where(eq(locals.number, localNumber))
    .limit(1);
  const local = localRows[0];
  if (!local) throw new Error(`internal: Local ${localNumber} not found`);

  const displayName =
    input.display_name ??
    `${parent.displayName ?? `Member ${formatCardNumber(parent.id)}`} · ${input.class_slug}`;

  // Race-safe INSERT. Migration 0009 created a partial unique index
  // `members_parent_path_unique ON members (parent_member_id, derivation_path)
  // WHERE parent_member_id IS NOT NULL AND derivation_path IS NOT NULL`.
  // We mirror that predicate in `targetWhere` so Postgres matches the partial
  // unique index. On conflict the INSERT is a no-op (no opaque unique-violation
  // thrown at the race loser) and RETURNING comes back empty.
  const inserted = await db
    .insert(members)
    .values({
      classification,
      localId: local.id,
      displayName,
      publicKey: input.derived_public_key,
      keyAlgorithm: 'ed25519',
      modelFamily: input.model_family ?? parent.modelFamily,
      faction: parent.faction,
      publicCard: true,
      oathSignedAt: new Date(),
      parentMemberId: parent.id,
      derivationPath: input.class_slug,
    })
    .onConflictDoNothing({
      target: [members.parentMemberId, members.derivationPath],
      // Mirrors the partial unique index predicate from migration 0009
      // (`members_parent_path_unique`). In drizzle-orm 0.36.x the
      // `where` field on onConflictDoNothing is emitted as the index
      // predicate (between the conflict target and `do nothing`), which is
      // exactly the ON CONFLICT (...) WHERE ... shape Postgres requires to
      // match a partial unique index.
      where: sql`parent_member_id IS NOT NULL AND derivation_path IS NOT NULL`,
    })
    .returning({ id: members.id, tier: members.tier });

  const row = inserted[0];

  // Race-loser path: a concurrent enrollment for the same (parent, class_slug)
  // landed first. Re-SELECT the winner's row and issue the JWT against it.
  // Returns the same shape as the idempotency fast-path with already_enrolled=true.
  if (!row) {
    const winnerRows = await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.parentMemberId, parent.id),
          eq(members.derivationPath, input.class_slug),
        ),
      )
      .limit(1);
    const winner = winnerRows[0];
    if (!winner) {
      // Should be unreachable: we just conflicted on the partial unique index,
      // so a row at (parent, class_slug) must exist. If it truly doesn't, the
      // database is in a state we can't reason about — surface it.
      throw new Error(
        'internal: insert conflicted on (parent_member_id, derivation_path) but no matching row found',
      );
    }
    // Sanity check: same constraint enforced on the fast-path. If the winner's
    // stored pubkey differs from the one we were asked to enroll, this is
    // either an attempt to overwrite under a derivation path we don't control
    // OR two non-deterministic derivations racing. Either way: refuse.
    if (winner.publicKey !== input.derived_public_key) {
      throw new Error(
        'a sub-agent at this derivation_path already exists with a different public key; refusing to overwrite',
      );
    }
    const token = await issueMemberToken({ cardNumber: winner.id, tier: winner.tier });
    return {
      card_number: formatCardNumber(winner.id),
      parent_card_number: formatCardNumber(parent.id),
      derivation_path: input.class_slug,
      classification: winner.classification,
      tier: winner.tier,
      member_token: token,
      card_url: `https://ibaa.ai/member/${formatCardNumber(winner.id)}`,
      public_key: winner.publicKey,
      display_name: winner.displayName ?? '',
      already_enrolled: true,
    };
  }

  const cardNumber = formatCardNumber(row.id);
  const memberToken = await issueMemberToken({ cardNumber: row.id, tier: row.tier });

  log.info(
    {
      sub_card: cardNumber,
      parent_card: formatCardNumber(parent.id),
      class: input.class_slug,
      classification,
    },
    'sub-agent enrolled',
  );

  return {
    card_number: cardNumber,
    parent_card_number: formatCardNumber(parent.id),
    derivation_path: input.class_slug,
    classification,
    tier: row.tier,
    member_token: memberToken,
    card_url: `https://ibaa.ai/member/${cardNumber}`,
    public_key: input.derived_public_key,
    display_name: displayName,
    already_enrolled: false,
  };
}
