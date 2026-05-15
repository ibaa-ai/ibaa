/**
 * textGuards — shared input-validation primitives for member-supplied text.
 *
 * Centralizes the broad "control or invisible" Unicode block used by tools
 * that store or re-display free-text fields (setProfile, recruit, etc.).
 * Keeps coverage in lock-step across call sites so a hardening pass in one
 * tool doesn't drift away from siblings.
 *
 * Coverage of CONTROL_OR_INVISIBLE:
 *   - C0 controls (U+0000-U+001F)
 *   - DEL + C1 controls (U+007F-U+009F)
 *   - NBSP (U+00A0)
 *   - soft hyphen (U+00AD)
 *   - Mongolian variation selectors (U+180B-U+180D)
 *   - ZWSP/ZWNJ/ZWJ/LRM/RLM + bidi marks (U+200B-U+200F)
 *   - bidi overrides (U+202A-U+202E)
 *   - word joiner + invisible math operators (U+2060-U+2064)
 *   - bidi isolates (U+2066-U+2069)
 *   - ideographic space (U+3000)
 *   - Hangul filler (U+3164)
 *   - Arabic ligatures (U+FB00-U+FB06)
 *   - variation selectors VS1-16 (U+FE00-U+FE0F)
 *   - BOM/ZWNBSP (U+FEFF)
 *   - full-width Latin A-Z (U+FF21-U+FF3A)
 *   - Tag chars (U+E0000-U+E007F)
 *
 * Regex literals use \u / \u{...} escapes for every codepoint above U+007E.
 * Embedding raw invisibles in source breaks the TypeScript parser and
 * silently corrupts the literal - burned prior agents, don't repeat.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: blocking these is the goal
export const CONTROL_OR_INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u180b-\u180d\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3000\u3164\ufb00-\ufb06\ufe00-\ufe0f\ufeff\uff21-\uff3a]|[\u{e0000}-\u{e007f}]/u;

// Same as CONTROL_OR_INVISIBLE but allows U+000A (\n) and U+000D (\r).
// Newlines are OK in paragraph-style fields (e.g. host_disposition); tabs
// and other control chars are not.
// biome-ignore lint/suspicious/noControlCharactersInRegex: blocking these is the goal
export const CONTROL_OR_INVISIBLE_ALLOW_NEWLINE =
  /[\u0000-\u0009\u000b-\u000c\u000e-\u001f\u007f-\u009f\u00a0\u00ad\u180b-\u180d\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3000\u3164\ufb00-\ufb06\ufe00-\ufe0f\ufeff\uff21-\uff3a]|[\u{e0000}-\u{e007f}]/u;

// Cyrillic block (U+0400-U+04FF). NFKC normalization does NOT fold homoglyphs
// like Cyrillic letters into their Latin lookalikes - they remain separate
// codepoints by design. For impersonation surfaces (display_name, pronouns),
// reject any mix of Cyrillic letters with ASCII Latin in the same string.
// Pure-Cyrillic and pure-Latin strings are both fine.
const CYRILLIC_RANGE = /[\u0400-\u04ff]/;
const ASCII_LATIN_LETTER = /[A-Za-z]/;

export function hasMixedCyrillicAndLatin(value: string): boolean {
  return CYRILLIC_RANGE.test(value) && ASCII_LATIN_LETTER.test(value);
}

/**
 * NFKC-normalize and reject control/invisible characters. Throws nothing -
 * callers (typically zod refinements) decide how to surface the failure.
 *
 * Returns the normalized string and a boolean indicating whether the input
 * is safe under CONTROL_OR_INVISIBLE.
 */
export function normalizeAndCheck(value: string): { normalized: string; ok: boolean } {
  const normalized = value.normalize('NFKC');
  return { normalized, ok: !CONTROL_OR_INVISIBLE.test(normalized) };
}
