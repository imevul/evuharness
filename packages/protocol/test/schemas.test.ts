import {
  ApprovalDecisionSchema,
  ChatRequestSchema,
  ContextMenuDescriptorSchema,
  ContextMenuItemsResponseSchema,
  type ContextMenuNode,
  ContextMenuNodeSchema,
  GrantSchema,
  isBuiltinToolName,
  ROUTES,
  StreamEventSchema,
} from '@evu/harness-protocol';
import { describe, expect, it } from 'vitest';

describe('context menu nodes', () => {
  it('accepts a flat item list, as a command menu produces', () => {
    const nodes = [
      { kind: 'item', id: 'doctor', label: 'doctor', hint: 'Diagnose the stack' },
      { kind: 'item', id: 'tune', label: 'tune' },
    ];

    expect(ContextMenuNodeSchema.array().parse(nodes)).toHaveLength(2);
  });

  it('accepts groups, a lazy group, and a bare item at the same level', () => {
    const response = ContextMenuItemsResponseSchema.parse({
      menu: 'mentions',
      trigger: '@',
      nodes: [
        {
          kind: 'group',
          id: 'service',
          label: 'Services',
          icon: 'server',
          children: [{ kind: 'item', id: 'api', label: 'api' }],
        },
        { kind: 'group', id: 'file', label: 'Files', icon: 'file', lazy: true },
        { kind: 'item', id: 'host', label: 'This host', chip: { tone: 'accent' } },
      ],
    });

    expect(response.nodes).toHaveLength(3);
  });

  it('nests groups to arbitrary depth', () => {
    const deep: ContextMenuNode = {
      kind: 'group',
      id: 'a',
      label: 'a',
      children: [
        {
          kind: 'group',
          id: 'b',
          label: 'b',
          children: [
            {
              kind: 'group',
              id: 'c',
              label: 'c',
              children: [{ kind: 'item', id: 'leaf', label: 'leaf' }],
            },
          ],
        },
      ],
    };

    expect(() => ContextMenuNodeSchema.parse(deep)).not.toThrow();
  });

  it('allows chip: false so an item can insert plain text instead of a pill', () => {
    const parsed = ContextMenuNodeSchema.parse({
      kind: 'item',
      id: 'smile',
      label: 'smile',
      chip: false,
    });

    expect(parsed).toMatchObject({ chip: false });
  });

  it('allows a null chip icon to suppress inheritance', () => {
    const parsed = ContextMenuNodeSchema.parse({
      kind: 'item',
      id: 'plain',
      label: 'plain',
      chip: { icon: null },
    });

    expect(parsed).toMatchObject({ chip: { icon: null } });
  });

  it('rejects an unknown node kind', () => {
    expect(() => ContextMenuNodeSchema.parse({ kind: 'section', id: 'x', label: 'x' })).toThrow();
  });
});

describe('context menu descriptor defaults', () => {
  it('defaults insert, effect, and search behavior', () => {
    const descriptor = ContextMenuDescriptorSchema.parse({ id: 'corpora', trigger: '#' });

    expect(descriptor).toMatchObject({
      insert: 'chip',
      effect: 'text',
      emptyQueryBehavior: 'groups',
      searchScope: 'flat',
      minQueryLength: 0,
    });
  });
});

describe('chat request', () => {
  it('requires a mode, because a turn is always pinned to one', () => {
    expect(() => ChatRequestSchema.parse({ messages: [{ text: 'hi' }] })).toThrow();
  });

  it('accepts several queued messages, which a drained follow-up queue sends', () => {
    const request = ChatRequestSchema.parse({
      mode: 'agent',
      messages: [{ text: 'first' }, { text: 'second' }],
    });

    expect(request.messages).toHaveLength(2);
  });

  it('defaults refs to an empty array', () => {
    const request = ChatRequestSchema.parse({ mode: 'ask', messages: [{ text: 'hi' }] });
    expect(request.messages[0]?.refs).toEqual([]);
  });

  it('carries a per-turn provider override without touching session defaults', () => {
    const request = ChatRequestSchema.parse({
      mode: 'ask',
      messages: [{ text: 'hi' }],
      provider: { model: 'bigger-model', effort: 'high' },
    });

    expect(request.provider).toMatchObject({ model: 'bigger-model', effort: 'high' });
  });
});

describe('approval ladder', () => {
  it('covers all five decisions', () => {
    expect(ApprovalDecisionSchema.options).toEqual([
      'allow_once',
      'allow_session',
      'allow_workspace',
      'allow_always',
      'deny',
    ]);
  });

  it('allows a null scopeId only for global grants', () => {
    expect(() =>
      GrantSchema.parse({
        scope: 'global',
        scopeId: null,
        tool: 'write_file',
        createdAt: new Date().toISOString(),
      }),
    ).not.toThrow();
  });
});

describe('stream events', () => {
  it('parses the ask-user gate event', () => {
    const event = StreamEventSchema.parse({
      event: 'ask_user_required',
      sessionId: 's1',
      askId: 'a1',
      requestedAt: new Date().toISOString(),
      questions: [{ id: 'q1', prompt: 'Which one?' }],
    });

    expect(event.event).toBe('ask_user_required');
  });

  it('defaults a cancelled event to the operator reason', () => {
    const event = StreamEventSchema.parse({
      event: 'cancelled',
      sessionId: 's1',
      content: '',
      mode: 'ask',
      title: 'New chat',
    });

    expect(event).toMatchObject({ reason: 'operator', quiet: false });
  });

  it('accepts reasoning deltas, which only some providers emit', () => {
    expect(StreamEventSchema.parse({ event: 'reasoning_delta', text: 'hmm' })).toMatchObject({
      event: 'reasoning_delta',
    });
  });
});

describe('routes', () => {
  it('builds nested gate paths', () => {
    expect(ROUTES.toolApproval('s1', 'a1')).toBe('/sessions/s1/tool-approvals/a1');
    expect(ROUTES.askUser('s1', 'q1')).toBe('/sessions/s1/ask-user/q1');
    expect(ROUTES.contextMenuItems('mentions')).toBe('/context-menus/mentions/items');
  });
});

describe('builtin tools', () => {
  it.each(['request_mode_switch', 'propose_plan', 'ask_user', 'load_skill'])(
    'recognizes %s as runtime-owned',
    (name) => {
      expect(isBuiltinToolName(name)).toBe(true);
    },
  );

  it('does not claim a host tool', () => {
    expect(isBuiltinToolName('restart_service')).toBe(false);
  });
});
