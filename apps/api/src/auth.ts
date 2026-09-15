import { timingSafeEqual } from 'node:crypto';
import type { AuthHooks } from '@evu/harness-server';

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
 */
export function demoAuth(token: string | undefined): AuthHooks | undefined {
  if (token === undefined) {
    return undefined;
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

      return { id: 'demo-operator', capabilities: ['harness:*'] };
    },

    // A single token means a single role. A real host maps capabilities per actor
    // here instead of granting everything to whoever holds the secret.
    requireCapability: (actor) => actor !== null,
  };
}
