import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFilesystemSkillCatalog,
  createHarness,
  FakeProvider,
  type GrantStore,
  type MemoryStore,
  type SessionStore,
  type SettingsStore,
} from '@evu/harness-core';
import {
  openPool,
  PostgresGrantStore,
  PostgresMemoryStore,
  PostgresSessionStore,
  PostgresSettingsStore,
} from '@evu/harness-postgres';
import { createHarnessRouter } from '@evu/harness-server';
import {
  openDatabase,
  SqliteGrantStore,
  SqliteMemoryStore,
  SqliteSessionStore,
  SqliteSettingsStore,
} from '@evu/harness-sqlite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { demoAuth } from './auth.js';
import { type DemoConfig, loadConfig } from './config.js';
import { demoMenus } from './demo-menus.js';
import { demoTools } from './demo-tools.js';

const demoSkillsRoot = resolve(fileURLToPath(new URL('../skills', import.meta.url)));

/**
 * The demo API.
 *
 * A worked example of host composition: build a harness, hand it to the router,
 * serve it. Everything demo-specific — the tools, the menus, the token auth — lives
 * in sibling modules so this file shows the shape a real host would follow.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const stores = await openStores(config);

  const skills = createFilesystemSkillCatalog({ roots: [demoSkillsRoot] });

  const harness = createHarness({
    store: stores.store,
    grants: stores.grants,
    settings: stores.settings,
    memory: stores.memory,
    ...(config.fakeProvider ? { provider: new FakeProvider() } : {}),
    tools: demoTools({ includeEcho: config.fakeProvider }),
    skills,
    contextMenus: demoMenus(skills),
    features: {
      attachments: true,
      agents: true,
      memory: true,
      webSearch: true,
      httpRequest: true,
      compaction: true,
      mcp: true,
    },
    providers: [
      {
        id: 'local',
        label: 'Local OpenAI-compatible',
        baseUrl: config.provider.baseUrl,
        model: config.provider.model,
        ...(config.provider.apiKey === undefined ? {} : { apiKey: config.provider.apiKey }),
        supportsEffort: true,
        supportsReasoning: true,
        ...(config.fakeProvider
          ? {
              models: [config.provider.model],
              modelContextWindows: { [config.provider.model]: 8_192 },
            }
          : {}),
      },
    ],
    prompts: {
      global: 'You are a helpful assistant running inside the EvuHarness demo.',
      dynamic: [
        {
          id: 'demo-environment',
          label: 'Demo environment',
          // A dynamic slot: evaluated per composition, and shown as dynamic in the
          // prompt preview so a reader knows it was not stored.
          render: ({ mode }) =>
            `This is the demo application. The active mode is ${mode}. ` +
            'Notes written with write_note live only in this process.',
        },
      ],
    },
  });

  const app = new Hono();

  // CORS only for a configured origin, and only when one is set. The dev web app is
  // served from a different port and needs it; the production image serves both
  // behind one origin and gets no CORS headers at all. A wildcard would be simpler
  // and would also make the demo a usable target for any page on the internet.
  if (config.webOrigin !== undefined) {
    app.use('/api/*', cors({ origin: config.webOrigin, credentials: true }));
  }
  app.route('/api', createHarnessRouter({ harness, ...withAuth(config.token) }));

  // Also mounted unprefixed so a container healthcheck does not need to know the
  // mount path.
  app.get('/health', (c) => c.json({ status: 'ok', name: 'evuharness-demo-api' }));

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.info(`evuharness demo api listening on http://${config.host}:${info.port}`);
    console.info(`  auth: ${config.token === undefined ? 'disabled' : 'shared token'}`);
    console.info(`  store: ${stores.label}`);
    if (config.fakeProvider) {
      console.info('  provider: fake (EVUHARNESS_FAKE_PROVIDER=1)');
    }
  });

  // Without this, a container stop waits out the full grace period on every restart.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.info(`${signal} received, shutting down`);
      server.close(() => {
        void stores.close().then(() => process.exit(0));
      });
    });
  }
}

/**
 * SQLite unless `EVUHARNESS_DATABASE_URL` is set. One connection/pool is shared
 * by all four stores. The URL is never logged.
 */
async function openStores(config: DemoConfig): Promise<{
  store: SessionStore;
  grants: GrantStore;
  settings: SettingsStore;
  memory: MemoryStore;
  close: () => Promise<void>;
  label: string;
}> {
  if (config.databaseUrl !== undefined) {
    const pool = await openPool({ connectionString: config.databaseUrl });
    return {
      store: new PostgresSessionStore({ pool }),
      grants: new PostgresGrantStore({ pool }),
      settings: new PostgresSettingsStore({ pool }),
      memory: new PostgresMemoryStore({ pool }),
      close: async () => {
        await pool.end();
      },
      label: 'postgres',
    };
  }

  // SQLite will not create a missing parent directory, and the resulting error names
  // the file rather than the directory, which is a confusing first-run experience.
  if (config.databasePath !== ':memory:') {
    await mkdir(dirname(resolve(config.databasePath)), { recursive: true });
  }

  const db = openDatabase({ path: config.databasePath });
  return {
    store: new SqliteSessionStore({ db }),
    grants: new SqliteGrantStore({ db }),
    settings: new SqliteSettingsStore({ db }),
    memory: new SqliteMemoryStore({ db }),
    close: async () => {
      db.close();
    },
    label: config.databasePath,
  };
}

function withAuth(token: string | undefined) {
  // nodeEnv is taken from the process so the production image (NODE_ENV=production)
  // cannot enable shared-token mode by accident. See apps/api/src/auth.ts.
  const auth = demoAuth(token, { nodeEnv: process.env.NODE_ENV });
  return auth === undefined ? {} : { auth };
}

main().catch((cause: unknown) => {
  console.error('failed to start', cause);
  process.exit(1);
});
