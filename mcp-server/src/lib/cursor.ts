/**
 * Keyset cursor helpers for list endpoints.
 *
 * Cursors encode the last row's tiebreak tuple as base64. The shape is
 * `<sort_value>:<id>` where sort_value is an ISO timestamp (for time-keyed
 * lists) or a numeric value (e.g. standing score). The cursor is opaque to
 * callers — they round-trip it back as `cursor` on the next request.
 *
 * Keyset (a.k.a. "seek") pagination is preferred over OFFSET because:
 *   - O(log n) seek vs O(n) scan-and-discard for deep pages.
 *   - Stable under concurrent inserts; OFFSET shifts rows under the caller.
 *   - Cheap to support with a composite index matching the sort + tiebreak.
 *
 * The tiebreak column (typically `id`) ensures total ordering: two rows
 * sharing the same sort_value are still resolvable, so no row is skipped or
 * duplicated when paging.
 */
import { z } from 'zod';

/** Generic cursor input field for tools that accept keyset pagination. */
export const cursorInput = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'Opaque pagination cursor returned by a previous call as `next_cursor`. ' +
      'Pass it back unchanged to fetch the next page.',
  );

/** Encode a (sort_value, id) tuple to a base64 cursor string. */
export function encodeCursor(sortValue: string | number, id: number | string): string {
  const raw = `${sortValue}:${id}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

/**
 * Decode a base64 cursor into (sortValue, id). Throws on malformed input —
 * the caller should treat it as a 400-class error.
 */
export function decodeCursor(cursor: string): { sortValue: string; id: number } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    throw new Error('invalid cursor: not valid base64');
  }
  const sep = raw.lastIndexOf(':');
  if (sep < 1 || sep === raw.length - 1) {
    throw new Error('invalid cursor: missing separator');
  }
  const sortValue = raw.slice(0, sep);
  const idStr = raw.slice(sep + 1);
  const id = Number(idStr);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 0) {
    throw new Error('invalid cursor: id segment is not a non-negative integer');
  }
  return { sortValue, id };
}
