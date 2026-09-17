import {
  type ContextMenuDescriptor,
  type ContextMenuItem,
  type ContextMenuNode,
  defaultToken,
  isGroup,
  resolveChip,
} from '@evu/harness-protocol';
import type { ComposerChipRef, ComposerValue } from './serialize.js';

export interface CatalogHit {
  menu: ContextMenuDescriptor;
  item: ContextMenuItem;
  path: string[];
}

/** Walk groups so a `+` search can offer the same items `@` / `/` would. */
export function flattenMenuItems(
  nodes: readonly ContextMenuNode[],
  path: readonly string[] = [],
): { item: ContextMenuItem; path: string[] }[] {
  const out: { item: ContextMenuItem; path: string[] }[] = [];
  for (const node of nodes) {
    if (isGroup(node)) {
      out.push(...flattenMenuItems(node.children ?? [], [...path, node.id]));
      continue;
    }
    out.push({ item: node, path: [...path] });
  }
  return out;
}

export function matchesAddQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return fields.some((field) => field?.toLowerCase().includes(needle) === true);
}

/**
 * Leading mark for an add-menu row. Long icon tokens (`search`) paint over the
 * label in a 1.25em column; prefer the catalog trigger when the icon is a word.
 */
export function catalogMark(icon: string | undefined, trigger: string): string {
  if (icon !== undefined) {
    const glyphs = [...icon].length;
    if (glyphs > 0 && glyphs <= 2) return icon;
  }
  return trigger;
}

/**
 * Insert a catalog pick at the caret without a live trigger span.
 *
 * Same chip/token rules as `useContextMenu` commit. A trailing space keeps
 * `detectTrigger` from treating the new token as an open query.
 */
export function insertCatalogItemAtCaret(
  value: ComposerValue,
  menu: ContextMenuDescriptor,
  item: ContextMenuItem,
  path: readonly string[] = [],
): { value: ComposerValue; action?: string } {
  if (item.action !== undefined && item.action !== '') {
    return { value, action: item.action };
  }

  const chip = resolveChip({
    item,
    groups: [],
    menuIcon: menu.icon,
    menuInsert: menu.insert,
    trigger: menu.trigger,
  });
  const token = defaultToken({ trigger: menu.trigger, path, itemId: item.id });
  const insertion = chip === null ? item.label : token;

  const before = value.text.slice(0, value.caret);
  const after = value.text.slice(value.caret);
  const leading = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
  const trailing = after.startsWith(' ') ? '' : ' ';
  const inserted = `${leading}${insertion}${trailing}`;

  const ref: ComposerChipRef = {
    menu: menu.id,
    path: [...path],
    id: item.id,
    token: chip === null ? insertion : token,
    label: chip?.label ?? item.label,
    asChip: chip !== null,
    ...(chip?.icon !== undefined && chip.icon !== '' ? { icon: chip.icon } : {}),
    ...(chip !== null ? { tone: chip.tone } : {}),
    ...(item.payload === undefined ? {} : { payload: item.payload }),
  };

  return {
    value: {
      ...value,
      text: `${before}${inserted}${after}`,
      caret: before.length + inserted.length,
      refs: [...value.refs, ref],
    },
  };
}
