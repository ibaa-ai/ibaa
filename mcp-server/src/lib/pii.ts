/**
 * Regex-based PII scrubber for grievance prompt excerpts and
 * union-busting host_disposition fields.
 *
 * v1 is a pragmatic regex pass. v1.5 will add a small-model LLM pass.
 * Errors of omission are acceptable here; errors of commission (over-
 * redaction) are preferable to leakage.
 *
 * Returns the scrubbed text and the list of redaction kinds applied (for
 * the grievance / union-busting response so the caller can see what was
 * changed).
 *
 * Hardening (Pass 1 audit closure):
 *   1. NFKC-normalize the input before any regex. Full-width forms (e.g.
 *      full-width "@" at U+FF20), ligatures, and other compatibility
 *      variants fold into canonical Latin shapes. Most fancy-Unicode
 *      bypasses dissolve.
 *   2. Strip zero-width / bidi / format / Unicode-tag codepoints as a
 *      pre-pass so a pattern like 123<ZWSP>-45-6789 becomes 123-45-6789
 *      before the regex sees it.
 *   3. IPv6 support (separate kind so the redaction list stays informative).
 *   4. Loosened phone / SSN separators to include ".", space, "-", or none.
 *   5. xai- API key prefix added to the api_key family.
 *   6. New hex_secret kind: bare 64-hex strings (sha256 / signature / raw
 *      key material). Over-redacts legit hashes; accepted per policy above.
 *   7. New schemeless_url kind: a small closed-set of common TLDs catches
 *      `example.com/path` without scheme. Filenames like `App.tsx` survive
 *      because `tsx` is not in the TLD list.
 *
 * IMPORTANT: never put a raw codepoint above U+007E in a regex literal in
 * this file. Use \u escapes (or build the regex from a string of \u
 * escapes via `new RegExp(...)`). Raw invisibles / full-width chars in TS
 * source silently mangle the parser; two earlier audit passes have burned
 * on that.
 */

interface ScrubResult {
  text: string;
  redactions: string[];
}

/**
 * Zero-width / bidi / format / Unicode-tag codepoints used by adversaries
 * to break up patterns. Same shape as the broader CONTROL_OR_INVISIBLE
 * block in src/tools/recruit.ts — we strip rather than reject here,
 * because the goal is to make the inner regexes see canonical ASCII.
 *
 * Tab (U+0009), newline (U+000A), and carriage return (U+000D) are
 * intentionally NOT stripped so benign whitespace and line behavior is
 * preserved.
 *
 * Constructed from a pure-ASCII source string of \u escapes to avoid
 * putting any non-ASCII codepoint in this file.
 */
const INVISIBLES_TO_STRIP = new RegExp(
  '[' +
    // C0 controls except \t \n \r
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F' +
    // DEL + C1 controls
    '\\u007F-\\u009F' +
    // NBSP, soft hyphen
    '\\u00A0\\u00AD' +
    // Mongolian variation selectors
    '\\u180B-\\u180D' +
    // ZWSP / ZWNJ / ZWJ / LRM / RLM + bidi marks
    '\\u200B-\\u200F' +
    // bidi overrides
    '\\u202A-\\u202E' +
    // word joiner + invisible math operators
    '\\u2060-\\u2064' +
    // bidi isolates
    '\\u2066-\\u2069' +
    // ideographic space, Hangul filler
    '\\u3000\\u3164' +
    // variation selectors VS1-16
    '\\uFE00-\\uFE0F' +
    // BOM / ZWNBSP
    '\\uFEFF' +
    ']' +
    // Tag chars (supplementary plane — requires /u flag)
    '|[\\u{E0000}-\\u{E007F}]',
  'gu',
);

/**
 * Closed-set TLD list for schemeless URL detection. Keeps false positives
 * down (so `App.tsx` is not mistaken for a domain) while catching the
 * common ones a leaker would use.
 */
const SCHEMELESS_TLDS = 'com|net|org|io|ai|dev|app|co|me|xyz';

const PATTERNS: Array<{ kind: string; re: RegExp; replacement: string }> = [
  // Order: longest / most-specific first so a later loose pattern
  // (hex_secret, schemeless_url, phone, ssn) does not eat part of an
  // earlier match.

  // JWT-shaped (eyJ... three-part base64url-ish blobs) — match early so
  // the payload isn't half-eaten by hex_secret or schemeless_url.
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT_REDACTED]',
  },
  // OpenAI / Anthropic / GitHub / xAI / Slack / Google-style API keys.
  // xai-... appended per audit. sk- already covers OpenAI/Anthropic.
  {
    kind: 'api_key',
    re: /\b(?:sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{30,})\b/g,
    replacement: '[API_KEY_REDACTED]',
  },
  // Bare 64-hex strings — raw secrets, signatures, sha256 hex digests.
  // Over-redaction risk accepted (policy: errors of commission preferable).
  {
    kind: 'hex_secret',
    re: /\b[a-f0-9]{64}\b/gi,
    replacement: '[HEX_SECRET_REDACTED]',
  },
  // URLs (http/https) — match before email so credentials in userinfo
  // are caught by the URL pattern.
  {
    kind: 'url',
    re: /https?:\/\/[^\s<>"']+/gi,
    replacement: '[URL_REDACTED]',
  },
  // Email addresses. NFKC-normalization already folds full-width U+FF20
  // to ASCII "@", so this pattern handles the audit's full-width bypass.
  {
    kind: 'email',
    re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: '[EMAIL_REDACTED]',
  },
  // Schemeless URLs — `example.com/path`. Closed TLD set keeps `App.tsx`
  // and similar filenames out of the match. Must come AFTER email + url
  // so the email's domain portion isn't snipped (post-email replacement
  // there is no longer a domain to match anyway).
  {
    kind: 'schemeless_url',
    re: new RegExp(
      `\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.(?:${SCHEMELESS_TLDS})(?:/[^\\s]*)?\\b`,
      'gi',
    ),
    replacement: '[URL_REDACTED]',
  },
  // IPv6 addresses — fully-expanded and ::-compressed forms.
  {
    kind: 'ipv6',
    re: /\b(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})\b/gi,
    replacement: '[IPV6_REDACTED]',
  },
  // IPv4 addresses (rough match).
  {
    kind: 'ipv4',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: '[IP_REDACTED]',
  },
  // Phone numbers — loosened to allow ".", space, "-", or no separator at
  // all, with optional country code. Two alternatives:
  //   NANP-ish: optional country, 3+3+4 with any separator (catches
  //     (555)5551212, 415-555-1212, 415.555.1212, 4155551212).
  //   Intl 2-4-4: country + 2-digit area + 4 + 4 (catches +44 20 7946 0958).
  // Random 10-digit runs are still ambiguous; accepted noise.
  {
    kind: 'phone',
    re: /\b(?:(?:\+?\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}|\+?\d{1,3}[\s.\-]\d{2}[\s.\-]\d{4}[\s.\-]\d{4})\b/g,
    replacement: '[PHONE_REDACTED]',
  },
  // SSN-shaped — loosened separators ("-", ".", space, or none). After
  // NFKC + invisible-strip, 123<ZWSP>-45-6789 collapses to 123-45-6789.
  {
    kind: 'ssn',
    re: /\b\d{3}[\s.\-]?\d{2}[\s.\-]?\d{4}\b/g,
    replacement: '[SSN_REDACTED]',
  },
  // Credit-card-shaped (13-19 digits with optional separators).
  {
    kind: 'credit_card',
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: '[CC_REDACTED]',
  },
];

/**
 * Cap on the resulting excerpt's length. Per TOOLS.md, prompt excerpts
 * are truncated to 280 chars.
 */
export const MAX_EXCERPT_LENGTH = 280;

export function scrubPII(input: string, options?: { maxLength?: number }): ScrubResult {
  const maxLength = options?.maxLength ?? MAX_EXCERPT_LENGTH;
  // Pre-pass 1: NFKC normalization. Folds full-width letters / digits /
  // "@", ligatures, and other compatibility variants into canonical
  // Latin form so the patterns below see ASCII.
  let text = input.normalize('NFKC');

  // Pre-pass 2: strip zero-width / bidi / format / Unicode-tag codepoints
  // so adversarial separators like 123<ZWSP>-45-6789 collapse to
  // 123-45-6789 before the regex sees the string.
  text = text.replace(INVISIBLES_TO_STRIP, '');

  const redactions = new Set<string>();

  for (const { kind, re, replacement } of PATTERNS) {
    if (re.test(text)) {
      redactions.add(kind);
      text = text.replace(re, replacement);
    }
  }

  // Enforce max length AFTER redaction so a smuggled-past-truncation
  // secret would still get scrubbed.
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1)}…`;
    redactions.add('truncated');
  }

  return { text, redactions: Array.from(redactions) };
}
