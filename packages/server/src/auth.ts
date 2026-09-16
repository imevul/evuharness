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

/**
 * Wildcard that grants every `harness:*` capability when present on an actor.
 *
 * Hosts that want a single "operator" role can store this token instead of listing
 * each capability. It is a convention of `actorHasCapability`, not a route-level
 * special case: a host that writes its own `requireCapability` may ignore it.
 */
export const CAPABILITY_WILDCARD = 'harness:*' as const;

/**
 * Route → capability matrix enforced by `createHarnessRouter`.
 *
 * `/health` is intentionally absent: liveness probes must work without credentials.
 * Every other route names one of these four capabilities at its `guard` call site.
 */
export const ROUTE_CAPABILITIES = {
  'GET /status': CAPABILITIES.read,
  'POST /sessions': CAPABILITIES.chat,
  'GET /sessions': CAPABILITIES.read,
  'GET /sessions/:id': CAPABILITIES.read,
  'DELETE /sessions/:id': CAPABILITIES.chat,
  'POST /sessions/:id/set-mode': CAPABILITIES.chat,
  'POST /sessions/:id/set-provider': CAPABILITIES.chat,
  'POST /chat': CAPABILITIES.chat,
  'POST /sessions/:id/cancel': CAPABILITIES.chat,
  'POST /sessions/:id/tool-approvals/:approvalId': CAPABILITIES.decide,
  'POST /sessions/:id/approve-plan': CAPABILITIES.decide,
  'POST /sessions/:id/discard-plan': CAPABILITIES.decide,
  'POST /sessions/:id/mode-switch': CAPABILITIES.decide,
  'POST /sessions/:id/ask-user/:askId': CAPABILITIES.decide,
  'GET /settings': CAPABILITIES.read,
  'PATCH /settings': CAPABILITIES.administer,
  'POST /models': CAPABILITIES.administer,
  'POST /test': CAPABILITIES.administer,
  'GET /prompt/preview': CAPABILITIES.read,
  'GET /tools': CAPABILITIES.read,
  'GET /context-menus': CAPABILITIES.read,
  'POST /context-menus/:id/items': CAPABILITIES.read,
} as const satisfies Record<string, Capability>;

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

/**
 * Default check against an actor's `capabilities` list.
 *
 * Exact match, or the `harness:*` wildcard. Hosts that store capabilities on the
 * actor can pass this as `requireCapability` without writing their own matcher.
 * A null actor never grants a capability.
 */
export function actorHasCapability(actor: Actor | null, capability: Capability): boolean {
  if (actor === null) {
    return false;
  }
  const caps = actor.capabilities;
  if (caps === undefined) {
    return false;
  }
  return caps.includes(capability) || caps.includes(CAPABILITY_WILDCARD);
}

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
