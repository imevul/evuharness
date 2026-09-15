import {
  applyPickToText,
  type ContextMenuDescriptor,
  type ContextMenuItem,
  type ContextMenuNode,
  type ContextRef,
  defaultToken,
  detectTrigger,
  findItem,
  groupsAlongPath,
  isGroup,
  resolveChip,
  TriggerDismissals,
  type TriggerMatch,
} from '@evu/harness-protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ComposerValue {
  text: string;
  caret: number;
  /**
   * Structured picks accumulated for this draft.
   *
   * Carried alongside the text rather than derived from it: the runtime should
   * never have to parse prose to learn what the user selected. Tokens in the text
   * are for humans and the model to read.
   */
  refs: ContextRef[];
}

/** How the hook loads a menu level. Usually `client.contextMenuItems`. */
export type ContextMenuFetcher = (
  menuId: string,
  request: { query: string; path: string[] },
  signal: AbortSignal,
) => Promise<{ nodes: ContextMenuNode[] }>;

export interface UseContextMenuOptions {
  menus: readonly ContextMenuDescriptor[];
  fetchItems: ContextMenuFetcher;
  value: ComposerValue;
  onChange: (next: ComposerValue) => void;
  /** Debounce for keystroke-driven fetches. */
  debounceMs?: number;
}

export interface ContextMenuState {
  /** Null when no trigger is active, which is the common case. */
  match: TriggerMatch | null;
  menu: ContextMenuDescriptor | null;
  /** The level currently on screen: top level, or the children of `path`. */
  nodes: ContextMenuNode[];
  path: string[];
  loading: boolean;
  error: string | null;
  highlighted: number;
  setHighlighted: (index: number) => void;
  /** Drill into a group, or commit an item. */
  select: (node: ContextMenuNode) => void;
  /** Leave the current group, or dismiss when already at the top. */
  back: () => void;
  dismiss: () => void;
}

/**
 * Composer-side driver for the context menu catalog.
 *
 * This is the whole of the trigger interaction: detect, load a level, drill in,
 * commit. It is one hook over the whole catalog rather than one per trigger,
 * because `@` and `/` differ only by their descriptor. A host that registers a
 * third trigger gets this behavior with no new UI code.
 *
 * Detection, insertion, and chip resolution come from the protocol engine, so this
 * hook and the runtime agree on what the text means by construction.
 */
export function useContextMenu(options: UseContextMenuOptions): ContextMenuState {
  const { menus, fetchItems, value, onChange, debounceMs = 120 } = options;

  const [path, setPath] = useState<string[]>([]);
  const [nodes, setNodes] = useState<ContextMenuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  // Dismissals are a ref, not state: pressing Escape must not re-render, and the
  // record has to survive the re-render that the next keystroke causes. Otherwise
  // a dismissed popup reopens on the very next character.
  const dismissals = useRef(new TriggerDismissals());

  const match = useMemo(() => {
    const found = detectTrigger(value.text, value.caret, menus);
    if (found === null) return null;
    return dismissals.current.isDismissed(found) ? null : found;
  }, [value.text, value.caret, menus]);

  const menu = useMemo(
    () => (match === null ? null : (menus.find((m) => m.id === match.menuId) ?? null)),
    [match, menus],
  );

  // A new trigger, or a changed query, starts at the top level again: results for
  // "@fo" are not a subset of a drill-in the user made under a different query.
  const matchKey = match === null ? null : `${match.menuId}:${match.start}`;
  const previousKey = useRef<string | null>(null);
  useEffect(() => {
    if (previousKey.current !== matchKey) {
      previousKey.current = matchKey;
      setPath([]);
      setHighlighted(0);
    }
  }, [matchKey]);

  const query = match?.query ?? '';
  const menuId = menu?.id ?? null;

  useEffect(() => {
    if (menuId === null) {
      setNodes([]);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    // Debounced and aborted together: a fast typist otherwise leaves a queue of
    // in-flight requests whose responses can land out of order and show results
    // for a prefix of what is now in the box.
    const timer = setTimeout(() => {
      fetchItems(menuId, { query, path }, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setNodes(response.nodes);
          setError(null);
          setHighlighted(0);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setNodes([]);
          setError(cause instanceof Error ? cause.message : 'lookup_failed');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `path` is state, so its identity is stable until `setPath` runs; it can go in
    // the dependency list directly without a derived key.
  }, [menuId, query, path, fetchItems, debounceMs]);

  const dismiss = useCallback(() => {
    if (match !== null) dismissals.current.dismiss(match);
    setNodes([]);
  }, [match]);

  const commit = useCallback(
    (item: ContextMenuItem) => {
      if (match === null || menu === null) return;

      const chip = resolveChip({
        item,
        groups: groupsAlongPath(nodes, path),
        menuIcon: menu.icon,
        menuInsert: menu.insert,
        trigger: match.trigger,
      });

      const token = defaultToken({ trigger: match.trigger, path, itemId: item.id });
      const insertion = chip === null ? token : chip.label;
      const next = applyPickToText(value.text, match, insertion);

      onChange({
        text: next.text,
        caret: next.caret,
        refs: [
          ...value.refs,
          {
            menu: menu.id,
            path,
            id: item.id,
            token,
            ...(item.payload === undefined ? {} : { payload: item.payload }),
          },
        ],
      });

      // The trigger text is gone, so there is nothing left to dismiss; clearing the
      // level avoids one frame of stale results if the user types another trigger.
      setNodes([]);
      setPath([]);
    },
    [match, menu, nodes, path, value, onChange],
  );

  const select = useCallback(
    (node: ContextMenuNode) => {
      if (isGroup(node)) {
        setPath((current) => [...current, node.id]);
        setHighlighted(0);
        return;
      }
      commit(node);
    },
    [commit],
  );

  const back = useCallback(() => {
    if (path.length === 0) {
      dismiss();
      return;
    }
    setPath((current) => current.slice(0, -1));
    setHighlighted(0);
  }, [path.length, dismiss]);

  return {
    match,
    menu,
    nodes,
    path,
    loading,
    error,
    highlighted,
    setHighlighted,
    select,
    back,
    dismiss,
  };
}

/** Resolve a ref back to its item, for rendering a chip from a stored draft. */
export function itemForRef(
  nodes: readonly ContextMenuNode[],
  ref: ContextRef,
): ContextMenuItem | null {
  return findItem(nodes, ref.path, ref.id);
}
