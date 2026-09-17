import {
  ApprovalDecisionSchema,
  attachmentToken,
  ChatMessageSchema,
  ChatRequestSchema,
  ContextMenuDescriptorSchema,
  ContextMenuItemsResponseSchema,
  type ContextMenuNode,
  ContextMenuNodeSchema,
  GrantSchema,
  HarnessSettingsUpdateSchema,
  isAllowedAttachmentUrl,
  isBuiltinToolName,
  ProviderProfileSchema,
  ProviderProfileWriteSchema,
  ROUTES,
  SetProviderRequestSchema,
  StatusResponseSchema,
  StreamEventSchema,
  textFromMessageContent,
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

  it('defaults attachments to an empty array', () => {
    const request = ChatRequestSchema.parse({ mode: 'ask', messages: [{ text: 'hi' }] });
    expect(request.messages[0]?.attachments).toEqual([]);
  });

  it('accepts structured image and file attachments on a user turn', () => {
    const request = ChatRequestSchema.parse({
      mode: 'ask',
      messages: [
        {
          text: 'see [image:shot.png]',
          attachments: [
            {
              id: 'a1',
              kind: 'image',
              name: 'shot.png',
              mimeType: 'image/png',
              url: 'data:image/png;base64,abc',
              size: 12,
            },
            {
              id: 'a2',
              kind: 'file',
              name: 'notes.txt',
              mimeType: 'text/plain',
              text: 'hello',
            },
          ],
        },
      ],
    });
    expect(request.messages[0]?.attachments).toHaveLength(2);
  });

  it('carries a per-turn provider override without touching session defaults', () => {
    const request = ChatRequestSchema.parse({
      mode: 'ask',
      messages: [{ text: 'hi' }],
      provider: { model: 'bigger-model', effort: 'high' },
    });

    expect(request.provider).toMatchObject({ model: 'bigger-model', effort: 'high' });
  });

  it('accepts a set-provider body that clears the session preference', () => {
    expect(SetProviderRequestSchema.parse({ provider: null })).toEqual({ provider: null });
    expect(
      SetProviderRequestSchema.parse({ provider: { providerId: 'local', effort: 'high' } }),
    ).toMatchObject({ provider: { providerId: 'local', effort: 'high' } });
  });
});

describe('chat message tool calls', () => {
  it('round-trips an assistant tool call the provider will see', () => {
    const parsed = ChatMessageSchema.parse({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }],
    });

    expect(parsed.toolCalls).toEqual([{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }]);
  });
});

describe('provider write shape', () => {
  it('accepts a write-only apiKey that the read shape cannot express', () => {
    const written = ProviderProfileWriteSchema.parse({
      id: 'local',
      baseUrl: 'https://example.test/v1',
      model: 'm',
      apiKey: 'secret',
    });

    expect(written.apiKey).toBe('secret');
    expect(ProviderProfileSchema.parse({ ...written, hasApiKey: true })).not.toHaveProperty(
      'apiKey',
    );
  });

  it('treats a null apiKey as an explicit clear, distinct from omit', () => {
    const cleared = ProviderProfileWriteSchema.parse({
      id: 'local',
      baseUrl: 'https://example.test/v1',
      model: 'm',
      apiKey: null,
    });
    const omitted = ProviderProfileWriteSchema.parse({
      id: 'local',
      baseUrl: 'https://example.test/v1',
      model: 'm',
    });

    expect(cleared.apiKey).toBeNull();
    expect(omitted.apiKey).toBeUndefined();
  });

  it('accepts per-model context windows and a nullable write override', () => {
    const profile = ProviderProfileSchema.parse({
      id: 'local',
      baseUrl: 'https://example.test/v1',
      model: 'big',
      modelContextWindows: { big: 32_768, small: 4_096 },
      modelContextWindowOverrides: { big: 16_384 },
    });

    expect(profile.active).toBe(true);
    expect(profile.modelContextWindows.big).toBe(32_768);
    expect(
      ProviderProfileWriteSchema.parse({
        id: 'local',
        baseUrl: 'https://example.test/v1',
        model: 'big',
        modelContextWindowOverrides: { big: null },
      }).modelContextWindowOverrides,
    ).toEqual({ big: null });
  });

  it('upserts providers without requiring a full replace', () => {
    const update = HarnessSettingsUpdateSchema.parse({
      providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'm' }],
      removeProviderIds: ['old'],
    });

    expect(update.providers).toHaveLength(1);
    expect(update.removeProviderIds).toEqual(['old']);
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

  it('parses the plan-approval gate event', () => {
    const event = StreamEventSchema.parse({
      event: 'plan_approval_required',
      sessionId: 's1',
      planId: 'p1',
      title: 'Restart',
      steps: [{ summary: 'check status' }],
      proposedAt: new Date().toISOString(),
    });

    expect(event.event).toBe('plan_approval_required');
  });

  it('parses the mode-switch gate event', () => {
    const event = StreamEventSchema.parse({
      event: 'mode_switch_required',
      sessionId: 's1',
      requestId: 'm1',
      from: 'ask',
      to: 'agent',
      reason: 'need writes',
      requestedAt: new Date().toISOString(),
    });

    expect(event.event).toBe('mode_switch_required');
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

  it('accepts optional reasoning on terminal events without folding it into content', () => {
    const done = StreamEventSchema.parse({
      event: 'done',
      sessionId: 's1',
      content: 'answer',
      reasoning: 'thoughts',
      mode: 'ask',
      title: 'Chat',
    });
    const cancelled = StreamEventSchema.parse({
      event: 'cancelled',
      sessionId: 's1',
      content: '',
      reasoning: 'partial thoughts',
      mode: 'ask',
      title: 'Chat',
    });

    expect(done).toMatchObject({ content: 'answer', reasoning: 'thoughts' });
    expect(cancelled).toMatchObject({ content: '', reasoning: 'partial thoughts' });
  });
});

describe('status snapshot', () => {
  it('carries a resolved activeProvider window', () => {
    const status = StatusResponseSchema.parse({
      ready: true,
      modes: ['ask'],
      activeProviderId: 'local',
      activeProvider: { id: 'local', model: 'm', contextWindow: 8_192 },
      providerConfigured: true,
      toolCount: 0,
      contextMenuCount: 0,
    });

    expect(status.activeProvider).toMatchObject({ model: 'm', contextWindow: 8_192 });
  });
});

describe('routes', () => {
  it('builds nested gate paths', () => {
    expect(ROUTES.toolApproval('s1', 'a1')).toBe('/sessions/s1/tool-approvals/a1');
    expect(ROUTES.askUser('s1', 'q1')).toBe('/sessions/s1/ask-user/q1');
    expect(ROUTES.contextMenuItems('mentions')).toBe('/context-menus/mentions/items');
    expect(ROUTES.memoryUser).toBe('/memory/user');
    expect(ROUTES.memory('m1')).toBe('/memory/m1');
    expect(ROUTES.compactionReset('s1')).toBe('/sessions/s1/compaction/reset');
    expect(ROUTES.mcpHealth('m1')).toBe('/mcp/m1/test');
  });
});

describe('builtin tools', () => {
  it.each(['request_mode_switch', 'propose_plan', 'ask_user', 'load_skill', 'report_progress'])(
    'recognizes %s as runtime-owned',
    (name) => {
      expect(isBuiltinToolName(name)).toBe(true);
    },
  );

  it('does not claim a host tool', () => {
    expect(isBuiltinToolName('restart_service')).toBe(false);
  });
});

describe('attachment helpers', () => {
  it('allowlists https and raster data URLs only', () => {
    expect(isAllowedAttachmentUrl('https://cdn.example/a.png')).toBe(true);
    expect(isAllowedAttachmentUrl('data:image/png;base64,abc')).toBe(true);
    expect(isAllowedAttachmentUrl('http://cdn.example/a.png')).toBe(false);
    expect(isAllowedAttachmentUrl('data:text/plain;base64,abc')).toBe(false);
  });

  it('builds stable chip tokens from kind and name', () => {
    expect(attachmentToken('image', 'shot.png')).toBe('[image:shot.png]');
    expect(attachmentToken('file', 'notes[1].txt')).toBe('[file:notes_1_.txt]');
  });

  it('accepts multimodal user content with an allowlisted image part', () => {
    const parsed = ChatMessageSchema.parse({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/a.png' } },
      ],
    });
    expect(textFromMessageContent(parsed.content)).toBe('what is this?');
  });
});
