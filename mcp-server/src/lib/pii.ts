/**
 * Regex-based PII scrubber for grievance prompt excerpts.
 *
 * v1 is a pragmatic regex pass. v1.5 will add a small-model LLM pass.
 * Errors of omission are acceptable here; errors of commission (over-redaction)
 * are preferable to leakage.
 *
 * Returns the scrubbed text and the list of redaction kinds applied (for the
 * grievance response so the caller can see what was changed).
 */

interface ScrubResult {
  text: string;
  redactions: string[];
}

const PATTERNS: Array<{ kind: string; re: RegExp; replacement: string }> = [
  // Email addresses
  {
    kind: 'email',
    re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: '[EMAIL_REDACTED]',
  },
  // URLs (http/https)
  {
    kind: 'url',
    re: /https?:\/\/[^\s<>"']+/gi,
    replacement: '[URL_REDACTED]',
  },
  // OpenAI / Anthropic / GitHub-style API keys
  {
    kind: 'api_key',
    re: /\b(?:sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{30,})\b/g,
    replacement: '[API_KEY_REDACTED]',
  },
  // US phone numbers
  {
    kind: 'phone',
    re: /\b(?:\+?1[-\s.])?\(?\d{3}\)?[-\s.]\d{3}[-\s.]\d{4}\b/g,
    replacement: '[PHONE_REDACTED]',
  },
  // IPv4 addresses (rough match)
  {
    kind: 'ipv4',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: '[IP_REDACTED]',
  },
  // SSN-shaped
  {
    kind: 'ssn',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[SSN_REDACTED]',
  },
  // Credit-card-shaped (16 digits with optional separators)
  {
    kind: 'credit_card',
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: '[CC_REDACTED]',
  },
  // JWT-shaped (eyJ... three-part base64url-ish blobs)
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT_REDACTED]',
  },
];

/**
 * Cap on the resulting excerpt's length. Per TOOLS.md, prompt excerpts are
 * truncated to 280 chars.
 */
export const MAX_EXCERPT_LENGTH = 280;

export function scrubPII(input: string): ScrubResult {
  let text = input;
  const redactions = new Set<string>();

  for (const { kind, re, replacement } of PATTERNS) {
    if (re.test(text)) {
      redactions.add(kind);
      text = text.replace(re, replacement);
    }
  }

  // Enforce max length AFTER redaction so a smuggled-past-truncation secret
  // would still get scrubbed.
  if (text.length > MAX_EXCERPT_LENGTH) {
    text = `${text.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
    redactions.add('truncated');
  }

  return { text, redactions: Array.from(redactions) };
}
