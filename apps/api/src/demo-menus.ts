import { type ContextMenuDefinition, commandsMenu, mentionsMenu } from '@evu/harness-core';
import type { ContextMenuNode } from '@evu/harness-protocol';

/**
 * Context menus for the demo.
 *
 * Three entries over one engine: `@` mentions, `/` commands, and a third trigger to
 * show that a host adds one by adding a catalog entry rather than by touching the
 * composer. The third one is the point of the whole design — if registering `#`
 * needed new UI code, the catalog would not be doing its job.
 */
export function demoMenus(): ContextMenuDefinition[] {
  return [
    mentionsMenu({
      icon: '@',
      sources: [
        // A static array, exercising group drill-in with nested children.
        [
          {
            kind: 'group',
            id: 'docs',
            label: 'Docs',
            icon: 'doc',
            children: [
              { kind: 'item', id: 'spec', label: 'SPEC.md', hint: 'Product specification' },
              { kind: 'item', id: 'agents', label: 'AGENTS.md', hint: 'Contributor guide' },
              { kind: 'item', id: 'security', label: 'SECURITY.md', hint: 'Security model' },
            ],
          },
          {
            kind: 'group',
            id: 'packages',
            label: 'Packages',
            icon: 'package',
            children: [
              { kind: 'item', id: 'protocol', label: '@evu/harness-protocol' },
              { kind: 'item', id: 'core', label: '@evu/harness-core' },
              { kind: 'item', id: 'server', label: '@evu/harness-server' },
              { kind: 'item', id: 'ui', label: '@evu/harness-ui' },
            ],
          },
        ] satisfies ContextMenuNode[],

        // A function source, showing that a level can be computed per query. A real
        // host would hit a database or a filesystem here.
        ({ query }) => {
          if (query === '') return [];
          return [
            {
              kind: 'item',
              id: `search:${query}`,
              label: `Search for "${query}"`,
              icon: 'search',
              hint: 'Computed source',
              payload: { query },
            },
          ];
        },
      ],
      resolve: async ({ ref }) => {
        // A mention that resolves to a context block rather than staying inline: the
        // model gets the content, and the message stays readable.
        if (ref.path[0] === 'docs') {
          return {
            effect: 'context',
            label: `doc:${ref.id}`,
            text: `[demo] Contents of ${ref.id} would be attached here.`,
          };
        }
        return { effect: 'text' };
      },
    }),

    commandsMenu({
      icon: '/',
      sources: [
        [
          {
            kind: 'item',
            id: 'review',
            label: 'review',
            hint: 'Review the current changes',
          },
          {
            kind: 'item',
            id: 'explain',
            label: 'explain',
            hint: 'Explain what is going on',
          },
          {
            kind: 'item',
            id: 'plan',
            label: 'plan',
            hint: 'Switch to plan mode and propose a plan',
          },
        ] satisfies ContextMenuNode[],
      ],
      resolve: async ({ ref, text }) => {
        if (ref.id === 'plan') {
          // A command that asks for a mode. It is still subject to pinning: the
          // request applies to this turn, and cannot retarget one already running.
          //
          // `token` is optional on a ref, so removing it from the text is
          // conditional; a client that sent no token leaves the message as typed.
          return {
            effect: 'command',
            mode: 'plan',
            replaceText: ref.token === undefined ? text : text.replace(ref.token, '').trim(),
            prompt: 'Propose a plan before making any changes.',
          };
        }

        return {
          effect: 'prompt',
          text: `The user invoked the ${ref.id} command.`,
        };
      },
    }),

    {
      // A third trigger, registered with no preset and no composer change.
      id: 'labels',
      trigger: '#',
      title: 'Labels',
      icon: '#',
      insert: 'chip',
      effect: 'text',
      emptyQueryBehavior: 'flat',
      searchScope: 'flat',
      source: [
        { kind: 'item', id: 'bug', label: 'bug' },
        { kind: 'item', id: 'chore', label: 'chore' },
        { kind: 'item', id: 'question', label: 'question' },
      ] satisfies ContextMenuNode[],
    },
  ];
}
