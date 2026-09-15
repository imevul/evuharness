import type { ModelCatalogEntry } from '@evu/harness-protocol';

const RUNTIME_KEYS = [
  'n_ctx',
  'max_model_len',
  'max_input_tokens',
  'context_length',
  'context_window',
  'max_context_length',
  'max_context',
  'max_seq_len',
] as const;

/**
 * Read a context window from one `/v1/models` card.
 *
 * Hosts disagree on the field name. Prefer the runtime window over a training
 * ceiling, and never treat a generation cap (`max_output_tokens`,
 * `max_completion_tokens`, or LiteLLM's ambiguous `max_tokens`) as the window.
 */
export function contextWindowFromCatalogEntry(entry: unknown): number | undefined {
  if (!isRecord(entry)) return undefined;

  for (const key of RUNTIME_KEYS) {
    const preferMeta = key === 'n_ctx';
    const value = lookupLayers(entry, key, preferMeta);
    if (value !== undefined) return value;
  }

  const fromArgs = parseCtxSizeArgs(entry.status);
  if (fromArgs !== undefined) return fromArgs;

  return lookupLayers(entry, 'n_ctx_train', true);
}

export function catalogEntriesFromList(data: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(data)) return [];
  const entries: ModelCatalogEntry[] = [];
  for (const item of data) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue;
    const contextWindow = contextWindowFromCatalogEntry(item);
    entries.push(contextWindow === undefined ? { id: item.id } : { id: item.id, contextWindow });
  }
  return entries;
}

export function resolveContextWindow(
  profile: {
    modelContextWindows?: Record<string, number>;
    modelContextWindowOverrides?: Record<string, number>;
  },
  model: string,
): number | undefined {
  return profile.modelContextWindowOverrides?.[model] ?? profile.modelContextWindows?.[model];
}

export function compactOverrideMap(input: Record<string, number | null>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [id, value] of Object.entries(input)) {
    if (value !== null) next[id] = value;
  }
  return next;
}

function lookupLayers(
  entry: Record<string, unknown>,
  key: string,
  preferMeta: boolean,
): number | undefined {
  const layers = preferMeta
    ? [asRecord(entry.meta), entry, asRecord(entry.model_info), asRecord(entry.metadata)]
    : [entry, asRecord(entry.meta), asRecord(entry.model_info), asRecord(entry.metadata)];

  for (const layer of layers) {
    if (layer === undefined) continue;
    const value = readPositiveInt(layer[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseCtxSizeArgs(status: unknown): number | undefined {
  if (!isRecord(status)) return undefined;
  const raw = status.args;
  const args = Array.isArray(raw)
    ? raw.map((item) => (typeof item === 'string' ? item : String(item)))
    : typeof raw === 'string'
      ? raw.split(/\s+/)
      : [];

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--ctx-size' && flag !== '-c') continue;
    const value = readPositiveInt(args[index + 1]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'boolean') return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
