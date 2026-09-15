import {
  ContextMenuDescriptorSchema,
  type ContextMenuItemsResponse,
  type ContextMenuNode,
  defaultToken,
  filterNodes,
  type Scope,
} from '@evu/harness-protocol';
import { normalizeSource } from './presets.js';
import type { ContextMenuDefinition, ContextMenuPick, RegisteredContextMenu } from './types.js';

export interface ListMenuItemsOptions {
  query?: string;
  path?: string[];
  scope?: Scope;
  signal?: AbortSignal | undefined;
}

/**
 * The context menu catalog.
 *
 * The runtime has no mention concept and no command concept: `@` and `/` are
 * ordinary entries created by presets over this same registry, and a host adds its
 * own by registering another definition.
 */
export class ContextMenuRegistry {
  private readonly menus = new Map<string, RegisteredContextMenu>();
  private readonly triggers = new Map<string, string>();

  constructor(definitions: Iterable<ContextMenuDefinition> = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: ContextMenuDefinition): void {
    if (this.menus.has(definition.id)) {
      throw new Error(`Duplicate context menu id: ${definition.id}`);
    }

    // A shared trigger is unresolvable: detection routes purely on the character,
    // so two menus claiming '@' would make one of them unreachable.
    const existing = this.triggers.get(definition.trigger);
    if (existing !== undefined) {
      throw new Error(
        `Context menu trigger '${definition.trigger}' is already used by '${existing}'`,
      );
    }
    if (/\s/.test(definition.trigger) || definition.trigger.length !== 1) {
      throw new Error(
        `Context menu trigger must be a single non-whitespace character, got '${definition.trigger}'`,
      );
    }

    const descriptor = ContextMenuDescriptorSchema.parse({
      id: definition.id,
      trigger: definition.trigger,
      ...(definition.title === undefined ? {} : { title: definition.title }),
      ...(definition.icon === undefined ? {} : { icon: definition.icon }),
      ...(definition.insert === undefined ? {} : { insert: definition.insert }),
      ...(definition.effect === undefined ? {} : { effect: definition.effect }),
      ...(definition.emptyQueryBehavior === undefined
        ? {}
        : { emptyQueryBehavior: definition.emptyQueryBehavior }),
      ...(definition.searchScope === undefined ? {} : { searchScope: definition.searchScope }),
      ...(definition.minQueryLength === undefined
        ? {}
        : { minQueryLength: definition.minQueryLength }),
    });

    const token =
      definition.token ??
      ((pick: ContextMenuPick) =>
        defaultToken({ trigger: pick.trigger, path: pick.path, itemId: pick.item.id }));

    const resolve =
      definition.resolve ?? (() => ({ effect: descriptor.effect }) as { effect: 'text' });

    this.menus.set(definition.id, {
      descriptor,
      source: normalizeSource(definition.source, `${definition.id}:source`),
      token,
      resolve,
    });
    this.triggers.set(definition.trigger, definition.id);
  }

  has(id: string): boolean {
    return this.menus.has(id);
  }

  get(id: string): RegisteredContextMenu {
    const menu = this.menus.get(id);
    if (menu === undefined) {
      throw new Error(`Unknown context menu: ${id}`);
    }
    return menu;
  }

  byTrigger(trigger: string): RegisteredContextMenu | null {
    const id = this.triggers.get(trigger);
    return id === undefined ? null : this.get(id);
  }

  descriptors() {
    return [...this.menus.values()].map((menu) => menu.descriptor);
  }

  get size(): number {
    return this.menus.size;
  }

  /**
   * Fetch and filter one level of a menu.
   *
   * The source is asked for the level, then filtering is applied here rather than
   * inside the source. That keeps sources trivial to write — return your data — and
   * keeps search semantics identical across every menu.
   */
  async listItems(
    menuId: string,
    options: ListMenuItemsOptions = {},
  ): Promise<ContextMenuItemsResponse> {
    const menu = this.get(menuId);
    const query = options.query ?? '';
    const path = options.path ?? [];

    const nodes = await menu.source.list({
      query,
      path,
      scope: options.scope ?? {},
      signal: options.signal,
    });

    const filtered: ContextMenuNode[] = filterNodes(nodes, {
      query,
      searchScope: menu.descriptor.searchScope,
      emptyQueryBehavior: menu.descriptor.emptyQueryBehavior,
    });

    return {
      menu: menuId,
      trigger: menu.descriptor.trigger,
      path,
      nodes: filtered,
    };
  }

  /** The wire text a pick inserts. */
  tokenFor(pick: ContextMenuPick): string {
    return this.get(pick.menuId).token(pick);
  }
}
