import { FakeProvider, createHarness, sanitizeAttachments, buildUserMessageContent } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

describe('sanitizeAttachments', () => {
  it('drops everything when the feature is disabled', () => {
    expect(
      sanitizeAttachments(
        [
          {
            id: 'a1',
            kind: 'image',
            name: 'x.png',
            mimeType: 'image/png',
            url: 'data:image/png;base64,abc',
          },
        ],
        false,
      ),
    ).toEqual([]);
  });

  it('rejects non-allowlisted image URLs', () => {
    expect(
      sanitizeAttachments(
        [
          {
            id: 'a1',
            kind: 'image',
            name: 'x.png',
            mimeType: 'image/png',
            url: 'http://evil.example/x.png',
          },
        ],
        true,
      ),
    ).toEqual([]);
  });
});

describe('buildUserMessageContent', () => {
  it('emits OpenAI-compatible image_url parts for allowlisted images', () => {
    const content = buildUserMessageContent('look', [
      {
        id: 'a1',
        kind: 'image',
        name: 'shot.png',
        mimeType: 'image/png',
        url: 'data:image/png;base64,abc',
      },
    ]);
    expect(content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ]);
  });

  it('wraps file text as untrusted data in the text body', () => {
    const content = buildUserMessageContent('read this', [
      {
        id: 'a2',
        kind: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        text: 'secret sauce',
      },
    ]);
    expect(typeof content).toBe('string');
    expect(content).toContain('UNTRUSTED TOOL RESULT');
    expect(content).toContain('secret sauce');
    expect(content).toContain('attachment:notes.txt');
  });
});

describe('attachments through the turn loop', () => {
  it('forwards multimodal content to the provider when enabled', async () => {
    const provider = new FakeProvider([{ echo: true }]);
    const harness = createHarness({
      provider,
      features: { attachments: true },
    });
    const session = await harness.createSession({ mode: 'ask' });
    const events = [];
    for await (const event of harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [
        {
          text: 'what is [image:shot.png]',
          attachments: [
            {
              id: 'a1',
              kind: 'image',
              name: 'shot.png',
              mimeType: 'image/png',
              url: 'data:image/png;base64,abc',
            },
          ],
        },
      ],
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ event: 'done' });
    const user = provider.calls[0]?.messages.find((message) => message.role === 'user');
    expect(user?.content).toEqual([
      { type: 'text', text: 'what is [image:shot.png]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ]);
    const detail = await harness.getSession(session.id);
    expect(detail?.transcript[0]?.attachments?.[0]).toMatchObject({
      kind: 'image',
      name: 'shot.png',
    });
    // data URLs are stripped from the transcript echo
    expect(detail?.transcript[0]?.attachments?.[0]?.url).toBeUndefined();
  });

  it('ignores attachments when the feature flag is off', async () => {
    const provider = new FakeProvider([{ echo: true }]);
    const harness = createHarness({
      provider,
      features: { attachments: false },
    });
    const session = await harness.createSession({ mode: 'ask' });
    for await (const _ of harness.runTurn({
      sessionId: session.id,
      mode: 'ask',
      messages: [
        {
          text: 'hi',
          attachments: [
            {
              id: 'a1',
              kind: 'image',
              name: 'shot.png',
              mimeType: 'image/png',
              url: 'data:image/png;base64,abc',
            },
          ],
        },
      ],
    })) {
      // drain
    }
    const user = provider.calls[0]?.messages.find((message) => message.role === 'user');
    expect(user?.content).toBe('hi');
  });
});
