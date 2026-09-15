import type { ContextMenuGroup, ContextMenuItem } from '../context-menus.js';

export interface ResolvedChip {
  label: string;
  /** A serializable token the surface maps to a glyph or component. */
  icon: string;
  tone: 'neutral' | 'accent' | 'warn';
}

export interface ResolveChipInput {
  item: ContextMenuItem;
  /** Groups from the drill-in path, nearest ancestor last. */
  groups?: readonly ContextMenuGroup[];
  menuIcon?: string | undefined;
  menuInsert?: 'chip' | 'text' | undefined;
  trigger: string;
}

/**
 * Resolve how a picked item appears once inserted.
 *
 * Returns `null` when the pick should insert plain text rather than a chip, which
 * is what lets a snippet or emoji menu use the same engine without pretending to
 * be a reference.
 *
 * `chip` is an override layer over the item's own presentation, not a second
 * definition, so the common case needs no `chip` field at all.
 */
export function resolveChip(input: ResolveChipInput): ResolvedChip | null {
  const { item } = input;

  if (item.chip === false) {
    return null;
  }
  if (item.chip === undefined && (input.menuInsert ?? 'chip') === 'text') {
    return null;
  }

  const override = item.chip === undefined ? undefined : item.chip;

  return {
    label: override?.label ?? item.label,
    icon: resolveChipIcon(input, override?.icon),
    tone: override?.tone ?? 'neutral',
  };
}

/**
 * Icon inheritance, most specific first:
 * chip override, item, nearest ancestor group, menu default, trigger character.
 *
 * Group inheritance is what keeps source data lean: a `Services` group sets one
 * icon and none of its items need to repeat it.
 *
 * An explicit `null` on the override suppresses the icon entirely, which is
 * distinct from omitting it — omission inherits.
 */
function resolveChipIcon(input: ResolveChipInput, overrideIcon: string | null | undefined): string {
  if (overrideIcon === null) {
    return '';
  }
  if (overrideIcon !== undefined) {
    return overrideIcon;
  }
  if (input.item.icon !== undefined) {
    return input.item.icon;
  }

  const groups = input.groups ?? [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const icon = groups[index]?.icon;
    if (icon !== undefined) {
      return icon;
    }
  }

  return input.menuIcon ?? input.trigger;
}

/**
 * The default wire token for a pick.
 *
 * Path-qualified and colon-separated, producing `@service:api` and `/doctor`. The
 * shape is chosen to be readable to a model as prose while still parsing cleanly,
 * so a host needs no custom token function in the common case.
 */
export function defaultToken(input: {
  trigger: string;
  path: readonly string[];
  itemId: string;
}): string {
  const prefix = input.path.length > 0 ? `${input.path.join(':')}:` : '';
  return `${input.trigger}${prefix}${input.itemId}`;
}
