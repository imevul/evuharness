import {
  type ContextMenuDefinition,
  type SkillCatalog,
  commandsMenu,
  mentionsMenu,
  skillsMenu,
} from '@evu/harness-core';
import type { ContextMenuNode } from '@evu/harness-protocol';

const COMMAND_NODES = [
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
] satisfies ContextMenuNode[];

/**
 * Context menus for the demo.
 *
 * Three entries over one engine: `@` mentions, `/` commands (plus skills when a
 * catalog is provided), and a third trigger to show that a host adds one by
 * adding a catalog entry rather than by touching the composer.
 */
export function demoMenus(skills?: SkillCatalog): ContextMenuDefinition[] {
  const commands =
    skills === undefined
      ? commandsMenu({
          icon: '/',
          sources: [COMMAND_NODES],
          resolve: resolveDemoCommand,
        })
      : skillsMenu({
          catalog: skills,
          icon: '/',
          sources: [COMMAND_NODES],
          resolveOther: resolveDemoCommand,
        });

  return [
    mentionsMenu({
      icon: '@',
      sources: [
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

    commands,

    {
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

async function resolveDemoCommand({
  ref,
  text,
}: {
  ref: { id: string; token?: string | undefined };
  text: string;
}) {
  if (ref.id === 'plan') {
    return {
      effect: 'command' as const,
      mode: 'plan' as const,
      replaceText: ref.token === undefined ? text : text.replace(ref.token, '').trim(),
      prompt: 'Propose a plan before making any changes.',
    };
  }

  return {
    effect: 'prompt' as const,
    text: `The user invoked the ${ref.id} command.`,
  };
}
