import type { ContextMenuDescriptor } from '../context-menus.js';

export interface TriggerMatch {
  menuId: string;
  trigger: string;
  /** Text between the trigger character and the caret. */
  query: string;
  /** Index of the trigger character. */
  start: number;
  /** Caret index; the query ends here. */
  end: number;
}

/**
 * A trigger is only active at a word boundary.
 *
 * Without this an email address would open the mention menu on every `@`, and a
 * file path would open the command menu on every `/`.
 */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/**
 * Find the active menu trigger for a caret position.
 *
 * This is the single trigger-detection implementation for the whole catalog.
 * Adding a menu is adding a catalog entry, not another copy of this scan — which
 * is the entire reason menus are data rather than distinct features.
 *
 * Scans backwards from the caret and stops at the first trigger character that
 * sits on a word boundary. Whitespace in the candidate query ends the search,
 * because a menu query is a single token.
 */
export function detectTrigger(
  text: string,
  caret: number,
  menus: readonly Pick<ContextMenuDescriptor, 'id' | 'trigger' | 'minQueryLength'>[],
): TriggerMatch | null {
  if (menus.length === 0) {
    return null;
  }

  const position = Math.max(0, Math.min(caret, text.length));
  const byTrigger = new Map(menus.map((menu) => [menu.trigger, menu]));

  for (let index = position - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === undefined) {
      break;
    }

    // A menu query is one token: hitting whitespace means no trigger is active.
    if (/\s/.test(char)) {
      return null;
    }

    const menu = byTrigger.get(char);
    if (menu === undefined) {
      continue;
    }

    if (!isBoundary(text[index - 1])) {
      // Something like an email address. Keep scanning: an earlier trigger on a
      // real boundary may still be the active one.
      continue;
    }

    const query = text.slice(index + 1, position);
    if (query.length < (menu.minQueryLength ?? 0)) {
      return null;
    }

    return { menuId: menu.id, trigger: char, query, start: index, end: position };
  }

  return null;
}

/**
 * Replace an active trigger span with inserted text.
 *
 * Returns the new text and caret. A single trailing space is appended so a user
 * can keep typing without first clearing the chip boundary.
 */
export function applyPickToText(
  text: string,
  match: TriggerMatch,
  insertion: string,
): { text: string; caret: number } {
  const before = text.slice(0, match.start);
  const after = text.slice(match.end);
  const needsSpace = !after.startsWith(' ');
  const inserted = needsSpace ? `${insertion} ` : insertion;

  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

/**
 * A dismissal record, so escaping a menu does not immediately reopen it.
 *
 * Keyed by the trigger's position in the text: dismissing at index 4 suppresses
 * that occurrence while the user keeps typing, and a trigger typed elsewhere still
 * opens normally. Without position keying, one escape would disable a trigger
 * character for the rest of the message.
 */
export class TriggerDismissals {
  private readonly dismissed = new Set<string>();

  private key(menuId: string, start: number): string {
    return `${menuId}@${start}`;
  }

  dismiss(match: TriggerMatch): void {
    this.dismissed.add(this.key(match.menuId, match.start));
  }

  isDismissed(match: TriggerMatch): boolean {
    return this.dismissed.has(this.key(match.menuId, match.start));
  }

  /** Called after a send, when positions no longer mean anything. */
  clear(): void {
    this.dismissed.clear();
  }
}
