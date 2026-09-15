import type { ContextMenuGroup, ContextMenuItem, ContextMenuNode } from '../context-menus.js';

export function isGroup(node: ContextMenuNode): node is ContextMenuGroup {
  return node.kind === 'group';
}

export function isItem(node: ContextMenuNode): node is ContextMenuItem {
  return node.kind === 'item';
}

/** Terms an item is matched against. `hint` is included: it disambiguates rows. */
function searchTerms(node: ContextMenuNode): string[] {
  const terms = [node.label];
  if (node.hint !== undefined) {
    terms.push(node.hint);
  }
  if (isItem(node) && node.keywords !== undefined) {
    terms.push(...node.keywords);
  }
  terms.push(node.id);
  return terms;
}

function matches(node: ContextMenuNode, query: string): boolean {
  const needle = query.toLowerCase();
  return searchTerms(node).some((term) => term.toLowerCase().includes(needle));
}

/**
 * Walk a tree, yielding every item with the group path that leads to it.
 *
 * Only eagerly-loaded children are visited. A `lazy` group has no children yet, so
 * a flat search legitimately cannot see inside it until drill-in.
 */
export function* walkItems(
  nodes: readonly ContextMenuNode[],
  path: string[] = [],
): Generator<{ item: ContextMenuItem; path: string[] }> {
  for (const node of nodes) {
    if (isItem(node)) {
      yield { item: node, path: [...path] };
      continue;
    }
    if (node.children !== undefined) {
      yield* walkItems(node.children, [...path, node.id]);
    }
  }
}

export interface FilterOptions {
  query: string;
  /**
   * `flat` searches descendants and returns matching items without their groups,
   * which is what a user typing a name expects. `current-level` filters only the
   * level in view, which suits a menu used for browsing.
   */
  searchScope?: 'flat' | 'current-level';
  /** With an empty query, `groups` keeps structure and `flat` collapses it. */
  emptyQueryBehavior?: 'groups' | 'flat';
}

/**
 * Filter one level of a menu for display.
 *
 * An empty query is not a search: it is the browse state, so structure is
 * preserved rather than flattened.
 */
export function filterNodes(
  nodes: readonly ContextMenuNode[],
  options: FilterOptions,
): ContextMenuNode[] {
  const query = options.query.trim();

  if (query === '') {
    if ((options.emptyQueryBehavior ?? 'groups') === 'groups') {
      return [...nodes];
    }
    return [...walkItems(nodes)].map((entry) => entry.item);
  }

  if ((options.searchScope ?? 'flat') === 'current-level') {
    return nodes.filter((node) => matches(node, query));
  }

  const results: ContextMenuNode[] = [];

  for (const node of nodes) {
    if (isItem(node)) {
      if (matches(node, query)) {
        results.push(node);
      }
      continue;
    }

    // A lazy group cannot be searched into, so surface the group itself when its
    // own label matches. Hiding it would make its contents unreachable by search.
    if (node.children === undefined) {
      if (matches(node, query)) {
        results.push(node);
      }
      continue;
    }

    const descendants = [...walkItems([node])]
      .filter((entry) => matches(entry.item, query))
      .map((entry) => entry.item);

    if (descendants.length > 0) {
      results.push(...descendants);
    } else if (matches(node, query)) {
      results.push(node);
    }
  }

  return results;
}

/** Follow a drill-in path through eagerly-loaded children. */
export function nodesAtPath(
  nodes: readonly ContextMenuNode[],
  path: readonly string[],
): ContextMenuNode[] | null {
  let current: readonly ContextMenuNode[] = nodes;

  for (const segment of path) {
    const group = current.find(
      (node): node is ContextMenuGroup => isGroup(node) && node.id === segment,
    );
    if (group === undefined) {
      return null;
    }
    if (group.children === undefined) {
      // Lazy: the source must be asked for this level.
      return null;
    }
    current = group.children;
  }

  return [...current];
}

/** Collect the groups along a path, nearest ancestor last. */
export function groupsAlongPath(
  nodes: readonly ContextMenuNode[],
  path: readonly string[],
): ContextMenuGroup[] {
  const chain: ContextMenuGroup[] = [];
  let current: readonly ContextMenuNode[] = nodes;

  for (const segment of path) {
    const group = current.find(
      (node): node is ContextMenuGroup => isGroup(node) && node.id === segment,
    );
    if (group === undefined) {
      break;
    }
    chain.push(group);
    current = group.children ?? [];
  }

  return chain;
}

/** Locate an item by drill-in path and id. */
export function findItem(
  nodes: readonly ContextMenuNode[],
  path: readonly string[],
  itemId: string,
): ContextMenuItem | null {
  const level = nodesAtPath(nodes, path);
  if (level !== null) {
    const direct = level.find(
      (node): node is ContextMenuItem => isItem(node) && node.id === itemId,
    );
    if (direct !== undefined) {
      return direct;
    }
  }

  // Flat search results carry the item's own path, which may not be the path the
  // caller had in view, so fall back to a full walk.
  for (const entry of walkItems(nodes)) {
    if (entry.item.id === itemId) {
      return entry.item;
    }
  }

  return null;
}
