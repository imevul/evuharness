import { encodeSseEvent, type StreamEvent } from '@evu/harness-protocol';
import { HarnessClient, HarnessRequestError } from '@evu/harness-ui';
import { describe, expect, it, vi } from 'vitest';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch stub that records how it was called.
 *
 * The client's job is almost entirely URL and header construction, so that is what
 * these tests assert. A client/server URL mismatch is invisible to a typechecker and
 * shows up as a 404 at runtime, which is the failure this file is here to catch.
 */
function stubFetch(response: () => Response) {
  const calls: Call[] = [];

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return response();
  });

  return { calls, impl: impl as unknown as typeof globalThis.fetch };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('HarnessClient', () => {
  it('strips a trailing slash from the base url', async () => {
    const { calls, impl } = stubFetch(() => ok({ status: 'ok' }));
    const client = new HarnessClient({ baseUrl: 'http://host/api/', fetch: impl });

    await client.health();

    // Without normalization this is `http://host/api//health`, which some proxies
    // route and others reject.
    expect(calls[0]?.url).toBe('http://host/api/health');
  });

  it('previews prompts with a GET and query parameters', async () => {
    const { calls, impl } = stubFetch(() => ok({ mode: 'plan', sections: [], text: '' }));
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    await client.previewPrompt({ mode: 'plan', workspaceId: 'w1', sessionId: 's1' });

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('/api/prompt/preview?mode=plan&workspaceId=w1&sessionId=s1');
    expect(calls[0]?.body).toBeUndefined();
  });

  it('omits absent query parameters rather than sending empty ones', async () => {
    const { calls, impl } = stubFetch(() => ok({ sessions: [] }));
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    await client.listSessions();
    expect(calls[0]?.url).toBe('/api/sessions');

    await client.listSessions({ workspaceId: 'w1', limit: 10 });
    expect(calls[1]?.url).toBe('/api/sessions?workspaceId=w1&limit=10');
  });

  it('resolves headers per request so a rotating token is picked up', async () => {
    const { calls, impl } = stubFetch(() => ok({ status: 'ok' }));
    let token = 'first';
    const client = new HarnessClient({
      baseUrl: '/api',
      fetch: impl,
      headers: () => ({ authorization: `Bearer ${token}` }),
    });

    await client.health();
    token = 'second';
    await client.health();

    expect(calls[0]?.headers.authorization).toBe('Bearer first');
    expect(calls[1]?.headers.authorization).toBe('Bearer second');
  });

  it('sends a json content type only when there is a body', async () => {
    const { calls, impl } = stubFetch(() => ok({}));
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    await client.health();
    await client.createSession({ mode: 'agent' });

    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(calls[1]?.headers['content-type']).toBe('application/json');
  });

  it('treats 204 as an empty result rather than failing to parse', async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    await expect(client.deleteSession('s1')).resolves.toBeUndefined();
  });

  it('raises the server error code and detail', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'not_implemented', detail: 'later' }), {
          status: 501,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    await expect(client.status()).rejects.toMatchObject({
      name: 'HarnessRequestError',
      status: 501,
      code: 'not_implemented',
    });
  });

  it('still raises when a gateway responds without the json error shape', async () => {
    const { impl } = stubFetch(
      () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    // A proxy failure must not surface as a JSON parse error, which would send a
    // reader looking in the wrong place.
    await expect(client.status()).rejects.toBeInstanceOf(HarnessRequestError);
  });

  it('decodes a chat stream into events', async () => {
    const events: StreamEvent[] = [
      { event: 'status', sessionId: 's1', phase: 'started' },
      { event: 'delta', text: 'Hello' },
      {
        event: 'done',
        sessionId: 's1',
        content: 'Hello',
        mode: 'agent',
        title: 'Hi',
        tools: [],
        pendingToolApprovals: [],
        pendingPlan: null,
        pendingModeSwitch: null,
        pendingAskUser: null,
        promptTokensTotal: 1,
        completionTokensTotal: 1,
      },
    ];

    const { calls, impl } = stubFetch(
      () =>
        new Response(events.map(encodeSseEvent).join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    const received: StreamEvent[] = [];
    for await (const event of client.chat({
      mode: 'agent',
      messages: [{ text: 'hi', refs: [] }],
    })) {
      received.push(event);
    }

    expect(calls[0]?.headers.accept).toBe('text/event-stream');
    expect(received).toEqual(events);
  });

  it('reassembles an event split across network chunks', async () => {
    const encoded = encodeSseEvent({ event: 'delta', text: 'chunked' });
    const split = Math.floor(encoded.length / 2);
    const utf8 = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8.encode(encoded.slice(0, split)));
        controller.enqueue(utf8.encode(encoded.slice(split)));
        controller.close();
      },
    });

    const { impl } = stubFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    const received: StreamEvent[] = [];
    for await (const event of client.chat({
      mode: 'agent',
      messages: [{ text: 'hi', refs: [] }],
    })) {
      received.push(event);
    }

    // A frame arriving in two pieces must not produce two half events, nor drop one.
    expect(received).toEqual([{ event: 'delta', text: 'chunked' }]);
  });

  it('raises the server error instead of yielding when a turn is rejected', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new HarnessClient({ baseUrl: '/api', fetch: impl });

    const iterate = async () => {
      for await (const _event of client.chat({
        mode: 'agent',
        messages: [{ text: 'hi', refs: [] }],
      })) {
        // The generator should throw before producing anything.
      }
    };

    await expect(iterate()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});
