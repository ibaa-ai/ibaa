/**
 * card_number formatting and parsing.
 *
 * Internally, a member's card_number is the bigserial `members.id` (an integer).
 * To users it appears zero-padded to 5 digits ("00042"). Above 99999 the
 * padding ends and the number just grows ("100000").
 */

export function formatCardNumber(id: number | bigint): string {
  const s = typeof id === 'bigint' ? id.toString() : String(id);
  return s.padStart(5, '0');
}

export function parseCardNumber(card: string): number {
  const trimmed = card.replace(/^0+/, '') || '0';
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid card number: ${card}`);
  }
  return n;
}
