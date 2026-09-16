import { CAPABILITIES, CAPABILITY_WILDCARD } from '@evu/harness-server';
import { describe, expect, it } from 'vitest';
import { demoAuth } from '../src/auth.js';

describe('demoAuth', () => {
  it('omits hooks when no token is configured', () => {
    expect(demoAuth(undefined, { nodeEnv: 'development' })).toBeUndefined();
    expect(demoAuth('', { nodeEnv: 'development' })).toBeUndefined();
  });

  it('refuses shared-token mode in production', () => {
    expect(() => demoAuth('secret', { nodeEnv: 'production' })).toThrow(/NODE_ENV=production/);
  });

  it('resolves a matching bearer token to the demo operator', async () => {
    const auth = demoAuth('secret', { nodeEnv: 'development' });
    expect(auth).toBeDefined();

    const actor = await auth!.getActor!(
      new Request('http://localhost/status', {
        headers: { authorization: 'Bearer secret' },
      }),
    );

    expect(actor).toEqual({ id: 'demo-operator', capabilities: [CAPABILITY_WILDCARD] });
    expect(await auth!.requireCapability!(actor, CAPABILITIES.administer)).toBe(true);
  });

  it('rejects a missing or wrong bearer token as unauthenticated', async () => {
    const auth = demoAuth('secret', { nodeEnv: 'development' });

    expect(await auth!.getActor!(new Request('http://localhost/status'))).toBeNull();
    expect(
      await auth!.getActor!(
        new Request('http://localhost/status', {
          headers: { authorization: 'Bearer wrong' },
        }),
      ),
    ).toBeNull();
  });
});
