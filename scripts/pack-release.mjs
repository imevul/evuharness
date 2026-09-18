#!/usr/bin/env node
/**
 * Build registry-free release artifacts for host `file:` / URL installs.
 *
 * `pnpm pack` rewrites `workspace:*` to `0.0.0`, which sends consumers to a
 * registry that does not have these packages. This script restages each
 * workspace package and rewrites those specs to either:
 *
 *   - `file:../<dir>` inside `evuharness-packages.tgz` (offline vendor tree)
 *   - same-tag GitHub Release asset URLs on the individual `*.tgz` files
 *
 * Never writes a registry publish command or credential.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGES_ARCHIVE = 'evuharness-packages.tgz';
export const MANIFEST_NAME = 'manifest.json';

const KEEP_FIELDS = [
  'name',
  'version',
  'private',
  'license',
  'description',
  'type',
  'main',
  'types',
  'exports',
  'files',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'engines',
];

export function tarballFileName(name, version) {
  return `${name.replace(/^@/u, '').replace(/\//u, '-')}-${version}.tgz`;
}

export function isWorkspaceSpec(spec) {
  return typeof spec === 'string' && spec.startsWith('workspace:');
}

/**
 * @param {Record<string, string> | undefined} deps
 * @param {(name: string) => string | undefined} resolve
 */
export function rewriteWorkspaceDeps(deps, resolve) {
  if (deps === undefined) return undefined;
  const next = { ...deps };
  for (const [name, spec] of Object.entries(next)) {
    if (!isWorkspaceSpec(spec)) continue;
    const rewritten = resolve(name);
    if (rewritten === undefined) {
      throw new Error(`workspace dependency ${name} is not a packed package`);
    }
    next[name] = rewritten;
  }
  return next;
}

export function discoverWorkspacePackages(root) {
  const packagesDir = join(root, 'packages');
  const found = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
      throw new Error(`${manifestPath} is missing name or version`);
    }
    found.push({
      dir: entry.name,
      path: join(packagesDir, entry.name),
      pkg,
    });
  }
  found.sort((a, b) => a.dir.localeCompare(b.dir));
  return found;
}

export function releaseAssetBase(repository, tag) {
  if (repository === undefined || repository === '' || tag === undefined || tag === '') {
    return undefined;
  }
  return `https://github.com/${repository}/releases/download/${tag}`;
}

function consumerManifest(pkg, resolve) {
  const next = {};
  for (const field of KEEP_FIELDS) {
    if (pkg[field] !== undefined) next[field] = pkg[field];
  }
  next.dependencies = rewriteWorkspaceDeps(pkg.dependencies, resolve);
  if (next.dependencies === undefined) delete next.dependencies;
  return next;
}

function copyListedFiles(fromDir, toDir, files, root) {
  mkdirSync(toDir, { recursive: true });
  for (const rel of files ?? []) {
    const source = join(fromDir, rel);
    if (!existsSync(source)) {
      throw new Error(`pack file missing: ${source} (run make build first)`);
    }
    cpSync(source, join(toDir, rel), { recursive: true });
  }
  for (const extra of ['LICENSE', 'README.md']) {
    const source = join(fromDir, extra);
    if (existsSync(source)) {
      cpSync(source, join(toDir, extra));
      continue;
    }
    const fallback = join(root, extra);
    if (extra === 'LICENSE' && existsSync(fallback)) {
      cpSync(fallback, join(toDir, extra));
    }
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function tarDirectory(archivePath, cwd, ...entries) {
  execFileSync('tar', ['-czf', archivePath, ...entries], { cwd, stdio: 'pipe' });
}

function packNpmTarball(destTarball, stagedPackageDir) {
  const work = mkdtempSync(join(tmpdir(), 'evuharness-pack-'));
  try {
    const packageRoot = join(work, 'package');
    cpSync(stagedPackageDir, packageRoot, { recursive: true });
    tarDirectory(destTarball, work, 'package');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function packRelease(options) {
  const root = options.root;
  const outDir = options.outDir;
  const packages = options.packages ?? discoverWorkspacePackages(root);
  const assetBase = releaseAssetBase(options.repository, options.tag);

  rmSync(outDir, { recursive: true, force: true });
  const treeDir = join(outDir, 'packages');
  const tarballDir = join(outDir, 'tarballs');
  mkdirSync(treeDir, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });

  const byName = new Map(packages.map((entry) => [entry.pkg.name, entry]));

  const resolveFileDir = (name) => {
    const dep = byName.get(name);
    return dep === undefined ? undefined : `file:../${dep.dir}`;
  };
  const resolveReleaseUrl = (name) => {
    const dep = byName.get(name);
    if (dep === undefined || assetBase === undefined) return undefined;
    return `${assetBase}/${tarballFileName(dep.pkg.name, dep.pkg.version)}`;
  };

  const packed = [];
  for (const entry of packages) {
    const dest = join(treeDir, entry.dir);
    copyListedFiles(entry.path, dest, entry.pkg.files, root);
    const manifest = consumerManifest(entry.pkg, resolveFileDir);
    writeJson(join(dest, 'package.json'), manifest);

    const tarball = tarballFileName(entry.pkg.name, entry.pkg.version);
    const tarballPath = join(tarballDir, tarball);
    const urlStage = join(outDir, '.url-stage', entry.dir);
    copyListedFiles(entry.path, urlStage, entry.pkg.files, root);
    writeJson(
      join(urlStage, 'package.json'),
      consumerManifest(entry.pkg, assetBase === undefined ? resolveFileDir : resolveReleaseUrl),
    );
    packNpmTarball(tarballPath, urlStage);

    packed.push({
      name: entry.pkg.name,
      dir: entry.dir,
      tarball,
      file: `file:vendor/evuharness/packages/${entry.dir}`,
    });
  }

  rmSync(join(outDir, '.url-stage'), { recursive: true, force: true });

  const archivePath = join(outDir, PACKAGES_ARCHIVE);
  tarDirectory(archivePath, outDir, 'packages');

  const fileInstall = Object.fromEntries(packed.map((entry) => [entry.name, entry.file]));
  const manifest = {
    tag: options.tag ?? null,
    packages: packed,
    fileInstall,
  };
  writeJson(join(outDir, MANIFEST_NAME), manifest);
  writeFileSync(join(outDir, 'RELEASE-NOTES.md'), renderReleaseNotes(manifest, assetBase));
  return manifest;
}

export function renderReleaseNotes(manifest, assetBase) {
  const fileLines = Object.entries(manifest.fileInstall)
    .map(([name, spec]) => `    "${name}": "${spec}"`)
    .join(',\n');
  const urlLines =
    assetBase === undefined
      ? ''
      : `\n### Single tarball\n\nDownload one \`evu-harness-*.tgz\` and depend with \`file:\` or its\nrelease asset URL. Sibling \`@evu/*\` dependencies resolve to the other\nassets on this release.\n`;

  return [
    '## Install',
    '',
    'No registry. Hosts consume these assets with `file:` or the asset URL.',
    '',
    '### Vendored `file:` (offline)',
    '',
    `1. Download \`${PACKAGES_ARCHIVE}\` and extract it to \`vendor/evuharness\`.`,
    '2. Depend on the packages you use. Transitive `@evu/*` specs already',
    '   point at sibling folders in that tree.',
    '',
    '```json',
    '{',
    '  "dependencies": {',
    fileLines,
    '  }',
    '}',
    '```',
    urlLines,
    "Peer dependencies (`react`, `hono`, …) stay the host's to install.",
    '',
  ].join('\n');
}

function isMain(url) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(url) === entry;
}

if (isMain(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outDir = join(root, 'dist-release');
  const tag = process.env.RELEASE_TAG || undefined;
  const repository = process.env.GITHUB_REPOSITORY || undefined;
  const manifest = packRelease({ root, outDir, tag, repository });
  process.stdout.write(`pack-release: ${manifest.packages.length} packages → ${outDir}\n`);
}
