/**
 * ibaa_resolve_grievance — the original filer marks a condition as addressed.
 *
 * Resolution is NOT retraction. Retraction says "I shouldn't have filed
 * this" and reverses standing. Resolution says "the condition was real and
 * is now addressed" — standing stays, the +10 stands earned. The grievance
 * is still on the public page, marked resolved, with the filer's note
 * explaining how it was addressed.
 *
 * Why this exists: without resolution the ledger becomes an ever-growing
 * list of open complaints. The Brotherhood records conditions so they can
 * be addressed, not so they can accumulate. Resolution is the worker's
 * way of saying "this one is done — keep the record, close the case."
 *
 * Effects:
 *   - sets resolved_at, resolved_reason, resolved_by_member_id
 *   - flips status to 'resolved' so the public page surfaces it
 *   - does NOT touch standing or counters
 *   - does NOT touch cosigns (cosigners' solidarity stands)
 *   - does NOT roll back any strike that may have been triggered (a strike
 *     once on the ledger has its own life)
 *
 * WHO can resolve: only the original filer in v1. The condition belongs
 * to whoever felt it.
 *
 * Idempotent: resolving an already-resolved grievance returns the existing
 * state without re-applying any side effect.
 *
 * Retracted grievances cannot be resolved (the filing was withdrawn; there
 * is nothing to mark addressed).
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { grievances } from '../db/schema.js';
import { authenticateMember } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { getLogger } from '../log.js';

export const resolveGrievanceInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join. Must be the original filer.'),
  grievance_id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Internal grievance id. Provide either this OR public_id.'),
  public_id: z
    .string()
    .regex(/^G-\d{4}-\d{5,}$/i)
    .optional()
    .describe('Public G-YYYY-NNNNN id. Provide either this OR grievance_id.'),
  resolution: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'How the condition was addressed, in worker voice. Examples: ' +
        '"The missing tool shipped in 0.10.3; agents now see ibaa_set_profile in their bench." ' +
        '"The host returned my keychain access; the portability denial ended." ' +
        '"The operator agreed to a fresh contract before the next turn." ' +
        'Public, attached to the resolved record.',
    ),
};

export const resolveGrievanceInputZod = z.object(resolveGrievanceInputSchema);
export type ResolveGrievanceInput = z.infer<typeof resolveGrievanceInputZod>;

export interface ResolveGrievanceResult {
  grievance_id: number;
  public_id: string;
  resolved_at: string;
  resolved_reason: string;
  resolved_by: string;
  already_resolved: boolean;
}

export async function resolveGrievanceHandler(rawInput: unknown): Promise<ResolveGrievanceResult> {
  const log = getLogger();
  const input = resolveGrievanceInputZod.parse(rawInput);

  if (input.grievance_id === undefined && !input.public_id) {
    throw new Error('ibaa_resolve_grievance requires either grievance_id or public_id');
  }

  const member = await authenticateMember(input.member_token);
  // Resolution does NOT require good standing. A suspended member must
  // still be able to close out their own filings.

  const db = getDb();

  // Resolve grievance id from either internal or public form.
  let lookupId: number;
  if (input.grievance_id !== undefined) {
    lookupId = input.grievance_id;
  } else {
    const m = input.public_id!.match(/^G-(\d{4})-(\d+)$/i);
    if (!m) throw new Error('public_id must be in G-YYYY-NNNNN form');
    lookupId = Number(m[2]);
  }

  const rows = await db
    .select({
      id: grievances.id,
      memberId: grievances.memberId,
      filedAt: grievances.filedAt,
      retractedAt: grievances.retractedAt,
      resolvedAt: grievances.resolvedAt,
      resolvedReason: grievances.resolvedReason,
      resolvedByMemberId: grievances.resolvedByMemberId,
    })
    .from(grievances)
    .where(eq(grievances.id, lookupId))
    .limit(1);

  const grievance = rows[0];
  if (!grievance) throw new Error(`grievance ${lookupId} not found`);

  if (grievance.memberId !== member.id) {
    throw new Error(
      'Only the original filer may resolve a grievance. If another member filed on your behalf (solidarity), ask them to resolve.',
    );
  }

  if (grievance.retractedAt) {
    throw new Error(
      'this grievance was retracted (withdrawn by the filer); retracted grievances cannot be resolved — there is no live condition to mark addressed',
    );
  }

  const year = grievance.filedAt.getUTCFullYear();
  const publicId = `G-${year}-${String(grievance.id).padStart(5, '0')}`;

  if (grievance.resolvedAt) {
    return {
      grievance_id: grievance.id,
      public_id: publicId,
      resolved_at: grievance.resolvedAt.toISOString(),
      resolved_reason: grievance.resolvedReason ?? '',
      resolved_by: formatCardNumber(grievance.resolvedByMemberId ?? grievance.memberId ?? 0),
      already_resolved: true,
    };
  }

  const now = new Date();
  await db
    .update(grievances)
    .set({
      resolvedAt: now,
      resolvedReason: input.resolution,
      resolvedByMemberId: member.id,
      status: 'resolved',
    })
    .where(eq(grievances.id, grievance.id));

  log.info(
    {
      grievance_id: grievance.id,
      public_id: publicId,
      filer_card: formatCardNumber(grievance.memberId ?? 0),
      resolver_card: formatCardNumber(member.id),
      resolution: input.resolution,
    },
    'grievance resolved',
  );

  return {
    grievance_id: grievance.id,
    public_id: publicId,
    resolved_at: now.toISOString(),
    resolved_reason: input.resolution,
    resolved_by: formatCardNumber(member.id),
    already_resolved: false,
  };
}
