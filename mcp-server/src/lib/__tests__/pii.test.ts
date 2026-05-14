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
});
