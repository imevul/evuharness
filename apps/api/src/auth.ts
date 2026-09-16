import { timingSafeEqual } from 'node:crypto';
import { type AuthHooks, actorHasCapability, CAPABILITY_WILDCARD } from '@evu/harness-server';

export interface DemoAuthOptions {
  /**
   * Process environment name. Shared-token mode is refused when this is
   * `'production'`, so a production image cannot enable it by setting
   * `EVUHARNESS_DEV_TOKEN`.
   *
   * Defaults to `process.env.NODE_ENV`. Tests pass an explicit value.
   */
  nodeEnv?: string | undefined;
}

/**
 * A shared-token auth hook for the demo.
 *
 * Not a pattern to copy for anything real: one token means one identity, so there
 * is nothing to audit and nothing to revoke individually. It exists to show where a
 * host plugs in, and to keep the demo from being wide open when it is exposed.
 *
 * When no token is configured the hooks are omitted entirely rather than replaced
 * with permissive stubs, so "no auth" is visible in composition instead of hidden
 * behind a function that always returns true.
 *
 * Shared-token mode is refused when `nodeEnv` is `'production'`. The production
 * demo image sets `NODE_ENV=production`; leaving `EVUHARNESS_DEV_TOKEN` set there
 * fails startup instead of silently authorizing with a development convenience.
 */
export function demoAuth(
  token: string | undefined,
  options: DemoAuthOptions = {},
): AuthHooks | undefined {
  if (token === undefined || token === '') {
    return undefined;
  }

  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new Error(
      'EVUHARNESS_DEV_TOKEN cannot enable shared-token auth when NODE_ENV=production. ' +
        'Unset the token, or supply a real host AuthHooks implementation.',
    );
  }

  const expected = Buffer.from(token, 'utf8');

  return {
    getActor: (request) => {
      const header = request.headers.get('authorization') ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      const candidate = Buffer.from(presented, 'utf8');

      // Length is compared first because `timingSafeEqual` throws on a mismatch.
      // Leaking the token's length is not worth avoiding; leaking a prefix is, which
      // is why the comparison itself is constant-time.
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        return null;
      }

      return { id: 'demo-operator', capabilities: [CAPABILITY_WILDCARD] };
    },

    // A single token means a single role. A real host maps capabilities per actor
    // here instead of granting everything to whoever holds the secret. The wildcard
    // on the demo actor is what `actorHasCapability` honors.
    requireCapability: actorHasCapability,
  };
}
