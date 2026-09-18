import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PACKAGES_ARCHIVE,
  packRelease,
  releaseAssetBase,
  rewriteWorkspaceDeps,
  tarballFileName,
} from '../pack-release.mjs';

describe('tarballFileName', () => {
  it('strips the scope for npm-style archive names', () => {
    expect(tarballFileName('@evu/harness-core', '0.0.0')).toBe('evu-harness-core-0.0.0.tgz');
  });
});

describe('rewriteWorkspaceDeps', () => {
  it('rewrites workspace specs and leaves registry ranges alone', () => {
    expect(
      rewriteWorkspaceDeps({ '@evu/harness-protocol': 'workspace:*', zod: '^4.1.13' }, (name) =>
        name === '@evu/harness-protocol' ? 'file:../protocol' : undefined,
      ),
    ).toEqual({
      '@evu/harness-protocol': 'file:../protocol',
      zod: '^4.1.13',
    });
  });

  it('fails when a workspace sibling is missing from the pack set', () => {
    expect(() => rewriteWorkspaceDeps({ '@evu/missing': 'workspace:*' }, () => undefined)).toThrow(
      /missing/,
    );
  });
});

describe('releaseAssetBase', () => {
  it('builds a download URL only when both repo and tag are set', () => {
    expect(releaseAssetBase('acme/harness', 'v1')).toBe(
      'https://github.com/acme/harness/releases/download/v1',
    );
    expect(releaseAssetBase(undefined, 'v1')).toBeUndefined();
  });
});

describe('packRelease', () => {
  it('stages a file: tree and URL-rewritten tarballs', () => {
    const root = mkdtempSync(join(tmpdir(), 'evuharness-pack-test-'));
    writeFixturePackage(root, 'protocol', {
      name: '@evu/harness-protocol',
      deps: { zod: '^4.1.13' },
    });
    writeFixturePackage(root, 'core', {
      name: '@evu/harness-core',
      deps: { '@evu/harness-protocol': 'workspace:*', zod: '^4.1.13' },
    });

    const outDir = join(root, 'dist-release');
    const manifest = packRelease({
      root,
      outDir,
      tag: 'vtest',
      repository: 'acme/harness',
    });

    expect(manifest.packages.map((entry) => entry.name)).toEqual([
      '@evu/harness-core',
      '@evu/harness-protocol',
    ]);

    const coreTree = JSON.parse(
      readFileSync(join(outDir, 'packages/core/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; scripts?: unknown };
    expect(coreTree.dependencies['@evu/harness-protocol']).toBe('file:../protocol');
    expect(coreTree.dependencies.zod).toBe('^4.1.13');
    expect(coreTree.scripts).toBeUndefined();

    const listing = execFileSync(
      'tar',
      ['-tzf', join(outDir, 'tarballs/evu-harness-core-0.0.0.tgz')],
      {
        encoding: 'utf8',
      },
    );
    expect(listing).toContain('package/package.json');
    expect(listing).toContain('package/dist/index.js');

    const extract = mkdtempSync(join(tmpdir(), 'evuharness-pack-extract-'));
    execFileSync('tar', [
      '-xzf',
      join(outDir, 'tarballs/evu-harness-core-0.0.0.tgz'),
      '-C',
      extract,
    ]);
    const packed = JSON.parse(readFileSync(join(extract, 'package/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(packed.dependencies['@evu/harness-protocol']).toBe(
      'https://github.com/acme/harness/releases/download/vtest/evu-harness-protocol-0.0.0.tgz',
    );

    const treeListing = execFileSync('tar', ['-tzf', join(outDir, PACKAGES_ARCHIVE)], {
      encoding: 'utf8',
    });
    expect(treeListing).toMatch(/packages\/protocol\/package\.json/);
  });
});

function writeFixturePackage(
  root: string,
  dir: string,
  input: { name: string; deps: Record<string, string> },
) {
  const path = join(root, 'packages', dir);
  mkdirSync(join(path, 'dist'), { recursive: true });
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'dist/index.js'), 'export {}\n');
  writeFileSync(join(path, 'src/index.ts'), 'export {}\n');
  writeFileSync(
    join(path, 'package.json'),
    `${JSON.stringify(
      {
        name: input.name,
        version: '0.0.0',
        private: true,
        files: ['dist', 'src'],
        dependencies: input.deps,
        scripts: { prepublishOnly: 'node ../../scripts/refuse-publish.mjs' },
      },
      null,
      2,
    )}\n`,
  );
}
