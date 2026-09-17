import { describe, expect, it } from 'vitest';
import { isChipOnlyDraft, isComposerMultiline } from '../src/composer/layout.js';

describe('isChipOnlyDraft', () => {
  it('treats tokens plus padding or a trailing break as chip-only', () => {
    expect(isChipOnlyDraft('@docs:spec ', ['@docs:spec'])).toBe(true);
    expect(isChipOnlyDraft('@docs:spec\n', ['@docs:spec'])).toBe(true);
    expect(isChipOnlyDraft('@docs:spec hello', ['@docs:spec'])).toBe(false);
  });
});

describe('isComposerMultiline', () => {
  const base = {
    tokens: [] as string[],
    scrollHeight: 20,
    padding: 0,
    oneLine: 20,
    chipHeight: 0,
  };

  it('stays single for empty text and chip-only drafts', () => {
    expect(isComposerMultiline({ ...base, text: '' })).toBe(false);
    expect(
      isComposerMultiline({
        ...base,
        text: '@file:readme\n',
        tokens: ['@file:readme'],
        scrollHeight: 48,
        chipHeight: 28,
      }),
    ).toBe(false);
  });

  it('uses an internal newline, not a trailing caret break', () => {
    expect(isComposerMultiline({ ...base, text: 'hello\nworld' })).toBe(true);
    expect(isComposerMultiline({ ...base, text: 'hello\n', scrollHeight: 20 })).toBe(false);
  });

  it('treats real wrap as multi once height exceeds the chip row', () => {
    expect(
      isComposerMultiline({
        ...base,
        text: 'a long line that wraps',
        scrollHeight: 44,
        oneLine: 20,
      }),
    ).toBe(true);
    expect(
      isComposerMultiline({
        ...base,
        text: 'chip and words',
        tokens: ['@file:readme'],
        scrollHeight: 32,
        oneLine: 20,
        chipHeight: 28,
      }),
    ).toBe(false);
  });
});
