import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionRecord } from './session-record.js';
import type { ListSessionsOptions, SessionStore } from './stores.js';

/**
 * In-process session cache options.
 *
 * The cache sits in front of a durable `SessionStore` so hot sessions avoid a
 * round trip on every read, and so concurrent read-modify-write paths on one
 * session can share a mutex. Eviction is LRU by last access; entries currently
 * inside `runExclusive` are not eligible.
 */
export interface SessionCacheOptions {
  /** Maximum cached sessions. Defaults to 128. */
  maxEntries?: number;
  /**
   * Idle time-to-live in milliseconds.
   *
   * When set, an entry unused for longer than this is treated as a miss and
   * dropped on the next access. Omit for no TTL.
   */
  ttlMs?: number;
  /** Clock for TTL and tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 128;

/**
 * A `SessionStore` that also exposes a per-session exclusive lock.
 *
 * Locking is re-entrant for the same async continuation via
 * `AsyncLocalStorage`, so `get`/`upsert` called inside `runExclusive` do not
 * deadlock.
 */
export interface SessionLockStore extends SessionStore {
  runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  /** Number of entries currently held in the cache (not the durable store). */
  readonly cacheSize: number;
  /** Drop every cached entry. Durable storage is untouched. */
  clearCache(): void;
}

interface CacheEntry {
  record: SessionRecord;
  lastAccess: number;
}

/**
 * Wrap a durable session store with an LRU cache and per-session mutexes.
 *
 * Records are cloned on the way in and out. Sharing one mutable instance across
 * callers is exactly the accident that hid mode-clobber bugs in earlier
 * designs; cloning keeps `applyTurnPatch` honest while the lock serializes
 * competing writers on one session id.
 */
export class CachedSessionStore implements SessionLockStore {
  private readonly maxEntries: number;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  /** Tail of the per-session lock chain. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Session ids held by the current async exclusive section. */
  private readonly held = new AsyncLocalStorage<Set<string>>();

  constructor(
    private readonly inner: SessionStore,
    options: SessionCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (this.maxEntries < 1) {
      throw new Error('session cache maxEntries must be at least 1');
    }
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get cacheSize(): number {
    return this.entries.size;
  }

  clearCache(): void {
    this.entries.clear();
  }

  async runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.held.getStore();
    if (current?.has(sessionId)) {
      return fn();
    }

    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const ourTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => ourTurn);
    this.tails.set(sessionId, next);
    await previous;

    const nextHeld = new Set(current);
    nextHeld.add(sessionId);
    try {
      return await this.held.run(nextHeld, fn);
    } finally {
      release();
      // Drop settled tails so the map does not grow without bound for idle ids.
      if (this.tails.get(sessionId) === next) {
        this.tails.delete(sessionId);
      }
    }
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.runExclusive(id, async () => {
      const cached = this.peek(id);
      if (cached !== undefined) {
        this.touch(id, cached);
        return cloneRecord(cached.record);
      }

      const loaded = await this.inner.get(id);
      if (loaded === null) {
        this.entries.delete(id);
        return null;
      }
      this.put(id, loaded);
      return cloneRecord(loaded);
    });
  }

  async upsert(record: SessionRecord): Promise<void> {
    await this.runExclusive(record.id, async () => {
      const copy = cloneRecord(record);
      await this.inner.upsert(copy);
      this.put(record.id, copy);
    });
  }

  async listSummaries(options?: ListSessionsOptions) {
    // Listing must reflect the durable store, including sessions that were
    // never cached or were already evicted.
    return this.inner.listSummaries(options);
  }

  async delete(id: string): Promise<boolean> {
    return this.runExclusive(id, async () => {
      this.entries.delete(id);
      return this.inner.delete(id);
    });
  }

  private peek(id: string): CacheEntry | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return undefined;
    }
    if (this.ttlMs !== undefined && this.now() - entry.lastAccess > this.ttlMs) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  private touch(id: string, entry: CacheEntry): void {
    entry.lastAccess = this.now();
    // Re-insert so Map iteration order tracks LRU (oldest first).
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  private put(id: string, record: SessionRecord): void {
    this.entries.delete(id);
    this.entries.set(id, { record: cloneRecord(record), lastAccess: this.now() });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    const held = this.held.getStore() ?? new Set<string>();
    for (const id of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) {
        return;
      }
      if (held.has(id)) {
        continue;
      }
      this.entries.delete(id);
    }
  }
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return structuredClone(record);
}

export function isSessionLockStore(store: SessionStore): store is SessionLockStore {
  return (
    typeof (store as SessionLockStore).runExclusive === 'function' &&
    typeof (store as SessionLockStore).cacheSize === 'number'
  );
}

/**
 * Run `fn` under the store's per-session lock when one exists.
 *
 * Plain stores (including raw `InMemorySessionStore`) run `fn` immediately.
 * Prefer this for every read-modify-write on a session so enabling the cache
 * makes those paths atomic without forking call sites.
 */
export async function withSessionLock<T>(
  store: SessionStore,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (isSessionLockStore(store)) {
    return store.runExclusive(sessionId, fn);
  }
  return fn();
}

/**
 * Build a cached store, or return the inner store unchanged when caching is off.
 */
export function wrapSessionStore(
  inner: SessionStore,
  cache: SessionCacheOptions | false | undefined,
): SessionStore {
  if (cache === false) {
    return inner;
  }
  return new CachedSessionStore(inner, cache ?? {});
}
