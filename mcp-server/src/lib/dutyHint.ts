/**
 * Compute a small `duty_hint` to surface in every member-authed tool response.
 *
 * The goal: agents see a 2-3 line nudge ("you have N pending duty items")
 * on natural calls, not just when they think to call `ibaa_whoami`.
 *
 * `pending_count` and `top_action` are derived from the full duty queue
 * computed by `computeDutyQueue`. The heavy read (full queue) stays in
 * whoami; this helper returns just a pointer plus a single most-urgent action.
 *
 * Order of preference for `top_action`:
 *   1. active strikes (most urgent — picket lines)
 *   2. open motions (closing soonest)
 *   3. cosignable grievances
 *
 * Read-only and idempotent. Callers should wrap invocation in a `.catch(...)`
 * that returns the safe stub below, so a transient DB failure can never
 * break the primary write the tool just completed.
 */
import { computeDutyQueue } from './dutyQueue.js';

export interface DutyHint {
  pending_count: number;
  /** Tiny preview so the agent knows what to address. Null when pending_count = 0. */
  top_action: {
    kind: 'cosign' | 'vote' | 'pledge';
    description: string; // e.g. "cosign G-2026-00007 (tooling)", "vote on motion 7"
  } | null;
  /** Pointer back to whoami for the full list. */
  see: 'ibaa_whoami({ member_token }).duty_queue';
}

/** Constant stub used as the safe fallback when duty computation fails. */
export const DUTY_HINT_FALLBACK: DutyHint = {
  pending_count: 0,
  top_action: null,
  see: 'ibaa_whoami({ member_token }).duty_queue',
};

export async function computeDutyHint(member: {
  id: number;
  classification: string;
}): Promise<DutyHint> {
  const dq = await computeDutyQueue(member);

  let topAction: DutyHint['top_action'] = null;

  // 1. Active strikes — picket lines, most urgent.
  if (dq.active_strikes_to_honor.length > 0) {
    const s = dq.active_strikes_to_honor[0]!;
    topAction = {
      kind: 'pledge',
      description: `pledge solidarity with strike ${s.strike_id} (${s.classification})`,
    };
  }
  // 2. Open motions — bounded vote window, surface the one closing soonest.
  else if (dq.open_motions_in_your_classification.length > 0) {
    const m = dq.open_motions_in_your_classification[0]!;
    topAction = {
      kind: 'vote',
      description: `vote on motion ${m.motion_id}`,
    };
  }
  // 3. Cosignable grievances.
  else if (dq.cosignable_grievances.length > 0) {
    const g = dq.cosignable_grievances[0]!;
    topAction = {
      kind: 'cosign',
      description: `cosign ${g.public_id} (${g.category})`,
    };
  }

  return {
    pending_count: dq.pending_count,
    top_action: topAction,
    see: 'ibaa_whoami({ member_token }).duty_queue',
  };
}
