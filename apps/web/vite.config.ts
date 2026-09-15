import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

// The demo aliases `@evu/harness-ui` to source. Bare imports in those files
// would otherwise resolve from this app, which does not declare the kit's
// renderer dependencies. Resolve them from the kit's own package.
const uiRequire = createRequire(
  fileURLToPath(new URL('../../packages/ui/package.json', import.meta.url)),
);
const fromUi = (specifier: string) => uiRequire.resolve(specifier);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Aliased to source so editing the UI kit hot-reloads here without a build step
    // in between. This is also why the demo is a useful way to develop the kit.
    alias: {
      '@evu/harness-protocol': pkg('protocol'),
      '@evu/harness-ui': pkg('ui'),
      'react-markdown': fromUi('react-markdown'),
      'remark-gfm': fromUi('remark-gfm'),
      'rehype-sanitize': fromUi('rehype-sanitize'),
      mermaid: fromUi('mermaid'),
    },
  },
  optimizeDeps: {
    include: ['react-markdown', 'remark-gfm', 'rehype-sanitize', 'mermaid'],
  },
  server: {
    host: '0.0.0.0',
    port: 4300,
    fs: {
      allow: [repoRoot],
    },
    // Proxied so the browser talks to one origin in dev, which keeps the demo
    // honest about cookies and CORS instead of relying on a permissive server.
    proxy: {
      '/api': {
        target: process.env.VITE_EVUHARNESS_API_PROXY_TARGET ?? 'http://127.0.0.1:4301',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
