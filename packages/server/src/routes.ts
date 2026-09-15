import { type Harness, setSessionMode } from '@evu/harness-core';
import {
  ChatRequestSchema,
  ContextMenuItemsRequestSchema,
  CreateSessionRequestSchema,
  type HarnessSettings,
  PromptPreviewRequestSchema,
  SetModeRequestSchema,
  ToolApprovalDecisionRequestSchema,
} from '@evu/harness-protocol';
import { type Context, Hono } from 'hono';
import {
  type AuthHooks,
  CAPABILITIES,
  type Capability,
  hasCapability,
  resolveActor,
} from './auth.js';

export interface HarnessRouterOptions {
  harness: Harness;
  auth?: AuthHooks;
  /** Reported on `/health`. Defaults to the protocol version. */
  version?: string;
}

/** Thrown for a request the runtime cannot serve yet. */
const NOT_IMPLEMENTED_MESSAGE =
  'The turn loop is not implemented yet. See SPEC.md for the specified behavior.';

/**
 * Build the route surface.
 *
 * Returns a Hono app rather than starting a server, so a host can mount it under
 * any base path inside an existing application.
 */
export function createHarnessRouter(options: HarnessRouterOptions): Hono {
  const { harness } = options;
  const auth = options.auth ?? {};
  const app = new Hono();

  /**
   * Authorize a request.
   *
   * Returns a response to send when the request is rejected, or `null` to proceed.
   * Written as a guard rather than middleware so each route names the capability
   * it needs at its own call site.
   */
  async function guard(request: Request, capability: Capability) {
    const actor = await resolveActor(auth, request);
    if (actor === null) {
      return { status: 401 as const, body: { error: 'unauthenticated' } };
    }
    if (!(await hasCapability(auth, actor, capability))) {
      return { status: 403 as const, body: { error: 'forbidden', detail: capability } };
    }
    return null;
  }

  app.get('/health', (c) =>
    c.json({
      status: 'ok' as const,
      name: 'evuharness',
      version: options.version ?? '0.0.0',
    }),
  );

  app.get('/status', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }
    return c.json(harness.status());
  });

  // --- Sessions ---

  app.post('/sessions', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.chat);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const parsed = CreateSessionRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', detail: parsed.error.message }, 400);
    }

    try {
      const session = await harness.createSession({
        mode: parsed.data.mode,
        ...(parsed.data.workspaceId === undefined ? {} : { workspaceId: parsed.data.workspaceId }),
        ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
      });
      return c.json(session, 201);
    } catch (error) {
      return c.json({ error: 'invalid_request', detail: messageOf(error) }, 400);
    }
  });

  app.get('/sessions', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const workspaceId = c.req.query('workspaceId');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
      return c.json({ error: 'invalid_request', detail: 'limit must be a positive integer' }, 400);
    }

    const sessions = await harness.listSessions({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(limit === undefined ? {} : { limit }),
    });
    return c.json({ sessions });
  });

  app.get('/sessions/:id', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const session = await harness.getSession(c.req.param('id'));
    return session === null ? c.json({ error: 'not_found' }, 404) : c.json(session);
  });

  app.delete('/sessions/:id', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.chat);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const deleted = await harness.deleteSession(c.req.param('id'));
    return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  /**
   * Explicit mode change, outside a turn.
   *
   * One of the three writers permitted to touch the session mode. It goes through
   * `setSessionMode` rather than writing the field, so the sanctioned-writer rule
   * is visible here.
   */
  app.post('/sessions/:id/set-mode', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.chat);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const parsed = SetModeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', detail: parsed.error.message }, 400);
    }
    if (!harness.modes.has(parsed.data.mode)) {
      return c.json({ error: 'invalid_request', detail: `Unknown mode: ${parsed.data.mode}` }, 400);
    }

    const id = c.req.param('id');
    const record = await harness.store.get(id);
    if (record === null) {
      return c.json({ error: 'not_found' }, 404);
    }

    await harness.store.upsert(setSessionMode(record, parsed.data.mode, 'explicit-set-mode'));
    const session = await harness.getSession(id);
    return c.json(session);
  });

  // --- Turn lifecycle ---

  /**
   * Streaming chat.
   *
   * The request carries the pinned mode for the turn. Until the turn loop lands
   * this validates and refuses rather than streaming a fake response: a demo that
   * appears to work is harder to reason about than one that says what is missing.
   */
  app.post('/chat', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.chat);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', detail: parsed.error.message }, 400);
    }
    if (!harness.modes.has(parsed.data.mode)) {
      return c.json({ error: 'invalid_request', detail: `Unknown mode: ${parsed.data.mode}` }, 400);
    }

    return c.json({ error: 'not_implemented', detail: NOT_IMPLEMENTED_MESSAGE }, 501);
  });

  app.post('/sessions/:id/cancel', async (c) => notImplemented(c, CAPABILITIES.chat));

  // --- Gates ---

  app.post('/sessions/:id/tool-approvals/:approvalId', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.decide);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const parsed = ToolApprovalDecisionRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', detail: parsed.error.message }, 400);
    }

    return c.json({ error: 'not_implemented', detail: NOT_IMPLEMENTED_MESSAGE }, 501);
  });

  app.post('/sessions/:id/approve-plan', async (c) => notImplemented(c, CAPABILITIES.decide));
  app.post('/sessions/:id/discard-plan', async (c) => notImplemented(c, CAPABILITIES.decide));
  app.post('/sessions/:id/mode-switch', async (c) => notImplemented(c, CAPABILITIES.decide));
  app.post('/sessions/:id/ask-user/:askId', async (c) => notImplemented(c, CAPABILITIES.decide));

  // --- Settings, prompts, tools ---

  app.get('/settings', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    // Provider profiles already carry `hasApiKey` rather than a credential, so
    // there is nothing to redact here — the shape makes a leak impossible.
    const settings: HarnessSettings = {
      providers: [...harness.providers],
      activeProviderId: harness.activeProviderId,
      prompts: { global: '', perMode: {} },
      policies: {
        toolApprovals: Object.fromEntries(
          harness.tools.specs().map((spec) => [spec.name, spec.approval]),
        ),
        askUserEnabled: harness.policies.askUser,
        maxToolRounds: harness.policies.maxToolRounds,
      },
      modes: harness.modes.ids(),
    };

    return c.json(settings);
  });

  // Mutating settings needs a durable settings store, which the runtime does not
  // have yet. Stubbed rather than omitted so a client gets `not_implemented` instead
  // of a 404 that reads like a wrong URL.
  app.patch('/settings', async (c) => notImplemented(c, CAPABILITIES.administer));
  app.post('/models', async (c) => notImplemented(c, CAPABILITIES.administer));
  app.post('/test', async (c) => notImplemented(c, CAPABILITIES.administer));

  app.get('/prompt/preview', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const parsed = PromptPreviewRequestSchema.safeParse({
      mode: c.req.query('mode') ?? harness.modes.defaultMode,
      ...(c.req.query('workspaceId') === undefined
        ? {}
        : { workspaceId: c.req.query('workspaceId') }),
      ...(c.req.query('sessionId') === undefined ? {} : { sessionId: c.req.query('sessionId') }),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', detail: parsed.error.message }, 400);
    }
    if (!harness.modes.has(parsed.data.mode)) {
      return c.json({ error: 'invalid_request', detail: `Unknown mode: ${parsed.data.mode}` }, 400);
    }

    const preview = await harness.previewPrompt({
      mode: parsed.data.mode,
      ...(parsed.data.workspaceId === undefined
        ? {}
        : { scope: { workspaceId: parsed.data.workspaceId } }),
      ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
    });

    return c.json(preview);
  });

  app.get('/tools', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const mode = c.req.query('mode') ?? harness.modes.defaultMode;
    if (!harness.modes.has(mode)) {
      return c.json({ error: 'invalid_request', detail: `Unknown mode: ${mode}` }, 400);
    }

    return c.json(harness.toolCatalog(mode));
  });

  // --- Context menus ---

  /**
   * The catalog, so a non-TypeScript host or a terminal client can drive the same
   * menus rather than reimplementing them.
   */
  app.get('/context-menus', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    return c.json({ menus: harness.menuCatalog() });
  });

  app.post('/context-menus/:id/items', async (c) => {
    const rejection = await guard(c.req.raw, CAPABILITIES.read);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }

    const menuId = c.req.param('id');
    if (!harness.contextMenus.has(menuId)) {
      return c.json({ error: 'not_found', detail: `Unknown context menu: ${menuId}` }, 404);
    }

    const parsed = ContextMenuItemsRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', detail: parsed.error.message }, 400);
    }

    try {
      const items = await harness.listMenuItems(menuId, {
        query: parsed.data.query,
        path: parsed.data.path,
        ...(parsed.data.workspaceId === undefined
          ? {}
          : { scope: { workspaceId: parsed.data.workspaceId } }),
      });
      return c.json(items);
    } catch (error) {
      // A source is host code; a failure there is a bad gateway, not a bad request.
      return c.json({ error: 'source_failed', detail: messageOf(error) }, 502);
    }
  });

  return app;

  async function notImplemented(c: Context, capability: Capability) {
    const rejection = await guard(c.req.raw, capability);
    if (rejection !== null) {
      return c.json(rejection.body, rejection.status);
    }
    return c.json({ error: 'not_implemented', detail: NOT_IMPLEMENTED_MESSAGE }, 501);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
