import {
  CachedSessionStore,
  createSessionRecord,
  InMemorySessionStore,
  isSessionLockStore,
  withSessionLock,
  wrapSessionStore,
} from '@evu/harness-core';
import { describe, expect, it, vi } from 'vitest';

function record(id: string, mode: 'ask' | 'agent' = 'ask') {
  return createSessionRecord({ id, mode, now: '2026-01-01T00:00:00.000Z' });
}

describe('CachedSessionStore', () => {
  it('loads through to the inner store and serves a later get from cache', async () => {
    const inner = new InMemorySessionStore();
    await inner.upsert(record('s1'));
    let gets = 0;
    const counting = {
      get: async (id: string) => {
        gets += 1;
        return inner.get(id);
      },
      upsert: (row: ReturnType<typeof record>) => inner.upsert(row),
      delete: (id: string) => inner.delete(id),
      listSummaries: (options?: Parameters<InMemorySessionStore['listSummaries']>[0]) =>
        inner.listSummaries(options),
    };
    const cache = new CachedSessionStore(counting);
    expect(await cache.get('s1')).toMatchObject({ id: 's1' });
    expect(await cache.get('s1')).toMatchObject({ id: 's1' });
    expect(gets).toBe(1);
    expect(cache.cacheSize).toBe(1);
  });

  it('clones records so a caller mutation does not write through the cache', async () => {
    const cache = new CachedSessionStore(new InMemorySessionStore());
    await cache.upsert(record('s1', 'ask'));
    const loaded = await cache.get('s1');
    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    loaded.mode = 'agent';
    expect((await cache.get('s1'))?.mode).toBe('ask');
  });

  it('write-through upsert updates the cache and the durable store', async () => {
    const inner = new InMemorySessionStore();
    const cache = new CachedSessionStore(inner);
    await cache.upsert(record('s1', 'ask'));
    await cache.upsert({ ...record('s1', 'agent'), title: 'Renamed' });
    expect((await cache.get('s1'))?.title).toBe('Renamed');
    expect((await inner.get('s1'))?.title).toBe('Renamed');
    expect((await inner.get('s1'))?.mode).toBe('agent');
  });

  it('evicts the least-recently-used entry when over maxEntries', async () => {
    const inner = new InMemorySessionStore();
    let gets = 0;
    const counting = {
      get: async (id: string) => {
        gets += 1;
        return inner.get(id);
      },
      upsert: (row: ReturnType<typeof record>) => inner.upsert(row),
      delete: (id: string) => inner.delete(id),
      listSummaries: (options?: Parameters<InMemorySessionStore['listSummaries']>[0]) =>
        inner.listSummaries(options),
    };
    const cache = new CachedSessionStore(counting, { maxEntries: 2 });
    await cache.upsert(record('a'));
    await cache.upsert(record('b'));
    await cache.get('a');
    gets = 0;
    await cache.upsert(record('c'));
    expect(cache.cacheSize).toBe(2);
    gets = 0;
    await cache.get('a'); // still cached
    expect(gets).toBe(0);
    gets = 0;
    await cache.get('b'); // evicted earlier → inner load
    expect(gets).toBe(1);
  });

  it('does not serve a durable row after delete', async () => {
    const cache = new CachedSessionStore(new InMemorySessionStore());
    await cache.upsert(record('s1'));
    expect(await cache.delete('s1')).toBe(true);
    expect(await cache.get('s1')).toBeNull();
    expect(cache.cacheSize).toBe(0);
  });

  it('expires idle entries when ttlMs elapses', async () => {
    let now = 1_000;
    const inner = new InMemorySessionStore();
    let gets = 0;
    const counting = {
      get: async (id: string) => {
        gets += 1;
        return inner.get(id);
      },
      upsert: (row: ReturnType<typeof record>) => inner.upsert(row),
      delete: (id: string) => inner.delete(id),
      listSummaries: (options?: Parameters<InMemorySessionStore['listSummaries']>[0]) =>
        inner.listSummaries(options),
    };
    const cache = new CachedSessionStore(counting, { ttlMs: 50, now: () => now });
    await cache.upsert(record('s1'));
    gets = 0;
    expect(await cache.get('s1')).toMatchObject({ id: 's1' });
    expect(gets).toBe(0);
    now = 1_051;
    gets = 0;
    expect(await cache.get('s1')).toMatchObject({ id: 's1' });
    expect(gets).toBe(1);
  });

  it('serializes concurrent runExclusive sections on one session', async () => {
    const cache = new CachedSessionStore(new InMemorySessionStore());
    await cache.upsert(record('s1'));
    let concurrent = 0;
    let maxConcurrent = 0;
    const work = async () =>
      cache.runExclusive('s1', async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 30));
        concurrent -= 1;
      });
    await Promise.all([work(), work(), work()]);
    expect(maxConcurrent).toBe(1);
  });

  it('allows re-entrant get/upsert inside runExclusive', async () => {
    const cache = new CachedSessionStore(new InMemorySessionStore());
    await cache.upsert(record('s1', 'ask'));
    await cache.runExclusive('s1', async () => {
      const current = await cache.get('s1');
      expect(current?.mode).toBe('ask');
      await cache.upsert({ ...current!, mode: 'agent', updatedAt: '2026-01-01T00:00:01.000Z' });
      expect((await cache.get('s1'))?.mode).toBe('agent');
    });
  });

  it('does not evict a session while its exclusive section is held', async () => {
    const cache = new CachedSessionStore(new InMemorySessionStore(), { maxEntries: 1 });
    await cache.upsert(record('held'));
    await cache.runExclusive('held', async () => {
      await cache.upsert(record('other'));
      expect(await cache.get('held')).toMatchObject({ id: 'held' });
      expect(cache.cacheSize).toBeGreaterThanOrEqual(1);
    });
  });

  it('listSummaries reflects the durable store, including uncached rows', async () => {
    const inner = new InMemorySessionStore();
    await inner.upsert(record('only-inner'));
    const cache = new CachedSessionStore(inner, { maxEntries: 1 });
    await cache.upsert(record('cached'));
    const summaries = await cache.listSummaries();
    expect(summaries.map((row) => row.id).sort()).toEqual(['cached', 'only-inner']);
  });
});

describe('wrapSessionStore / withSessionLock', () => {
  it('wrapSessionStore(false) returns the inner store unchanged', () => {
    const inner = new InMemorySessionStore();
    expect(wrapSessionStore(inner, false)).toBe(inner);
  });

  it('wrapSessionStore() returns a lock store by default', () => {
    const wrapped = wrapSessionStore(new InMemorySessionStore(), undefined);
    expect(isSessionLockStore(wrapped)).toBe(true);
  });

  it('withSessionLock is a no-op for stores without a mutex', async () => {
    const inner = new InMemorySessionStore();
    const spy = vi.fn(async () => 7);
    await expect(withSessionLock(inner, 's1', spy)).resolves.toBe(7);
    expect(spy).toHaveBeenCalledOnce();
  });
});
