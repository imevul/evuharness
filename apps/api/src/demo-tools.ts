import type { ToolDefinition } from '@evu/harness-core';

export interface DemoToolsOptions {
  /**
   * Include the no-op `echo` tool. Only the in-process FakeProvider should see
   * it: a live model treats "repeat this text" as something to call.
   */
  includeEcho?: boolean;
}

/**
 * Tools for the demo, exercising the annotations the gates depend on.
 *
 * None of these belong to the library. They exist so the demo can show a read-only
 * tool running without a gate, a mutating tool opening one, and a mode excluding a
 * tool entirely — the three behaviors that are hard to believe from documentation.
 */
export function demoTools(options: DemoToolsOptions = {}): ToolDefinition[] {
  const notes = new Map<string, string>();

  const tools: ToolDefinition[] = [];

  if (options.includeEcho === true) {
    tools.push({
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
    });
  }

  tools.push(
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
    {
      name: 'ask_user',
      description:
        'Ask the person one or more structured questions and wait for their answer before continuing.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string' },
                choices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                    },
                    required: ['id', 'label'],
                  },
                },
                allowMultiple: { type: 'boolean' },
                allowFreeForm: { type: 'boolean' },
              },
              required: ['id', 'prompt'],
            },
          },
        },
        required: ['questions'],
      },
      // Runtime-owned gate tool: always allowlisted by mode policy, never causes
      // a side effect on its own. The turn loop intercepts the call and suspends.
      mutates: false,
      approval: 'always_allow',
      builtin: true,
      handler: () => 'ask_user is handled by the turn loop; this handler should not run.',
    },
  );

  return tools;
}
