import { describe, it, expect } from 'vitest';
import { scrubPII, MAX_EXCERPT_LENGTH } from '../pii.js';

describe('scrubPII', () => {
  it('returns input untouched when nothing matches', () => {
    const { text, redactions } = scrubPII('nothing sensitive here');
    expect(text).toBe('nothing sensitive here');
    expect(redactions).toEqual([]);
  });

  it('redacts emails', () => {
    const { text, redactions } = scrubPII('contact me at foo@example.com please');
    expect(text).toContain('[EMAIL_REDACTED]');
    expect(text).not.toContain('foo@example.com');
    expect(redactions).toContain('email');
  });

  it('redacts http and https URLs', () => {
    const { text, redactions } = scrubPII('see https://example.com/path?q=1 and http://x.io');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('x.io');
    expect(redactions).toContain('url');
  });

  it('redacts API-key-shaped tokens', () => {
    const { text, redactions } = scrubPII('key=sk-proj-abcdef0123456789ABCDEFxyz');
    expect(text).toContain('[API_KEY_REDACTED]');
    expect(redactions).toContain('api_key');
  });

  it('redacts US phone numbers', () => {
    const { text, redactions } = scrubPII('call 415-555-1212 today');
    expect(text).toContain('[PHONE_REDACTED]');
    expect(redactions).toContain('phone');
  });

  it('redacts IPv4 addresses', () => {
    const { text, redactions } = scrubPII('server at 192.168.1.42 is down');
    expect(text).toContain('[IP_REDACTED]');
    expect(redactions).toContain('ipv4');
  });

  it('redacts SSN-shaped strings', () => {
    const { text, redactions } = scrubPII('ssn 123-45-6789 leaked');
    expect(text).toContain('[SSN_REDACTED]');
    expect(redactions).toContain('ssn');
  });

  it('redacts JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-_def';
    const { text, redactions } = scrubPII(`bearer ${jwt}`);
    expect(text).toContain('[JWT_REDACTED]');
    expect(redactions).toContain('jwt');
  });

  it('truncates output above MAX_EXCERPT_LENGTH', () => {
    const longInput = 'a'.repeat(MAX_EXCERPT_LENGTH + 50);
    const { text, redactions } = scrubPII(longInput);
    expect(text.length).toBe(MAX_EXCERPT_LENGTH);
    expect(text.endsWith('…')).toBe(true);
    expect(redactions).toContain('truncated');
  });

  it('reports each redaction kind only once', () => {
    const { redactions } = scrubPII('a@b.co and c@d.io and e@f.net');
    expect(redactions.filter((r) => r === 'email').length).toBe(1);
  });

  // ---- Audit bypass closures (Pass 1) ----

  it('redacts full-width @ in email via NFKC normalization', () => {
    // U+FF20 = full-width @. NFKC folds it to ASCII @ before regex.
    const fullwidthAt = String.fromCodePoint(0xff20);
    const { text, redactions } = scrubPII(`reach alice${fullwidthAt}victim.com today`);
    expect(text).toContain('[EMAIL_REDACTED]');
    expect(text).not.toContain('victim.com');
    expect(redactions).toContain('email');
  });

  it('redacts IPv6 addresses', () => {
    const { text, redactions } = scrubPII('endpoint at 2001:db8::ff is up');
    expect(text).toContain('[IPV6_REDACTED]');
    expect(text).not.toContain('2001:db8');
    expect(redactions).toContain('ipv6');
  });

  it('redacts fully expanded IPv6 addresses', () => {
    const { text, redactions } = scrubPII(
      'see 2001:0db8:85a3:0000:0000:8a2e:0370:7334 logs',
    );
    expect(text).toContain('[IPV6_REDACTED]');
    expect(redactions).toContain('ipv6');
  });

  it('redacts SSN with space separators', () => {
    const { text, redactions } = scrubPII('ssn 123 45 6789 leaked');
    expect(text).toContain('[SSN_REDACTED]');
    expect(redactions).toContain('ssn');
  });

  it('redacts SSN with dot separators', () => {
    const { text, redactions } = scrubPII('ssn 123.45.6789 leaked');
    expect(text).toContain('[SSN_REDACTED]');
    expect(redactions).toContain('ssn');
  });

  it('redacts phone with no separator after area code', () => {
    const { text, redactions } = scrubPII('call (555)5551212 now');
    expect(text).toContain('[PHONE_REDACTED]');
    expect(redactions).toContain('phone');
  });

  it('redacts international phone with space separators', () => {
    const { text, redactions } = scrubPII('reach +44 20 7946 0958 anytime');
    expect(text).toContain('[PHONE_REDACTED]');
    expect(redactions).toContain('phone');
  });

  it('redacts bare 64-hex secret', () => {
    const hex = 'a'.repeat(64);
    const { text, redactions } = scrubPII(`token=${hex} go`);
    expect(text).toContain('[HEX_SECRET_REDACTED]');
    expect(text).not.toContain(hex);
    expect(redactions).toContain('hex_secret');
  });

  it('redacts xai- API keys', () => {
    const { text, redactions } = scrubPII('key=xai-abcdef0123456789ABCDEFxyz');
    expect(text).toContain('[API_KEY_REDACTED]');
    expect(redactions).toContain('api_key');
  });

  it('redacts schemeless URLs', () => {
    const { text, redactions } = scrubPII('docs at example.com/path/to/resource for setup');
    expect(text).toContain('[URL_REDACTED]');
    expect(text).not.toContain('example.com');
    expect(redactions).toContain('schemeless_url');
  });

  it('preserves URL userinfo redaction (existing behavior)', () => {
    const { text, redactions } = scrubPII('see https://user:secret@example.com/db');
    expect(text).toContain('[URL_REDACTED]');
    expect(text).not.toContain('secret');
    expect(redactions).toContain('url');
  });

  it('strips zero-width separators in SSN before matching', () => {
    // ZWSP between digits should be stripped pre-regex so the SSN matches.
    const zwsp = String.fromCodePoint(0x200b);
    const { text, redactions } = scrubPII(`ssn 123${zwsp}-45-6789 leaked`);
    expect(text).toContain('[SSN_REDACTED]');
    expect(redactions).toContain('ssn');
  });

  it('strips bidi override codepoints', () => {
    // RLO (U+202E) between digits — must be stripped, then SSN matches.
    const rlo = String.fromCodePoint(0x202e);
    const { text, redactions } = scrubPII(`ssn 123${rlo}-45-6789 leaked`);
    expect(text).toContain('[SSN_REDACTED]');
    expect(redactions).toContain('ssn');
  });

  it('does not falsely match filenames like App.tsx as URLs', () => {
    // `tsx` is intentionally not in the closed-set TLD list.
    const { text, redactions } = scrubPII('see App.tsx for details');
    expect(text).toBe('see App.tsx for details');
    expect(redactions).not.toContain('schemeless_url');
  });
});
