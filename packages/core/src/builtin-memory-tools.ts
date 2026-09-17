import type { MemoryStore } from './memory-store.js';
import type { ToolDefinition } from './tools.js';
import { wrapUntrustedToolResult } from './untrusted.js';

/**
 * USER.md and MEMORY.md tools.
 *
 * Descriptions carry the split the model must follow: USER is the person
 * (facts, preferences); MEMORY is everything else that should survive a chat.
 */
export function builtinMemoryTools(store: MemoryStore, clock: () => string): ToolDefinition[] {
  return [
    {
      name: 'read_user',
      description:
        'Read USER.md, the standing profile of the person you are talking to: name, pronouns, timezone, voice rules, allergies, how they like to be addressed. Use this for user facts and preferences only — not projects or environment notes.',
      parameters: { type: 'object', properties: {} },
      mutates: false,
      approval: 'always_allow',
      builtin: true,
      handler: async () => {
        const text = await store.getUser();
        return wrapUntrustedToolResult('read_user', text === '' ? '(empty USER.md)' : text);
      },
    },
    {
      name: 'write_user',
      description:
        'Replace USER.md with the full new profile. Use only for standing facts and preferences about the person (name, pronouns, timezone, voice, address). Do not put project notes, environment state, or “we tried X” here — those belong in remember().',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The entire USER.md document.' },
        },
        required: ['text'],
      },
      mutates: true,
      approval: 'requires_approval',
      builtin: true,
      handler: async (args) => {
        const text = String(args.text ?? '');
        await store.setUser(text);
        return wrapUntrustedToolResult('write_user', 'USER.md updated.');
      },
    },
    {
      name: 'search_memory',
      description:
        'Search MEMORY rows for projects, decisions, environment notes, and other things that should persist across chats. Do not use this for user facts or preferences — those live in USER.md (read_user / write_user).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against title and body.' },
        },
      },
      mutates: false,
      approval: 'always_allow',
      builtin: true,
      handler: async (args) => {
        const query = typeof args.query === 'string' ? args.query : undefined;
        const rows = await store.list(query);
        if (rows.length === 0) {
          return wrapUntrustedToolResult('search_memory', 'No matching memories.');
        }
        const text = rows
          .map((row) => `- ${row.id} ${row.title === '' ? '(untitled)' : row.title}\n  ${row.body}`)
          .join('\n');
        return wrapUntrustedToolResult('search_memory', text);
      },
    },
    {
      name: 'remember',
      description:
        'Append a MEMORY row for something that should persist across chats: a project, a decision, an environment note, “we tried X and it failed”. Never store user facts or preferences here — those belong in write_user().',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short label.' },
          body: { type: 'string', description: 'The fact to remember.' },
        },
        required: ['body'],
      },
      mutates: true,
      approval: 'requires_approval',
      builtin: true,
      handler: async (args) => {
        const id = crypto.randomUUID();
        const title = String(args.title ?? '');
        const body = String(args.body ?? '');
        await store.upsert({ id, title, body, updatedAt: clock() });
        return wrapUntrustedToolResult('remember', `Remembered ${id}.`);
      },
    },
    {
      name: 'forget',
      description: 'Delete a MEMORY row by id. Use after search_memory. Does not edit USER.md.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory id from search_memory.' },
        },
        required: ['id'],
      },
      mutates: true,
      approval: 'requires_approval',
      builtin: true,
      handler: async (args) => {
        const id = String(args.id ?? '');
        const deleted = await store.delete(id);
        return wrapUntrustedToolResult('forget', deleted ? `Forgot ${id}.` : `No memory ${id}.`);
      },
    },
  ];
}
