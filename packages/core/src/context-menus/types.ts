import type {
  ChatModeId,
  ContextMenuDescriptor,
  ContextMenuItem,
  ContextMenuNode,
  ContextRef,
  EmptyQueryBehavior,
  MenuEffect,
  MenuInsertMode,
  Scope,
  SearchScope,
} from '@evu/harness-protocol';

export interface ContextMenuSourceContext {
  query: string;
  /** Drill-in trail; empty at the top level. */
  path: string[];
  /** Threaded so a source can list only the current workspace's data. */
  scope: Scope;
  signal?: AbortSignal | undefined;
}

export interface ContextMenuSource {
  id: string;
  list(ctx: ContextMenuSourceContext): ContextMenuNode[] | Promise<ContextMenuNode[]>;
}

/**
 * Accepted source shapes.
 *
 * A static array covers the common case without ceremony; a function covers
 * dynamic data; the full object form exists when a source wants an id.
 */
export type ContextMenuSourceInput =
  | ContextMenuSource
  | ContextMenuNode[]
  | ((ctx: ContextMenuSourceContext) => ContextMenuNode[] | Promise<ContextMenuNode[]>);

/** Everything a token builder or resolver knows about one pick. */
export interface ContextMenuPick {
  menuId: string;
  trigger: string;
  path: string[];
  item: ContextMenuItem;
}

export interface ContextMenuResolveInput {
  ref: ContextRef;
  scope: Scope;
  mode: ChatModeId;
  sessionId: string;
  /** The message text as typed, including the token. */
  text: string;
  signal?: AbortSignal | undefined;
}

/**
 * What a reference does at send time.
 *
 * This is what makes a menu more than autocomplete.
 */
export type ContextMenuResolution =
  /** Leave the token inline for the model to read. */
  | { effect: 'text' }
  /** Append a context block to the turn. */
  | { effect: 'context'; text: string; label?: string }
  /** Merge text into the leading system message. */
  | { effect: 'prompt'; text: string }
  /** Adjust the turn before it starts. */
  | {
      effect: 'command';
      /** Replace the outgoing message text. */
      replaceText?: string;
      /** Request a mode for this turn. Subject to the same pinning rules. */
      mode?: ChatModeId;
      /** Merge into the leading system message. */
      prompt?: string;
      /** Ask the runtime to offer these tools first. */
      preferTools?: string[];
    };

export type ContextMenuResolver = (
  input: ContextMenuResolveInput,
) => ContextMenuResolution | Promise<ContextMenuResolution>;

/** A catalog entry as a host registers it. */
export interface ContextMenuDefinition {
  id: string;
  /** Must be unique across the catalog; the trigger is how input is routed. */
  trigger: string;
  title?: string;
  /** Default icon for this menu's chips. */
  icon?: string;
  insert?: MenuInsertMode;
  effect?: MenuEffect;
  emptyQueryBehavior?: EmptyQueryBehavior;
  searchScope?: SearchScope;
  minQueryLength?: number;
  source: ContextMenuSourceInput;
  /** Override the wire text a pick inserts. */
  token?: (pick: ContextMenuPick) => string;
  resolve?: ContextMenuResolver;
}

/** A registered entry: the advertised descriptor plus its behavior. */
export interface RegisteredContextMenu {
  descriptor: ContextMenuDescriptor;
  source: ContextMenuSource;
  token: (pick: ContextMenuPick) => string;
  resolve: ContextMenuResolver;
}
