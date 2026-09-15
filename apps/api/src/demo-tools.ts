import type { ToolDefinition } from '@evu/harness-core';

/**
 * Tools for the demo, exercising the annotations the gates depend on.
 *
 * None of these belong to the library. They exist so the demo can show a read-only
 * tool running without a gate, a mutating tool opening one, and a mode excluding a
 * tool entirely — the three behaviors that are hard to believe from documentation.
 */
export function demoTools(): ToolDefinition[] {
  const notes = new Map<string, string>();

  return [
    {
      name: 'echo',
      description: 'Return the given text unchanged. Useful for checking the loop end to end.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo.' } },
        required: ['text'],
      },
      // Read-only and pre-approved, so it runs in `ask` with no gate. This is the
      // shape a host should copy for genuinely side-effect-free tools.
      mutates: false,
      approval: 'always_allow',
      handler: (args) => String(args.text ?? ''),
    },
    {
      name: 'list_notes',
      description: 'List the keys of notes stored in this demo process.',
      parameters: { type: 'object', properties: {} },
      mutates: false,
      approval: 'always_allow',
      handler: () => {
        const keys = [...notes.keys()];
        return keys.length === 0 ? 'No notes.' : keys.join('\n');
      },
    },
    {
      name: 'write_note',
      description: 'Store a note under a key, replacing any existing note with that key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['key', 'body'],
      },
      // Left to the defaults: `mutates` is true and approval is required. The demo
      // relies on that to open a gate, which is also why the defaults are the safe
      // ones rather than the convenient ones.
      handler: (args, ctx) => {
        const key = String(args.key ?? '');
        if (key === '') return 'A note needs a key.';

        notes.set(key, String(args.body ?? ''));
        return `Stored ${key} (session ${ctx.sessionId}).`;
      },
    },
    {
      name: 'delete_all_notes',
      description: 'Delete every stored note. Destructive.',
      parameters: { type: 'object', properties: {} },
      // Restricted to `agent` explicitly rather than relying on `mutates`: some
      // things should stay unavailable even in a mode that permits writes.
      modes: ['agent'],
      handler: () => {
        const count = notes.size;
        notes.clear();
        return `Deleted ${count} note(s).`;
      },
    },
  ];
}
