import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Aliased to source so editing the UI kit hot-reloads here without a build step
    // in between. This is also why the demo is a useful way to develop the kit.
    alias: {
      '@evu/harness-protocol': pkg('protocol'),
      '@evu/harness-ui': pkg('ui'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 4300,
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
