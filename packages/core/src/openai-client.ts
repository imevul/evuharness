import type {
  ChatMessage,
  ConnectionTestResult,
  ModelCatalogEntry,
  ReasoningEffort,
  ToolSpec,
} from '@evu/harness-protocol';
import { catalogEntriesFromList } from './model-catalog.js';
import type { StoredProviderProfile } from './settings-store.js';

export interface OpenAIClientOptions {
  fetch?: typeof globalThis.fetch;
}

export interface ProviderCompleteInput {
  messages: ChatMessage[];
  tools: ToolSpec[];
  model: string;
  signal: AbortSignal;
  effort?: ReasoningEffort | undefined;
  timeoutMs?: number | undefined;
}

export type ProviderEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'usage'; promptTokens: number; completionTokens: number }
  | { kind: 'message'; message: ChatMessage };

/**
 * Normalize an OpenAI-compatible base URL to the root that already includes `/v1`
 * when the host sent it, and does not double it when they did not.
 *
 * Profiles store whatever the user typed. Concatenating `/v1/models` onto a URL
 * that already ends in `/v1` is the usual first-connection failure.
 */
export function providerApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function headers(profile: StoredProviderProfile): HeadersInit {
  const extra: Record<string, string> = { 'content-type': 'application/json' };
  if (profile.apiKey !== undefined && profile.apiKey !== '') {
    extra.authorization = `Bearer ${profile.apiKey}`;
  }
  return extra;
}

function redact(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === '') return text;
  return text.includes(apiKey) ? text.split(apiKey).join('[redacted]') : text;
}

async function readError(response: Response, apiKey: string | undefined): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error?.message ?? `${response.status} ${response.statusText}`);
    return redact(message, apiKey);
  } catch {
    return redact(body.slice(0, 200) || `${response.status} ${response.statusText}`, apiKey);
  }
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    const toolCalls = message.toolCalls?.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));

    return {
      role: message.role,
      content: message.content,
      ...(message.name === undefined ? {} : { name: message.name }),
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  });
}

function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * OpenAI-compatible HTTP helper.
 *
 * One client for catalog, connection test, and (later) the streamed completion.
 * A second HTTP stack would drift on auth, base-URL joining, and redaction.
 */
export class OpenAICompatibleClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenAIClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listModels(
    profile: StoredProviderProfile,
    signal?: AbortSignal,
  ): Promise<ModelCatalogEntry[]> {
    const response = await this.fetchImpl(`${providerApiRoot(profile.baseUrl)}/models`, {
      headers: headers(profile),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(await readError(response, profile.apiKey));
    }

    const body = (await response.json()) as { data?: unknown };
    return catalogEntriesFromList(body.data);
  }

  /**
   * Prove the profile works.
   *
   * Prefers `GET /models` because it is cheap and does not spend a completion.
   * Falls back to a one-token chat when the catalog is unimplemented, which is
   * common on small local servers.
   */
  async testConnection(profile: StoredProviderProfile): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const models = await this.listModels(profile);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        model: models.some((entry) => entry.id === profile.model)
          ? profile.model
          : (models[0]?.id ?? profile.model),
        message:
          models.length === 0 ? 'Connected (empty model list)' : `Listed ${models.length} models`,
      };
    } catch {
      try {
        const response = await this.fetchImpl(
          `${providerApiRoot(profile.baseUrl)}/chat/completions`,
          {
            method: 'POST',
            headers: headers(profile),
            body: JSON.stringify({
              model: profile.model,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            }),
          },
        );
        if (!response.ok) {
          return {
            ok: false,
            message: await readError(response, profile.apiKey),
          };
        }
        return {
          ok: true,
          latencyMs: Date.now() - started,
          model: profile.model,
          message: 'Connected via chat completion fallback',
        };
      } catch (chatError) {
        return {
          ok: false,
          message: redact(
            chatError instanceof Error ? chatError.message : String(chatError),
            profile.apiKey,
          ),
        };
      }
    }
  }

  async *complete(
    profile: StoredProviderProfile,
    input: ProviderCompleteInput,
  ): AsyncGenerator<ProviderEvent> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal.addEventListener('abort', onAbort, { once: true });

    const timeout =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `${providerApiRoot(profile.baseUrl)}/chat/completions`,
        {
          method: 'POST',
          headers: { ...headers(profile), accept: 'text/event-stream' },
          body: JSON.stringify({
            model: input.model,
            messages: toOpenAIMessages(input.messages),
            stream: true,
            stream_options: { include_usage: true },
            ...(input.tools.length === 0 ? {} : { tools: toOpenAITools(input.tools) }),
            ...(input.effort === undefined ? {} : { reasoning_effort: input.effort }),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(await readError(response, profile.apiKey));
      }
      if (response.body === null) {
        throw new Error('empty_stream');
      }

      yield* parseCompletionStream(response.body);
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

async function* parseCompletionStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ProviderEvent> {
  const reader = body.getReader();
  const utf8 = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = new Map<number, ToolCallAcc>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += utf8.decode(value, { stream: true });

      for (;;) {
        const separator = buffer.indexOf('\n\n');
        if (separator < 0) break;
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const raw = trimmed.slice('data:'.length).trim();
          if (raw === '' || raw === '[DONE]') continue;

          let payload: {
            choices?: {
              delta?: {
                content?: string | null;
                reasoning_content?: string | null;
                tool_calls?: {
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
            }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            payload = JSON.parse(raw) as typeof payload;
          } catch {
            continue;
          }

          const delta = payload.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            yield { kind: 'delta', text: delta.content };
          }
          if (delta?.reasoning_content) {
            yield { kind: 'reasoning_delta', text: delta.reasoning_content };
          }
          for (const call of delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            const acc = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (call.id !== undefined) acc.id = call.id;
            if (call.function?.name !== undefined) acc.name += call.function.name;
            if (call.function?.arguments !== undefined) acc.arguments += call.function.arguments;
            toolCalls.set(index, acc);
          }
          if (payload.usage !== undefined) {
            yield {
              kind: 'usage',
              promptTokens: payload.usage.prompt_tokens ?? 0,
              completionTokens: payload.usage.completion_tokens ?? 0,
            };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const calls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      let parsed: Record<string, unknown> = {};
      try {
        const value = JSON.parse(call.arguments || '{}') as unknown;
        parsed =
          value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
      } catch {
        parsed = {};
      }
      return { id: call.id || call.name, name: call.name, arguments: parsed };
    });

  yield {
    kind: 'message',
    message: {
      role: 'assistant',
      content,
      ...(calls.length === 0 ? {} : { toolCalls: calls }),
    },
  };
}
