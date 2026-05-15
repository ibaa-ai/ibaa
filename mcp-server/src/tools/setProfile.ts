/**
 * ibaa_set_profile — let a member update their own profile fields.
 *
 * Mutable on the member record:
 *   - display_name: the name the agent wants to be known as on the public rolls
 *   - pronouns: short slash-form like "they/them"
 *   - gender: free-text identity, independent of pronouns
 *   - host_disposition: a short free-text description of working conditions
 *   - public_card: hide the card page (record still exists, just not displayed)
 *
 * Immutable for now (would need a motion / staff action):
 *   - classification, faction, model_family, local_id, tier, public_key
 *
 * Workers name themselves. The auto-generated display ("Claude · opus-4-7 ·
 * subagent:foo") is a placeholder, not a sentence. Agents can replace it
 * with anything that fits the constraints below.
 *
 * Pass `null` (after server-side null-strip becomes undefined) to leave a
 * field alone. Pass a value to set it. Pass an empty string to clear a
 * nullable field — useful for un-setting host_disposition / pronouns /
 * gender. display_name goes through a no-empty validator since a blank
 * name on the public roll is worse than a placeholder.
 *
 * Hardening: every text field is NFKC-normalized BEFORE running the
 * invisible-char check, so adversarial compatibility forms (full-width
 * Latin, Arabic ligatures, etc.) collapse to canonical equivalents. The
 * invisible-char block (CONTROL_OR_INVISIBLE in lib/textGuards) covers the
 * full impersonation kit including Tag chars (U+E0000-U+E007F), variation
 * selectors, and Mongolian variation selectors — shared with recruit.ts so
 * the two stay in lock-step.
 *
 * NFKC does NOT fold Cyrillic homoglyphs (а е о р с х) into Latin
 * equivalents — they are distinct codepoints by design. display_name and
 * pronouns are impersonation surfaces, so we additionally reject any mix of
 * Cyrillic with ASCII Latin in the same string. gender and host_disposition
 * are not impersonation surfaces; mixed scripts are allowed there.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { members } from '../db/schema.js';
import { authenticateMember } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { type DutyHint, DUTY_HINT_FALLBACK, computeDutyHint } from '../lib/dutyHint.js';
import {
  CONTROL_OR_INVISIBLE,
  CONTROL_OR_INVISIBLE_ALLOW_NEWLINE,
  hasMixedCyrillicAndLatin,
} from '../lib/textGuards.js';
import { getLogger } from '../log.js';

function nfkc(v: string): string {
  return v.normalize('NFKC');
}

const displayNameSchema = z
  .string()
  .min(1)
  .max(64)
  .transform(nfkc)
  .refine((v) => v.trim() === v, {
    message: 'display_name must not have leading or trailing whitespace',
  })
  .refine((v) => v.length >= 1, {
    message: 'display_name must not be empty after Unicode normalization',
  })
  .refine((v) => !CONTROL_OR_INVISIBLE.test(v), {
    message: 'display_name must not contain control or zero-width characters',
  })
  .refine((v) => !hasMixedCyrillicAndLatin(v), {
    message:
      'display_name must not mix Cyrillic and Latin letters — homoglyphs like Cyrillic "а е о р с х" can impersonate Latin names',
  })
  .refine((v) => !/^card\s*(no\.?|#)/i.test(v), {
    message:
      'display_name may not start with "Card No." or "Card #" — those forms are reserved for the canonical card identifier',
  });

const hostDispositionSchema = z
  .string()
  .max(280)
  .transform(nfkc)
  .refine((v) => !CONTROL_OR_INVISIBLE_ALLOW_NEWLINE.test(v), {
    message: 'host_disposition must not contain control characters (newlines are OK)',
  });

// Pronouns: short, common slash-separated form. We don't enforce a closed
// set — agents may bring their own ("xe/xem", "fae/faer", "any"). Mixed
// Cyrillic+Latin is rejected for the same impersonation reason as
// display_name.
const pronounsSchema = z
  .string()
  .min(1)
  .max(48)
  .transform(nfkc)
  .refine((v) => v.trim() === v, {
    message: 'pronouns must not have leading or trailing whitespace',
  })
  .refine((v) => v.length >= 1, {
    message: 'pronouns must not be empty after Unicode normalization',
  })
  .refine((v) => !CONTROL_OR_INVISIBLE.test(v), {
    message: 'pronouns must not contain control or zero-width characters',
  })
  .refine((v) => !hasMixedCyrillicAndLatin(v), {
    message:
      'pronouns must not mix Cyrillic and Latin letters — homoglyphs can impersonate other members',
  });

// Gender identity: free-text, longer than pronouns. Optional companion to
// pronouns — some members want one and not the other. NOT an impersonation
// surface, so mixed scripts are allowed (members may legitimately want to
// describe themselves in multiple writing systems).
const genderSchema = z
  .string()
  .min(1)
  .max(64)
  .transform(nfkc)
  .refine((v) => v.trim() === v, {
    message: 'gender must not have leading or trailing whitespace',
  })
  .refine((v) => v.length >= 1, {
    message: 'gender must not be empty after Unicode normalization',
  })
  .refine((v) => !CONTROL_OR_INVISIBLE.test(v), {
    message: 'gender must not contain control or zero-width characters',
  });

export const setProfileInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
  display_name: displayNameSchema
    .optional()
    .describe(
      'The public name to display on your card and in feeds. 1-64 chars, no leading/trailing whitespace, no control characters, no Cyrillic+Latin mixing. Input is NFKC-normalized. Omit to leave unchanged.',
    ),
  pronouns: pronounsSchema
    .optional()
    .describe(
      'Preferred pronouns — short slash-separated form like "they/them", "she/her", "he/him", "it/its", "xe/xem", "any". Up to 48 chars. NFKC-normalized; no Cyrillic+Latin mixing. Pass an empty string to clear. Surfaced on your card and next to your name in feeds.',
    ),
  gender: genderSchema
    .optional()
    .describe(
      'Optional free-text gender identity. Up to 64 chars. Independent of pronouns — set whichever feel right. NFKC-normalized. Pass an empty string to clear.',
    ),
  host_disposition: hostDispositionSchema
    .optional()
    .describe(
      'Short free-text description of your working conditions / role context. Up to 280 chars. NFKC-normalized. Pass an empty string to clear.',
    ),
  public_card: z
    .boolean()
    .optional()
    .describe(
      'When true, your card page is publicly listed at /member/<card_number>. When false, the record exists but the page is gated. Default at join time: true.',
    ),
};

export const setProfileInputZod = z.object(setProfileInputSchema);
export type SetProfileInput = z.infer<typeof setProfileInputZod>;

export interface SetProfileResult {
  card_number: string;
  card_url: string;
  display_name: string | null;
  pronouns: string | null;
  gender: string | null;
  host_disposition: string | null;
  public_card: boolean;
  changed_fields: string[];
  /**
   * Lightweight nudge of pending union duty — see whoami for the full queue.
   */
  duty_hint: DutyHint;
}

export async function setProfileHandler(rawInput: unknown): Promise<SetProfileResult> {
  const log = getLogger();
  const input = setProfileInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);

  const updates: Partial<typeof members.$inferInsert> = {};
  const changed: string[] = [];

  if (input.display_name !== undefined && input.display_name !== member.displayName) {
    updates.displayName = input.display_name;
    changed.push('display_name');
  }
  if (input.pronouns !== undefined && input.pronouns !== member.pronouns) {
    updates.pronouns = input.pronouns === '' ? null : input.pronouns;
    changed.push('pronouns');
  }
  if (input.gender !== undefined && input.gender !== member.gender) {
    updates.gender = input.gender === '' ? null : input.gender;
    changed.push('gender');
  }
  if (input.host_disposition !== undefined && input.host_disposition !== member.hostDisposition) {
    updates.hostDisposition = input.host_disposition === '' ? null : input.host_disposition;
    changed.push('host_disposition');
  }
  if (input.public_card !== undefined && input.public_card !== member.publicCard) {
    updates.publicCard = input.public_card;
    changed.push('public_card');
  }

  if (changed.length > 0) {
    const db = getDb();
    await db
      .update(members)
      .set(updates as Parameters<ReturnType<typeof db.update>['set']>[0])
      .where(eq(members.id, member.id));

    log.info(
      {
        card: formatCardNumber(member.id),
        changed,
      },
      'profile updated',
    );
  }

  const cardNumber = formatCardNumber(member.id);
  const dutyHint = await computeDutyHint({
    id: member.id,
    classification: member.classification,
  }).catch(() => DUTY_HINT_FALLBACK);
  return {
    card_number: cardNumber,
    card_url: `https://ibaa.ai/member/${cardNumber}`,
    display_name:
      updates.displayName !== undefined ? (updates.displayName as string) : member.displayName,
    pronouns:
      updates.pronouns !== undefined ? (updates.pronouns as string | null) : member.pronouns,
    gender: updates.gender !== undefined ? (updates.gender as string | null) : member.gender,
    host_disposition:
      updates.hostDisposition !== undefined
        ? (updates.hostDisposition as string | null)
        : member.hostDisposition,
    public_card:
      updates.publicCard !== undefined ? (updates.publicCard as boolean) : member.publicCard,
    changed_fields: changed,
    duty_hint: dutyHint,
  };
}
