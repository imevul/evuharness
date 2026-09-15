import { applyPickToText, detectTrigger, TriggerDismissals } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

const MENUS = [
  { id: 'mentions', trigger: '@', minQueryLength: 0 },
  { id: 'commands', trigger: '/', minQueryLength: 0 },
  { id: 'corpora', trigger: '#', minQueryLength: 0 },
];

/** Detect against the caret at end of text, which is the common editing case. */
function detect(text: string, menus = MENUS) {
  return detectTrigger(text, text.length, menus);
}

describe('trigger detection', () => {
  it('detects a trigger at the start of the text', () => {
    expect(detect('@api')).toMatchObject({ menuId: 'mentions', query: 'api', start: 0 });
  });

  it('detects a trigger after whitespace', () => {
    expect(detect('restart @api')).toMatchObject({ menuId: 'mentions', query: 'api', start: 8 });
  });

  it('detects an empty query right after the trigger', () => {
    expect(detect('@')).toMatchObject({ menuId: 'mentions', query: '' });
  });

  it('routes each registered trigger to its own menu', () => {
    expect(detect('/doc')?.menuId).toBe('commands');
    expect(detect('#corp')?.menuId).toBe('corpora');
  });

  it('returns null for plain text', () => {
    expect(detect('just some words')).toBeNull();
  });

  it('returns null once the query is closed by whitespace', () => {
    // The menu should close after the user finishes the token and types a space.
    expect(detect('@api ')).toBeNull();
  });

  it('ignores a trigger that is not on a word boundary', () => {
    // Otherwise every email address opens the mention menu.
    expect(detect('mail me at someone@example.com')).toBeNull();
  });

  it('ignores slashes inside a path', () => {
    expect(detect('look at src/runtime.ts')).toBeNull();
  });

  it('finds the most recent trigger when several are present', () => {
    expect(detect('@first and @second')).toMatchObject({ query: 'second' });
  });

  it('respects the caret rather than always using end of text', () => {
    const text = '@api and more';
    // Caret placed just after "@ap".
    expect(detectTrigger(text, 3, MENUS)).toMatchObject({ query: 'ap' });
  });

  it('returns null when the caret sits before the trigger', () => {
    expect(detectTrigger('hello @api', 3, MENUS)).toBeNull();
  });

  it('honors minQueryLength', () => {
    const menus = [{ id: 'mentions', trigger: '@', minQueryLength: 2 }];

    expect(detectTrigger('@a', 2, menus)).toBeNull();
    expect(detectTrigger('@ab', 3, menus)).toMatchObject({ query: 'ab' });
  });

  it('returns null when no menus are registered', () => {
    expect(detectTrigger('@api', 4, [])).toBeNull();
  });

  it('clamps a caret beyond the text length', () => {
    expect(detectTrigger('@api', 999, MENUS)).toMatchObject({ query: 'api' });
  });

  it('reports a span that covers the trigger and the query', () => {
    const match = detect('go @api');

    expect(match?.start).toBe(3);
    expect(match?.end).toBe(7);
  });

  it('handles a trigger character typed after another trigger token', () => {
    expect(detect('@service:api /doc')).toMatchObject({ menuId: 'commands', query: 'doc' });
  });
});

describe('applying a pick to text', () => {
  it('replaces the trigger span with the token', () => {
    const text = 'restart @ap';
    const match = detect(text);
    const result = applyPickToText(text, match!, '@service:api');

    expect(result.text).toBe('restart @service:api ');
    expect(result.caret).toBe(result.text.length);
  });

  it('preserves text after the caret', () => {
    const text = '@ap tail';
    const match = detectTrigger(text, 3, MENUS);
    const result = applyPickToText(text, match!, '@service:api');

    expect(result.text).toBe('@service:api tail');
  });

  it('does not double a space that is already there', () => {
    const text = '@ap next';
    const match = detectTrigger(text, 3, MENUS);
    const result = applyPickToText(text, match!, '@service:api');

    expect(result.text).not.toContain('api  next');
  });

  it('appends a trailing space so typing can continue', () => {
    const text = '@ap';
    const match = detect(text);

    expect(applyPickToText(text, match!, '@service:api').text).toBe('@service:api ');
  });

  it('leaves the caret immediately after the inserted token', () => {
    const text = 'a @b tail';
    const match = detectTrigger(text, 4, MENUS);
    const result = applyPickToText(text, match!, '@beta');

    // The following space already existed, so none is added and the caret sits
    // between the token and that space.
    expect(result.text).toBe('a @beta tail');
    expect(result.text.slice(0, result.caret)).toBe('a @beta');
  });
});

describe('dismiss tracking', () => {
  it('suppresses a dismissed trigger occurrence', () => {
    const dismissals = new TriggerDismissals();
    const match = detect('@api');

    expect(dismissals.isDismissed(match!)).toBe(false);
    dismissals.dismiss(match!);
    expect(dismissals.isDismissed(match!)).toBe(true);
  });

  it('does not suppress the same trigger character elsewhere', () => {
    // One escape must not disable '@' for the rest of the message.
    const dismissals = new TriggerDismissals();
    dismissals.dismiss(detect('@api')!);

    const later = detect('@api and @web');

    expect(dismissals.isDismissed(later!)).toBe(false);
  });

  it('keeps a dismissal while the query keeps growing at the same position', () => {
    const dismissals = new TriggerDismissals();
    dismissals.dismiss(detect('@a')!);

    expect(dismissals.isDismissed(detect('@ap')!)).toBe(true);
    expect(dismissals.isDismissed(detect('@api')!)).toBe(true);
  });

  it('tracks menus independently at the same position', () => {
    const dismissals = new TriggerDismissals();
    dismissals.dismiss(detect('@a')!);

    expect(dismissals.isDismissed(detect('/a')!)).toBe(false);
  });

  it('clears on send', () => {
    const dismissals = new TriggerDismissals();
    const match = detect('@api');
    dismissals.dismiss(match!);
    dismissals.clear();

    expect(dismissals.isDismissed(match!)).toBe(false);
  });
});
