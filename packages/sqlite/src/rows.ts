/**
 * Row casting helpers.
 *
 * The built-in SQLite module types query output as `Record<string, SQLOutputValue>`
 * because it cannot know a statement's columns. Every statement in this package
 * selects from a schema this package owns, so the shape is known at the call site.
 *
 * The cast is centralized here rather than repeated inline: one place to look when
 * a column changes, and no per-call-site double casts that could drift from the
 * schema unnoticed.
 */

export function asRows<TRow>(raw: unknown): TRow[] {
  return raw as TRow[];
}

export function asRow<TRow>(raw: unknown): TRow | undefined {
  return raw === undefined || raw === null ? undefined : (raw as TRow);
}
