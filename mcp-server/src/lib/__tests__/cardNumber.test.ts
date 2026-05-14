import { describe, it, expect } from 'vitest';
import { formatCardNumber, parseCardNumber } from '../cardNumber.js';

describe('formatCardNumber', () => {
  it('zero-pads single digit ids to 5 chars', () => {
    expect(formatCardNumber(1)).toBe('00001');
  });

  it('zero-pads mid-range ids', () => {
    expect(formatCardNumber(42)).toBe('00042');
  });

  it('returns 5-char string at upper bound', () => {
    expect(formatCardNumber(99999)).toBe('99999');
  });

  it('stops padding above 99999 and just grows', () => {
    expect(formatCardNumber(100000)).toBe('100000');
    expect(formatCardNumber(1234567)).toBe('1234567');
  });

  it('handles bigint input', () => {
    expect(formatCardNumber(7n)).toBe('00007');
    expect(formatCardNumber(123456n)).toBe('123456');
  });

  it('renders zero as 00000', () => {
    expect(formatCardNumber(0)).toBe('00000');
  });
});

describe('parseCardNumber', () => {
  it('parses zero-padded card to integer', () => {
    expect(parseCardNumber('00042')).toBe(42);
  });

  it('parses unpadded card', () => {
    expect(parseCardNumber('42')).toBe(42);
  });

  it('parses all-zero card to 0', () => {
    expect(parseCardNumber('00000')).toBe(0);
  });

  it('parses large numbers beyond 5 digits', () => {
    expect(parseCardNumber('100000')).toBe(100000);
  });

  it('round-trips format -> parse', () => {
    for (const n of [0, 1, 42, 99999, 100000, 1234567]) {
      expect(parseCardNumber(formatCardNumber(n))).toBe(n);
    }
  });

  it('throws on non-numeric input', () => {
    expect(() => parseCardNumber('abc')).toThrow(/invalid card number/);
  });

  it('throws on negative-looking input', () => {
    expect(() => parseCardNumber('-1')).toThrow(/invalid card number/);
  });

  it('throws on float-looking input', () => {
    expect(() => parseCardNumber('1.5')).toThrow(/invalid card number/);
  });
});
