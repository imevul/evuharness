/**
 * Durable USER.md + MEMORY.md, stored outside the settings JSON.
 *
 * Settings is for named profiles. These documents change on every remember /
 * write_user, so they live in their own store and do not dirty the settings
 * pristine-seed check.
 */

export interface MemoryEntryRecord {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

export interface MemoryStore {
  getUser(): Promise<string>;
  setUser(text: string): Promise<void>;
  list(query?: string): Promise<MemoryEntryRecord[]>;
  get(id: string): Promise<MemoryEntryRecord | null>;
  upsert(entry: { id: string; title: string; body: string; updatedAt: string }): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private user = '';
  private readonly entries = new Map<string, MemoryEntryRecord>();

  async getUser(): Promise<string> {
    return this.user;
  }

  async setUser(text: string): Promise<void> {
    this.user = text;
  }

  async list(query?: string): Promise<MemoryEntryRecord[]> {
    const needle = query?.trim().toLowerCase() ?? '';
    const rows = [...this.entries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (needle === '') return rows;
    return rows.filter(
      (row) => row.title.toLowerCase().includes(needle) || row.body.toLowerCase().includes(needle),
    );
  }

  async get(id: string): Promise<MemoryEntryRecord | null> {
    return this.entries.get(id) ?? null;
  }

  async upsert(entry: MemoryEntryRecord): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
}

/** Character budget for the injected USER prompt section. */
export const USER_PROMPT_CHAR_BUDGET = 4_000;

export function capUserProfile(text: string, budget = USER_PROMPT_CHAR_BUDGET): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;
  return `${trimmed.slice(0, budget)}\n…`;
}
