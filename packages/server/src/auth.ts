/**
 * Authentication hooks.
 *
 * The library does not invent users. A host supplies actor resolution and
 * capability checks; anything else would force every consumer to adapt to an
 * identity model it already has.
 *
 * A host that supplies neither hook gets an unauthenticated harness, which is
 * acceptable only for local development.
 */

export interface Actor {
  id: string;
  /** Free-form host capability tokens, checked by `requireCapability`. */
  capabilities?: readonly string[];
  [key: string]: unknown;
}

/** Capabilities the route surface asks about. */
export const CAPABILITIES = {
  /** Start a turn or send a message. */
  chat: 'harness:chat',
  /** Read sessions and settings. */
  read: 'harness:read',
  /** Resolve a gate: approve a tool, a plan, a mode switch, or answer a question. */
  decide: 'harness:decide',
  /** Change settings. */
  administer: 'harness:administer',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export interface AuthHooks {
  /**
   * Resolve the actor for a request. Return `null` to reject as unauthenticated.
   *
   * Omitted means every request is anonymous and allowed.
   */
  getActor?: (request: Request) => Promise<Actor | null> | Actor | null;
  /**
   * Authorize a capability for an actor.
   *
   * Omitted means every capability is granted. Checks run on the server boundary,
   * before a turn starts, rather than inside a tool handler.
   */
  requireCapability?: (actor: Actor | null, capability: Capability) => Promise<boolean> | boolean;
}

export const ANONYMOUS_ACTOR: Actor = { id: 'anonymous' };

export async function resolveActor(hooks: AuthHooks, request: Request): Promise<Actor | null> {
  if (hooks.getActor === undefined) {
    return ANONYMOUS_ACTOR;
  }
  return hooks.getActor(request);
}

export async function hasCapability(
  hooks: AuthHooks,
  actor: Actor | null,
  capability: Capability,
): Promise<boolean> {
  if (hooks.requireCapability === undefined) {
    return true;
  }
  return hooks.requireCapability(actor, capability);
}
