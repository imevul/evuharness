import { z } from 'zod';

/**
 * Chip presentation overrides.
 *
 * `chip` is an override layer, not a second definition: an item declares its
 * presentation once via `label` / `icon`, and the common case needs no `chip`
 * field at all. `chip: false` inserts plain text instead of a chip, which is
 * what lets snippet or emoji style menus work without pretending to be
 * references.
 */
export const ChipOverrideSchema = z.object({
  /** Overrides the item label. Useful when a row label only reads correctly beside its hint. */
  label: z.string().optional(),
  /** `null` suppresses the icon; omitted inherits down the chain. */
  icon: z.string().nullable().optional(),
  tone: z.enum(['neutral', 'accent', 'warn']).optional(),
});
export type ChipOverride = z.infer<typeof ChipOverrideSchema>;

export const ContextMenuItemSchema = z.object({
  kind: z.literal('item'),
  id: z.string().min(1),
  label: z.string(),
  /** Menu row only. Never rendered in a chip; chips stay compact. */
  hint: z.string().optional(),
  /** A serializable token, not a component, so the same data drives any surface. */
  icon: z.string().optional(),
  /** Extra search terms, matched but not displayed. */
  keywords: z.array(z.string()).optional(),
  disabled: z.boolean().optional(),
  chip: z.union([z.literal(false), ChipOverrideSchema]).optional(),
  /**
   * Pick-time client action. When set, the composer removes the trigger span
   * and reports the action; it must not insert a chip or send a turn.
   */
  action: z.string().min(1).optional(),
  /** Opaque host data, echoed back to the menu resolver at send time. */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ContextMenuItem = z.infer<typeof ContextMenuItemSchema>;

/**
 * Well-known composer pick-time actions.
 *
 * Hosts may define their own action strings. These are the ones the kit
 * already knows how to honour when the matching chrome is mounted.
 */
export const COMPOSER_ACTIONS = {
  openModelPicker: 'open-model-picker',
  switchToPlanMode: 'switch-to-plan-mode',
} as const;

/**
 * A group of nodes.
 *
 * Groups nest to any depth. `lazy` defers children until drill-in, which is what
 * makes a filesystem-shaped source practical.
 */
export interface ContextMenuGroup {
  kind: 'group';
  id: string;
  label: string;
  hint?: string | undefined;
  /** Inherited by descendant chips that declare no icon of their own. */
  icon?: string | undefined;
  children?: ContextMenuNode[] | undefined;
  lazy?: boolean | undefined;
}

/**
 * One recursive union covers every menu shape: flat items, grouped items, or a
 * mix at the same level.
 */
export type ContextMenuNode = ContextMenuGroup | ContextMenuItem;

export const ContextMenuGroupSchema: z.ZodType<ContextMenuGroup> = z.lazy(() =>
  z.object({
    kind: z.literal('group'),
    id: z.string().min(1),
    label: z.string(),
    hint: z.string().optional(),
    icon: z.string().optional(),
    children: z.array(ContextMenuNodeSchema).optional(),
    lazy: z.boolean().optional(),
  }),
);

export const ContextMenuNodeSchema: z.ZodType<ContextMenuNode> = z.lazy(() =>
  z.union([ContextMenuGroupSchema, ContextMenuItemSchema]),
);

/** How a picked item is inserted into the composer. */
export const MenuInsertModeSchema = z.enum(['chip', 'text']);
export type MenuInsertMode = z.infer<typeof MenuInsertModeSchema>;

/**
 * What a picked reference does when the message is sent.
 *
 * - `text`: the token stays inline and the model reads it.
 * - `context`: the resolver returns a context block appended to the turn.
 * - `prompt`: the resolver returns text merged into the leading system message.
 * - `command`: the resolver may rewrite the message or adjust turn setup.
 */
export const MenuEffectSchema = z.enum(['text', 'context', 'prompt', 'command']);
export type MenuEffect = z.infer<typeof MenuEffectSchema>;

export const EmptyQueryBehaviorSchema = z.enum(['groups', 'flat']);
export type EmptyQueryBehavior = z.infer<typeof EmptyQueryBehaviorSchema>;

export const SearchScopeSchema = z.enum(['flat', 'current-level']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

/**
 * A catalog entry as advertised to clients.
 *
 * There is no mention concept and no command concept in the protocol: `@` and
 * `/` are ordinary entries, and a host registers its own by adding one.
 */
export const ContextMenuDescriptorSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  title: z.string().optional(),
  /** Default icon for this menu's chips, last stop before the trigger character. */
  icon: z.string().optional(),
  insert: MenuInsertModeSchema.default('chip'),
  effect: MenuEffectSchema.default('text'),
  emptyQueryBehavior: EmptyQueryBehaviorSchema.default('groups'),
  searchScope: SearchScopeSchema.default('flat'),
  minQueryLength: z.number().int().nonnegative().default(0),
});
export type ContextMenuDescriptor = z.infer<typeof ContextMenuDescriptorSchema>;

/** A request for one level of a menu. `path` is the drill-in trail. */
export const ContextMenuItemsRequestSchema = z.object({
  query: z.string().default(''),
  path: z.array(z.string()).default([]),
  workspaceId: z.string().min(1).optional(),
});
export type ContextMenuItemsRequest = z.infer<typeof ContextMenuItemsRequestSchema>;

export const ContextMenuItemsResponseSchema = z.object({
  menu: z.string(),
  trigger: z.string(),
  path: z.array(z.string()).default([]),
  nodes: z.array(ContextMenuNodeSchema),
});
export type ContextMenuItemsResponse = z.infer<typeof ContextMenuItemsResponseSchema>;

/**
 * A structured reference recorded when a user picks an item.
 *
 * The composer sends these alongside the wire text so the runtime never has to
 * re-parse prose to recover what the user selected.
 */
export const ContextRefSchema = z.object({
  menu: z.string().min(1),
  path: z.array(z.string()).default([]),
  id: z.string().min(1),
  /** The exact text inserted into the message, for correlation. */
  token: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ContextRef = z.infer<typeof ContextRefSchema>;
