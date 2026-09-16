import type { ChatMessage, ConnectionTestResult, ModelCatalogEntry } from '@evu/harness-protocol';
import { textFromMessageContent } from '@evu/harness-protocol';
import type { ProviderCompleteInput, ProviderEvent } from './openai-client.js';
import type { StoredProviderProfile } from './settings-store.js';

export type FakeProviderScript =
  | {
      events: ProviderEvent[];
      /** Pause before each event so a test can cancel mid-stream. */
      delayMs?: number;
      /** Thrown after the events, to simulate a provider dying mid-turn. */
      error?: Error;
    }
  | { error: Error }
  | { echo: true; delayMs?: number };

export interface ProviderAdapter {
  complete(
    profile: StoredProviderProfile,
    input: ProviderCompleteInput,
  ): AsyncIterable<ProviderEvent>;
  listModels?(profile: StoredProviderProfile, signal?: AbortSignal): Promise<ModelCatalogEntry[]>;
  testConnection?(profile: StoredProviderProfile): Promise<ConnectionTestResult>;
}

/**
 * Scripted provider for tests and for smoke that must not need a live model.
 *
 * Each `complete` call consumes the next script. When the scripts run out the
 * last one is reused, so a cap-nudge extra call can still get a text answer.
 */
export class FakeProvider implements ProviderAdapter {
  readonly calls: ProviderCompleteInput[] = [];
  private index = 0;

  constructor(private readonly scripts: FakeProviderScript[] = [{ echo: true }]) {}

  async listModels(profile: StoredProviderProfile): Promise<ModelCatalogEntry[]> {
    return [{ id: profile.model, contextWindow: 8_192 }];
  }

  async testConnection(profile: StoredProviderProfile): Promise<ConnectionTestResult> {
    return {
      ok: true,
      latencyMs: 1,
      model: profile.model,
      message: 'Fake provider',
    };
  }

  async *complete(
    _profile: StoredProviderProfile,
    input: ProviderCompleteInput,
  ): AsyncGenerator<ProviderEvent> {
    this.calls.push(input);
    const script = this.scripts[Math.min(this.index, this.scripts.length - 1)] ?? { echo: true };
    this.index += 1;

    if ('echo' in script) {
      if (script.delayMs !== undefined) {
        await delay(script.delayMs, input.signal);
      }
      yield* echoEvents(input.messages);
      return;
    }

    if (!('events' in script)) {
      throw script.error;
    }

    for (const event of script.events) {
      if (input.signal.aborted) {
        throw abortError();
      }
      if (script.delayMs !== undefined) {
        await delay(script.delayMs, input.signal);
      }
      yield event;
    }

    if (script.error !== undefined) {
      throw script.error;
    }
  }
}

function echoEvents(messages: ChatMessage[]): ProviderEvent[] {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const text = lastUser === undefined ? '' : textFromMessageContent(lastUser.content);
  return [
    { kind: 'delta', text },
    { kind: 'usage', promptTokens: Math.max(1, Math.ceil(text.length / 4)), completionTokens: 1 },
    { kind: 'message', message: { role: 'assistant', content: text } },
  ];
}

export function abortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('This operation was aborted', 'AbortError');
  }
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
