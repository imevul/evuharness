import type { ChatModeId, ContextMenuDescriptor, ContextMenuItem } from '@evu/harness-protocol';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type CatalogHit,
  catalogMark,
  flattenMenuItems,
  matchesAddQuery,
} from '../composer/add-menu.js';
import type { ContextMenuFetcher } from '../hooks/use-context-menu.js';
import { type ModeGlyphRenderer, resolveModeGlyph, titleCaseMode } from './ModeGlyph.js';

export interface ComposerAddMenuProps {
  menus: readonly ContextMenuDescriptor[];
  fetchItems: ContextMenuFetcher;
  debounceMs: number;
  modes: readonly ChatModeId[];
  /** Forwarded from `ComposerProps`, so mode rows match the mode chip. */
  renderModeGlyph?: ModeGlyphRenderer | undefined;
  attachmentsEnabled: boolean;
  attachLabel: ReactNode;
  onMode: (mode: ChatModeId) => void;
  onAttach: () => void;
  onInsertTrigger: (trigger: string) => void;
  onPickItem: (menu: ContextMenuDescriptor, item: ContextMenuItem, path: string[]) => void;
}

type AddRow =
  | { key: string; kind: 'mode'; mode: ChatModeId; label: string }
  | { key: string; kind: 'attach'; label: string }
  | { key: string; kind: 'menu'; menu: ContextMenuDescriptor; label: string }
  | { key: string; kind: 'item'; hit: CatalogHit; label: string; hint?: string };

/**
 * Inlaid `+` menu: search, then icon+label rows for modes, attach, catalog
 * triggers, and live hits from those catalogs.
 */
export function ComposerAddMenu(props: ComposerAddMenuProps) {
  const {
    menus,
    fetchItems,
    debounceMs,
    modes,
    renderModeGlyph,
    attachmentsEnabled,
    attachLabel,
    onMode,
    onAttach,
    onInsertTrigger,
    onPickItem,
  } = props;

  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const needle = query.trim();
    if (needle === '') {
      setHits([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void Promise.all(
        menus.map(async (menu) => {
          if (needle.length < menu.minQueryLength) return [] as CatalogHit[];
          try {
            const response = await fetchItems(
              menu.id,
              { query: needle, path: [] },
              controller.signal,
            );
            return flattenMenuItems(response.nodes).map(({ item, path }) => ({
              menu,
              item,
              path,
            }));
          } catch {
            return [] as CatalogHit[];
          }
        }),
      ).then((groups) => {
        if (controller.signal.aborted) return;
        setHits(groups.flat());
        setLoading(false);
        setHighlighted(0);
      });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [debounceMs, fetchItems, menus, query]);

  const rows = useMemo(() => {
    const next: AddRow[] = [];
    for (const mode of modes) {
      const label = titleCaseMode(mode);
      if (!matchesAddQuery(query, mode, label)) continue;
      next.push({ key: `mode:${mode}`, kind: 'mode', mode, label });
    }
    if (attachmentsEnabled && matchesAddQuery(query, 'attach', 'files')) {
      next.push({ key: 'attach', kind: 'attach', label: 'Attach' });
    }
    for (const menu of menus) {
      const label = menu.title ?? menu.id;
      if (!matchesAddQuery(query, menu.id, menu.title, menu.trigger, label)) continue;
      next.push({ key: `menu:${menu.id}`, kind: 'menu', menu, label });
    }
    for (const hit of hits) {
      const label = hit.item.label;
      next.push({
        key: `item:${hit.menu.id}:${hit.path.join('/')}:${hit.item.id}`,
        kind: 'item',
        hit,
        label,
        ...(hit.item.hint !== undefined
          ? { hint: hit.item.hint }
          : { hint: hit.menu.title ?? hit.menu.id }),
      });
    }
    return next;
  }, [attachmentsEnabled, hits, menus, modes, query]);

  useEffect(() => {
    if (highlighted >= rows.length) {
      setHighlighted(0);
    }
  }, [highlighted, rows.length]);

  const activate = (row: AddRow) => {
    switch (row.kind) {
      case 'mode':
        onMode(row.mode);
        return;
      case 'attach':
        onAttach();
        return;
      case 'menu':
        onInsertTrigger(row.menu.trigger);
        return;
      case 'item':
        onPickItem(row.hit.menu, row.hit.item, row.hit.path);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (rows.length === 0) return;
      setHighlighted((current) => (current + 1) % rows.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      setHighlighted((current) => (current - 1 + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[highlighted];
      if (row !== undefined) activate(row);
    }
  };

  const attachIcon = typeof attachLabel === 'string' ? <AttachGlyph /> : attachLabel;
  const showEmpty = !loading && rows.length === 0;

  return (
    <div data-harness="composer-add-menu" role="dialog" aria-label="Add to message">
      <input
        ref={searchRef}
        type="search"
        data-harness="composer-add-search"
        aria-label="Search"
        aria-controls={listId}
        placeholder="Search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlighted(0);
        }}
        onKeyDown={onSearchKeyDown}
      />
      <div id={listId} data-harness="composer-add-list" role="listbox" aria-label="Add to message">
        {loading && <div data-harness="composer-add-loading">Searching…</div>}
        {showEmpty && <div data-harness="composer-add-empty">No matches</div>}
        {rows.map((row, index) => (
          <button
            key={row.key}
            type="button"
            role="option"
            aria-selected={index === highlighted}
            data-harness="composer-add-item"
            data-kind={row.kind}
            data-highlighted={index === highlighted ? 'true' : undefined}
            {...(row.kind === 'mode' ? { 'data-mode': row.mode } : {})}
            {...(row.kind === 'attach' ? { 'aria-label': 'Attach files' } : {})}
            disabled={row.kind === 'item' && row.hit.item.disabled === true}
            onMouseEnter={() => setHighlighted(index)}
            onClick={() => activate(row)}
          >
            <span data-harness="composer-add-icon" aria-hidden="true">
              {row.kind === 'mode'
                ? resolveModeGlyph(row.mode, renderModeGlyph)
                : row.kind === 'attach'
                  ? attachIcon
                  : row.kind === 'menu'
                    ? catalogMark(row.menu.icon, row.menu.trigger)
                    : catalogMark(row.hit.item.icon ?? row.hit.menu.icon, row.hit.menu.trigger)}
            </span>
            <span data-harness="composer-add-label">{row.label}</span>
            {row.kind === 'item' && row.hint !== undefined ? (
              <span data-harness="composer-add-hint">{row.hint}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function AttachGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M20 10.5 11.8 18.7a4.6 4.6 0 0 1-6.5-6.5l8.2-8.2a3 3 0 1 1 4.3 4.3l-8.2 8.2a1.4 1.4 0 0 1-2-2l7.5-7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
