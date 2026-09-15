import { OpenAICompatibleClient, providerApiRoot } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';
import type { StoredProviderProfile } from '../src/settings-store.js';

const PROFILE: StoredProviderProfile = {
  id: 'local',
  baseUrl: 'https://example.test/v1',
  model: 'm',
  apiKey: 'super-secret',
  models: [],
  supportsEffort: false,
  supportsReasoning: false,
  timeoutMs: 5_000,
  modelContextWindows: {},
  modelContextWindowOverrides: {},
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('providerApiRoot', () => {
  it('does not double /v1 when the profile already has it', () => {
    expect(providerApiRoot('https://example.test/v1')).toBe('https://example.test/v1');
    expect(providerApiRoot('https://example.test/v1/')).toBe('https://example.test/v1');
  });

  it('adds /v1 when the host omitted it', () => {
    expect(providerApiRoot('https://example.test')).toBe('https://example.test/v1');
  });
});

describe('OpenAICompatibleClient', () => {
  it('lists models from GET /models', async () => {
    const client = new OpenAICompatibleClient({
      fetch: async (input) => {
        expect(String(input)).toBe('https://example.test/v1/models');
        return jsonResponse(200, { data: [{ id: 'alpha' }, { id: 'beta' }] });
      },
    });

    await expect(client.listModels(PROFILE)).resolves.toEqual([{ id: 'alpha' }, { id: 'beta' }]);
  });

  it('parses LiteLLM, llama.cpp, and vLLM context fields on catalog cards', async () => {
    const client = new OpenAICompatibleClient({
      fetch: async () =>
        jsonResponse(200, {
          data: [
            { id: 'litellm', max_input_tokens: 128_000, max_output_tokens: 4_096 },
            { id: 'llamacpp', meta: { n_ctx: 4_096, n_ctx_train: 32_768 } },
            { id: 'vllm', max_model_len: 16_384 },
          ],
        }),
    });

    await expect(client.listModels(PROFILE)).resolves.toEqual([
      { id: 'litellm', contextWindow: 128_000 },
      { id: 'llamacpp', contextWindow: 4_096 },
      { id: 'vllm', contextWindow: 16_384 },
    ]);
  });

  it('tests a connection from the catalog and never echoes the key', async () => {
    const client = new OpenAICompatibleClient({
      fetch: async () => jsonResponse(200, { data: [{ id: 'm' }] }),
    });

    const result = await client.testConnection(PROFILE);

    expect(result.ok).toBe(true);
    expect(result.model).toBe('m');
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('falls back to a one-token chat when the catalog is unimplemented', async () => {
    const client = new OpenAICompatibleClient({
      fetch: async (input, init) => {
        if (String(input).endsWith('/models')) {
          return jsonResponse(404, { error: { message: 'no catalog' } });
        }
        expect(init?.method).toBe('POST');
        return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
      },
    });

    const result = await client.testConnection(PROFILE);
    expect(result).toMatchObject({ ok: true, model: 'm' });
    expect(result.message).toMatch(/fallback/i);
  });

  it('returns ok:false with a redacted message when both paths fail', async () => {
    const client = new OpenAICompatibleClient({
      fetch: async () => jsonResponse(401, { error: { message: 'bad key super-secret' } }),
    });

    const result = await client.testConnection(PROFILE);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('[redacted]');
    expect(result.message).not.toContain('super-secret');
  });

  it('streams complete() into provider events', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}\n\n',
      'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ];
    const client = new OpenAICompatibleClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              for (const frame of frames) {
                controller.enqueue(encoder.encode(frame));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    });

    const events = [];
    for await (const event of client.complete(PROFILE, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      model: 'm',
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'usage', promptTokens: 4, completionTokens: 2 },
      {
        kind: 'message',
        message: {
          role: 'assistant',
          content: 'Hello',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }],
        },
      },
    ]);
  });
});
