import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseSkillMarkdown } from './parse.js';
import type { Skill, SkillCatalog, SkillSummary } from './types.js';
import { toSkillSummary } from './types.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const SKILL_FILE = 'SKILL.md';

/**
 * In-memory catalog for tests and hosts that already hold skill documents.
 */
export function staticSkillCatalog(skills: readonly Skill[]): SkillCatalog {
  const byId = new Map<string, Skill>();
  const byName = new Map<string, Skill>();
  for (const skill of skills) {
    byId.set(skill.id, skill);
    byName.set(skill.name.toLowerCase(), skill);
  }

  return {
    list(): readonly SkillSummary[] {
      return skills.map(toSkillSummary);
    },
    get(idOrName: string): Skill | null {
      return byId.get(idOrName) ?? byName.get(idOrName.toLowerCase()) ?? null;
    },
  };
}

export interface FilesystemSkillCatalogOptions {
  /**
   * Absolute or process-relative roots to scan.
   *
   * Each root is expected to contain skill directories (`<root>/<id>/SKILL.md`).
   * Domain skill packs stay outside the library: a host points here.
   */
  roots: readonly string[];
  /** Refuse to read a `SKILL.md` larger than this. Default 256 KiB. */
  maxBytes?: number;
}

/**
 * Load skills from `SKILL.md` files under host-configured roots.
 *
 * Path handling follows SECURITY.md: normalize, stay inside each root, refuse
 * symlinks that escape, and enforce a size limit before reading.
 */
export function createFilesystemSkillCatalog(options: FilesystemSkillCatalogOptions): SkillCatalog {
  const roots = options.roots.map((root) => resolve(root));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let cache: Skill[] | null = null;

  async function loadAll(): Promise<Skill[]> {
    if (cache !== null) {
      return cache;
    }
    const loaded: Skill[] = [];
    const seen = new Set<string>();

    for (const root of roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        const skillDir = join(root, entry);
        let dirInfo: Awaited<ReturnType<typeof stat>>;
        try {
          dirInfo = await stat(skillDir);
        } catch (error) {
          if (isNotFound(error)) {
            continue;
          }
          throw error;
        }
        if (!dirInfo.isDirectory()) {
          continue;
        }

        const skillFile = join(skillDir, SKILL_FILE);
        const safePath = await resolveUnderRoot(root, skillFile);
        if (safePath === null) {
          continue;
        }

        let fileInfo: Awaited<ReturnType<typeof stat>>;
        try {
          fileInfo = await stat(safePath);
        } catch (error) {
          if (isNotFound(error)) {
            continue;
          }
          throw error;
        }
        if (!fileInfo.isFile()) {
          continue;
        }
        if (fileInfo.size > maxBytes) {
          throw new Error(
            `Skill '${entry}' exceeds maxBytes (${fileInfo.size} > ${maxBytes}) at ${safePath}`,
          );
        }

        const raw = await readFile(safePath, 'utf8');
        const skill = parseSkillMarkdown(raw, { id: entry, sourceLabel: safePath });
        if (seen.has(skill.id)) {
          throw new Error(`Duplicate skill id '${skill.id}' under configured roots`);
        }
        seen.add(skill.id);
        loaded.push(skill);
      }
    }

    cache = loaded;
    return loaded;
  }

  return {
    async list(): Promise<readonly SkillSummary[]> {
      return (await loadAll()).map(toSkillSummary);
    },
    async get(idOrName: string): Promise<Skill | null> {
      const all = await loadAll();
      const lower = idOrName.toLowerCase();
      return (
        all.find((skill) => skill.id === idOrName || skill.name.toLowerCase() === lower) ?? null
      );
    },
  };
}

async function resolveUnderRoot(root: string, candidate: string): Promise<string | null> {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (!isPathInside(normalizedRoot, normalizedCandidate)) {
    return null;
  }

  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = await realpath(normalizedRoot);
    candidateReal = await realpath(normalizedCandidate);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }

  if (!isPathInside(rootReal, candidateReal)) {
    return null;
  }
  return candidateReal;
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}
