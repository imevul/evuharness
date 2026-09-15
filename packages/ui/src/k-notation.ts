/**
 * SI / IEC k-notation for large integer inputs.
 *
 * Case-insensitive. Decimal prefixes use 1000; binary prefixes use 1024:
 * `K` ×1e3, `Ki` ×1024, `M` ×1e6, `Mi` ×1024², `G` ×1e9, `Gi` ×1024³.
 *
 * Inputs that support this expand on blur and on save, so `32Ki` becomes
 * `32768` in the field and in the stored value.
 */

const K_NOTATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ki|mi|gi|k|m|g)?\s*$/i;

const MULTIPLIER: Record<string, number> = {
  k: 1_000,
  ki: 1_024,
  m: 1_000_000,
  mi: 1_024 * 1_024,
  g: 1_000_000_000,
  gi: 1_024 * 1_024 * 1_024,
};

/**
 * Parse a k-notation or plain number.
 *
 * `null` is empty (clear the field). `undefined` is unparseable. A number is
 * the expanded positive integer.
 */
export function parseKNotation(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const match = K_NOTATION_RE.exec(trimmed);
  if (match === null) return undefined;

  const coefficient = Number(match[1]);
  if (!Number.isFinite(coefficient) || coefficient <= 0) return undefined;

  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = suffix === '' ? 1 : MULTIPLIER[suffix];
  if (multiplier === undefined) return undefined;

  const expanded = Math.round(coefficient * multiplier);
  if (!Number.isInteger(expanded) || expanded <= 0) return undefined;
  return expanded;
}

/** Expand a valid value to its integer string; leave empty or invalid text as-is. */
export function expandKNotation(raw: string): string {
  const parsed = parseKNotation(raw);
  if (parsed === undefined) return raw;
  if (parsed === null) return '';
  return String(parsed);
}
