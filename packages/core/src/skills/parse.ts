import type { Skill } from './types.js';

/**
 * Parse a `SKILL.md` document.
 *
 * Frontmatter is a small YAML subset: `key: value` lines between `---` fences.
 * Nested YAML is out of scope — skill metadata is two strings and an id.
 */
export function parseSkillMarkdown(
  raw: string,
  options: { id: string; sourceLabel?: string } = { id: 'skill' },
): Skill {
  const trimmed = raw.replace(/^\uFEFF/, '');
  const { meta, body } = splitFrontmatter(trimmed);

  const name = (meta.name ?? options.id).trim();
  const description = (meta.description ?? '').trim();
  if (name === '') {
    throw new Error(
      `Skill ${options.sourceLabel ?? options.id} is missing a name (frontmatter or id)`,
    );
  }

  return {
    id: options.id,
    name,
    description: description === '' ? name : description,
    body: body.trim(),
  };
}

function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) {
    return { meta: {}, body: raw };
  }

  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, body: raw };
  }

  const front = raw.slice(3, end).replace(/^\r?\n/, '');
  let body = raw.slice(end + 4);
  if (body.startsWith('\r\n')) {
    body = body.slice(2);
  } else if (body.startsWith('\n')) {
    body = body.slice(1);
  }

  return { meta: parseSimpleYaml(front), body };
}

function parseSimpleYaml(front: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') {
      meta[key] = value;
    }
  }
  return meta;
}

/**
 * Format a skill body for leading-system merge.
 *
 * Deliberately plain text: the merge path appends this to the system message and
 * must not invent a second system role.
 */
export function formatSkillInjection(skill: Skill): string {
  const header = `Loaded skill: ${skill.name}`;
  const body = skill.body.trim();
  return body === '' ? header : `${header}\n\n${body}`;
}
