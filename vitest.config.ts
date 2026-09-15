import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Workspace packages resolve to source, not `dist`.
 *
 * So a test run needs no build step and a failure points at the line you edited
 * rather than at compiled output.
 */
const alias = {
  '@evu/harness-protocol': pkg('protocol'),
  '@evu/harness-core': pkg('core'),
  '@evu/harness-sqlite': pkg('sqlite'),
  '@evu/harness-server': pkg('server'),
  '@evu/harness-ui': pkg('ui'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      exclude: ['**/*.d.ts'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      reporter: ['text', 'lcov'],
    },
    /**
     * Two projects because the UI kit needs a DOM and nothing else should have one.
     *
     * Splitting them is not only about jsdom being slower: a runtime test that
     * accidentally reaches for `document` should fail rather than pass against an
     * environment the runtime will never have.
     */
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          // A single `*` at the package level, not `**`. A workspace package's
          // `node_modules/@evu/*` are symlinks back to sibling packages, so a
          // recursive glob here collects every sibling's tests once per dependent.
          include: ['packages/*/test/**/*.test.{ts,tsx}', 'apps/*/test/**/*.test.{ts,tsx}'],
          // Setting `exclude` replaces Vitest's defaults rather than adding to them,
          // so `node_modules` has to be restated or it comes back into scope.
          exclude: ['**/node_modules/**', '**/dist/**', 'packages/ui/**'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['packages/ui/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
