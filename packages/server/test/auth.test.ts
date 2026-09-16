import {
  ANONYMOUS_ACTOR,
  actorHasCapability,
  CAPABILITIES,
  CAPABILITY_WILDCARD,
  hasCapability,
  resolveActor,
  ROUTE_CAPABILITIES,
} from '@evu/harness-server';
import { describe, expect, it } from 'vitest';

const request = new Request('http://localhost/status');

describe('resolveActor', () => {
  it('returns the anonymous actor when getActor is omitted', async () => {
    expect(await resolveActor({}, request)).toEqual(ANONYMOUS_ACTOR);
  });

  it('returns null when the host rejects the request', async () => {
    expect(await resolveActor({ getActor: () => null }, request)).toBeNull();
  });

  it('returns the host-resolved actor', async () => {
    const actor = { id: 'alice', capabilities: [CAPABILITIES.read] };
    expect(await resolveActor({ getActor: () => actor }, request)).toEqual(actor);
  });
});

describe('hasCapability', () => {
  it('grants every capability when requireCapability is omitted', async () => {
    expect(await hasCapability({}, { id: 'anyone' }, CAPABILITIES.administer)).toBe(true);
  });

  it('defers to the host checker', async () => {
    expect(
      await hasCapability(
        {
          requireCapability: (actor, capability) =>
            actor?.id === 'ops' && capability === CAPABILITIES.chat,
        },
        { id: 'ops' },
        CAPABILITIES.chat,
      ),
    ).toBe(true);
    expect(
      await hasCapability({ requireCapability: () => false }, { id: 'ops' }, CAPABILITIES.chat),
    ).toBe(false);
  });
});

describe('actorHasCapability', () => {
  it('rejects a null actor', () => {
    expect(actorHasCapability(null, CAPABILITIES.read)).toBe(false);
  });

  it('rejects an actor with no capabilities list', () => {
    expect(actorHasCapability({ id: 'bare' }, CAPABILITIES.read)).toBe(false);
  });

  it('matches an exact capability', () => {
    expect(
      actorHasCapability({ id: 'viewer', capabilities: [CAPABILITIES.read] }, CAPABILITIES.read),
    ).toBe(true);
    expect(
      actorHasCapability({ id: 'viewer', capabilities: [CAPABILITIES.read] }, CAPABILITIES.chat),
    ).toBe(false);
  });

  it('matches the harness wildcard', () => {
    expect(
      actorHasCapability({ id: 'ops', capabilities: [CAPABILITY_WILDCARD] }, CAPABILITIES.decide),
    ).toBe(true);
  });
});

describe('ROUTE_CAPABILITIES', () => {
  it('covers every sensitive route with one of the four capabilities', () => {
    const values = new Set(Object.values(ROUTE_CAPABILITIES));
    expect(values).toEqual(
      new Set([
        CAPABILITIES.read,
        CAPABILITIES.chat,
        CAPABILITIES.decide,
        CAPABILITIES.administer,
      ]),
    );
    // Health is deliberately unauthenticated and must stay off this list.
    expect(Object.keys(ROUTE_CAPABILITIES).some((route) => route.includes('/health'))).toBe(false);
  });
});
