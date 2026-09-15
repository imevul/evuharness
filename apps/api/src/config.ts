/**
 * Demo configuration from the environment.
 *
 * Kept apart from composition so `main.ts` reads as "what this process is" rather
 * than as environment parsing. Nothing here is part of the library: a host supplies
 * its own configuration and calls `createHarness` directly.
 */

export interface DemoConfig {
  host: string;
  port: number;
  /** SQLite file. `:memory:` keeps a throwaway run from leaving a file behind. */
  databasePath: string;
  /**
   * Shared token for the demo's auth hook. Unset means the demo is open.
   *
   * Deliberately not defaulted to a value: a hardcoded default token is worse than
   * no auth, because it looks like protection.
   */
  token: string | undefined;
  /** Origin allowed by CORS. Unset means same-origin only, with no CORS at all. */
  webOrigin: string | undefined;
  provider: {
    baseUrl: string;
    model: string;
    apiKey: string | undefined;
  };
}

function requiredNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a port number, got: ${raw}`);
  }
  return parsed;
}

function optional(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

export function loadConfig(): DemoConfig {
  return {
    host: optional('EVUHARNESS_HOST') ?? '127.0.0.1',
    port: requiredNumber('EVUHARNESS_API_PORT', 4301),
    // Defaults to a file next to the repo rather than `/data`, which only exists in
    // the container. Running the API directly should not need a root-owned path.
    databasePath: optional('EVUHARNESS_STORE_PATH') ?? '.data/harness.sqlite',
    token: optional('EVUHARNESS_DEV_TOKEN'),
    webOrigin: optional('EVUHARNESS_WEB_ORIGIN'),
    provider: {
      baseUrl: optional('EVUHARNESS_PROVIDER_BASE_URL') ?? 'http://127.0.0.1:8080/v1',
      model: optional('EVUHARNESS_PROVIDER_MODEL') ?? 'local-model',
      apiKey: optional('EVUHARNESS_PROVIDER_API_KEY'),
    },
  };
}
