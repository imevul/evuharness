/**
 * A skill the model can load: summary metadata plus the full instruction body.
 *
 * Skills are host content. The runtime owns discovery contracts and leading-system
 * injection; where files live on disk is a host configuration choice.
 */
export interface Skill {
  /** Stable id, usually the directory name under a configured root. */
  id: string;
  name: string;
  description: string;
  /** Markdown body after frontmatter, injected into the leading system message. */
  body: string;
}

/** Catalog entry shown in the prompt and in `/` menus — no body. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

/**
 * Host-supplied skill store.
 *
 * A host may back this with the filesystem, a database, or an in-memory list.
 * Core never assumes a path layout beyond what a concrete loader documents.
 */
export interface SkillCatalog {
  list(): readonly SkillSummary[] | Promise<readonly SkillSummary[]>;
  get(idOrName: string): Skill | null | Promise<Skill | null>;
}

export function toSkillSummary(skill: Skill): SkillSummary {
  return { id: skill.id, name: skill.name, description: skill.description };
}
