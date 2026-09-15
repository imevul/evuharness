import { contextWindowFromCatalogEntry, resolveContextWindow } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

describe('contextWindowFromCatalogEntry', () => {
  it('reads LiteLLM max_input_tokens, including under model_info', () => {
    expect(contextWindowFromCatalogEntry({ id: 'gpt', max_input_tokens: 128_000 })).toBe(128_000);
    expect(
      contextWindowFromCatalogEntry({
        id: 'gpt',
        model_info: { max_input_tokens: 64_000 },
      }),
    ).toBe(64_000);
  });

  it('reads vLLM max_model_len', () => {
    expect(contextWindowFromCatalogEntry({ id: 'local', max_model_len: 32_768 })).toBe(32_768);
  });

  it('prefers llama.cpp meta.n_ctx over n_ctx_train', () => {
    expect(
      contextWindowFromCatalogEntry({
        id: 'gguf',
        meta: { n_ctx: 4_096, n_ctx_train: 32_768 },
      }),
    ).toBe(4_096);
  });

  it('reads llama.cpp router --ctx-size when meta.n_ctx is absent', () => {
    expect(
      contextWindowFromCatalogEntry({
        id: 'unloaded',
        status: { args: ['--ctx-size', '80000', '--parallel', '1'] },
      }),
    ).toBe(80_000);
    expect(
      contextWindowFromCatalogEntry({
        id: 'unloaded',
        status: { args: '-c 2048 --model foo.gguf' },
      }),
    ).toBe(2_048);
  });

  it('falls back to n_ctx_train only when no runtime value exists', () => {
    expect(
      contextWindowFromCatalogEntry({
        id: 'gguf',
        meta: { n_ctx_train: 16_384 },
      }),
    ).toBe(16_384);
  });

  it('ignores generation caps and LiteLLM legacy max_tokens', () => {
    expect(
      contextWindowFromCatalogEntry({
        id: 'gpt',
        max_output_tokens: 4_096,
        max_completion_tokens: 8_192,
        max_tokens: 16_384,
      }),
    ).toBeUndefined();
  });

  it('prefers max_model_len over max_input_tokens when both exist', () => {
    expect(
      contextWindowFromCatalogEntry({
        id: 'proxy',
        max_model_len: 8_192,
        max_input_tokens: 128_000,
      }),
    ).toBe(8_192);
  });

  it('reads welcome extras such as context_length', () => {
    expect(contextWindowFromCatalogEntry({ id: 'or', context_length: 200_000 })).toBe(200_000);
  });

  it('rejects non-positive, boolean, and NaN values', () => {
    expect(contextWindowFromCatalogEntry({ id: 'x', max_model_len: 0 })).toBeUndefined();
    expect(contextWindowFromCatalogEntry({ id: 'x', max_model_len: true })).toBeUndefined();
    expect(contextWindowFromCatalogEntry({ id: 'x', max_model_len: Number.NaN })).toBeUndefined();
  });
});

describe('resolveContextWindow', () => {
  it('uses the override for that model only', () => {
    const profile = {
      modelContextWindows: { a: 8_192, b: 4_096 },
      modelContextWindowOverrides: { a: 2_048 },
    };

    expect(resolveContextWindow(profile, 'a')).toBe(2_048);
    expect(resolveContextWindow(profile, 'b')).toBe(4_096);
    expect(resolveContextWindow(profile, 'c')).toBeUndefined();
  });
});
