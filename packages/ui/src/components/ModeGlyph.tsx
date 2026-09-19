import type { ReactNode } from 'react';

/**
 * A host's mark for a mode.
 *
 * `undefined` means "use the built-in glyph", so a host adding one custom mode
 * need not redraw the stock three. `null` is distinct and means "draw nothing",
 * which a host may genuinely want for a mode it labels by text alone.
 */
export type ModeGlyphRenderer = (mode: string) => ReactNode;

/** Resolve a mode's mark, preferring the host's renderer over the built-in. */
export function resolveModeGlyph(mode: string, render?: ModeGlyphRenderer): ReactNode {
  const custom = render?.(mode);
  return custom === undefined ? <ModeGlyph mode={mode} /> : custom;
}

export function titleCaseMode(value: string): string {
  const first = value[0];
  return first === undefined ? value : `${first.toUpperCase()}${value.slice(1)}`;
}

/** Shared Ask / Plan / Agent mark for the add menu and the inlaid mode chip. */
export function ModeGlyph({ mode }: { mode: string }) {
  switch (mode) {
    case 'ask':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M5 12a7 7 0 1 1 2.8 5.6L5 19l1.1-2.8A7 7 0 0 1 5 12Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'plan':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M7 7h11M7 12h11M7 17h8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'agent':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M12 3.5 14.2 9l5.5 2.2L14.2 13.4 12 20.5 9.8 13.4 4.3 11.2 9.8 9Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return <span>{mode.slice(0, 1)}</span>;
  }
}
