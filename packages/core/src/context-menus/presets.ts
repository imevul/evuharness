import type { ContextMenuItem, ContextMenuNode } from '@evu/harness-protocol';
import { COMPOSER_ACTIONS, nodesAtPath } from '@evu/harness-protocol';
import type {
  ContextMenuDefinition,
  ContextMenuSource,
  ContextMenuSourceContext,
  ContextMenuSourceInput,
} from './types.js';

/**
 * Wrap a static node list as a source.
 *
 * A static source holds the whole tree, so it resolves the drill-in path itself
 * rather than returning the top level for every request. Every source therefore
 * has the same contract — "return the level named by `path`" — which is what lets
 * static and dynamic sources compose in one menu.
 *
 * A path that lands on a lazy group yields nothing: a static tree that declares a
 * group lazy has genuinely not provided those children.
 */
export function staticSource(id: string, nodes: ContextMenuNode[]): ContextMenuSource {
  return { id, list: ({ path }) => nodesAtPath(nodes, path) ?? [] };
}

/** Normalize any accepted source shape to the object form. */
export function normalizeSource(input: ContextMenuSourceInput, id: string): ContextMenuSource {
  if (Array.isArray(input)) {
    return staticSource(id, input);
  }
  if (typeof input === 'function') {
    return { id, list: input };
  }
  return input;
}

/**
 * Combine several sources into one.
 *
 * Concatenation preserves source order, which is the only ordering a host can
 * reason about. Sources are queried in parallel because one slow source should not
 * serialize the rest.
 */
export function combineSources(
  sources: readonly ContextMenuSourceInput[],
  id: string,
): ContextMenuSource {
  const normalized: ContextMenuSource[] = sources.map((source, index) =>
    normalizeSource(source, `${id}:${index}`),
  );

  return {
    id,
    async list(ctx: ContextMenuSourceContext): Promise<ContextMenuNode[]> {
      const results = await Promise.all(normalized.map((source) => source.list(ctx)));
      return results.flat();
    },
  };
}

export interface MenuPresetOptions {
  sources: ContextMenuSourceInput[];
  id?: string;
  trigger?: string;
  title?: string;
  icon?: string;
  resolve?: ContextMenuDefinition['resolve'];
  token?: ContextMenuDefinition['token'];
}

/**
 * The `@` preset: reference something.
 *
 * Grouped browse on an empty query, flat search once typing starts, and the token
 * left inline for the model to read.
 *
 * A preset is only a set of defaults over `ContextMenuRegistry`. A host that wants
 * different behavior registers a raw definition instead; nothing in the runtime
 * treats mentions specially.
 */
export function mentionsMenu(options: MenuPresetOptions): ContextMenuDefinition {
  const id = options.id ?? 'mentions';
  return {
    id,
    trigger: options.trigger ?? '@',
    title: options.title ?? 'Mentions',
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    insert: 'chip',
    effect: 'text',
    emptyQueryBehavior: 'groups',
    searchScope: 'flat',
    source: combineSources(options.sources, id),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
  };
}

/**
 * The `/` preset: run or load something.
 *
 * Flat by default, since commands are a list rather than a hierarchy, and its
 * effect is `prompt`: the resolved body merges into the leading system message
 * rather than being sent as a mid-thread system turn.
 */
/** Catalog id for {@link modelCommandItem}. */
export const MODEL_COMMAND_ID = 'model';

/**
 * Optional `/model` command: pick opens the session model picker, and does
 * not insert a chip or start a turn.
 *
 * Hosts that want it drop the item into a `commandsMenu` / `skillsMenu`
 * source. Hosts that do not include it never advertise the row.
 */
export function modelCommandItem(): ContextMenuItem {
  return {
    kind: 'item',
    id: MODEL_COMMAND_ID,
    label: 'model',
    hint: 'Choose a model for this chat',
    action: COMPOSER_ACTIONS.openModelPicker,
  };
}

/** Catalog id for {@link planCommandItem}. */
export const PLAN_COMMAND_ID = 'plan';

/**
 * Optional `/plan` command: pick switches the draft to plan mode, and does
 * not insert a chip or start a turn.
 *
 * Same opt-in as {@link modelCommandItem}: include it in a `/` source or
 * omit it.
 */
export function planCommandItem(): ContextMenuItem {
  return {
    kind: 'item',
    id: PLAN_COMMAND_ID,
    label: 'plan',
    hint: 'Switch to plan mode',
    action: COMPOSER_ACTIONS.switchToPlanMode,
  };
}

export function commandsMenu(options: MenuPresetOptions): ContextMenuDefinition {
  const id = options.id ?? 'commands';
  return {
    id,
    trigger: options.trigger ?? '/',
    title: options.title ?? 'Commands',
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    insert: 'chip',
    effect: 'prompt',
    emptyQueryBehavior: 'flat',
    searchScope: 'flat',
    source: combineSources(options.sources, id),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
  };
}
