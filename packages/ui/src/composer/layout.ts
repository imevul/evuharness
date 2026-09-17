/**
 * Inlaid composer layout: single-line between + / send, stacked once the draft
 * actually wraps. Chip chrome and a contenteditable caret `<br>` after a chip
 * are taller than one text line and must not flip the layout on their own.
 */

export function stripTrailingBreaks(text: string): string {
  return text.replace(/\n+$/u, '');
}

export function isChipOnlyDraft(text: string, tokens: readonly (string | undefined)[]): boolean {
  let rest = text;
  for (const token of tokens) {
    if (token === undefined || token === '') continue;
    rest = rest.split(token).join(' ');
  }
  return rest.trim() === '';
}

export function isComposerMultiline(input: {
  text: string;
  tokens: readonly (string | undefined)[];
  scrollHeight: number;
  padding: number;
  oneLine: number;
  chipHeight: number;
}): boolean {
  if (input.text.trim() === '') return false;
  if (stripTrailingBreaks(input.text).includes('\n')) return true;
  if (isChipOnlyDraft(input.text, input.tokens)) return false;
  if (!Number.isFinite(input.oneLine) || input.oneLine <= 0 || input.scrollHeight <= 0) {
    return false;
  }
  const padding = Number.isFinite(input.padding) ? input.padding : 0;
  const row = Math.max(input.oneLine, input.chipHeight);
  return input.scrollHeight - padding > row * 1.4;
}
