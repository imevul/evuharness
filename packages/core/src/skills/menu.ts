import type { ContextMenuNode } from '@evu/harness-protocol';
import { commandsMenu } from '../context-menus/presets.js';
import type { ContextMenuDefinition, ContextMenuSource } from '../context-menus/types.js';
import { formatSkillInjection } from './parse.js';
import type { SkillCatalog } from './types.js';

/**
 * A `/` menu source backed by a skill catalog.
 *
 * Flat list of skills; picking one merges the skill body into the leading system
 * message via the commands preset's `prompt` effect.
 */
export function skillMenuSource(catalog: SkillCatalog): ContextMenuSource {
  return {
    id: 'skills',
    async list({ query }): Promise<ContextMenuNode[]> {
      const skills = await catalog.list();
      const normalized = query.trim().toLowerCase();
      return skills
        .filter((skill) => {
          if (normalized === '') return true;
          return (
            skill.id.toLowerCase().includes(normalized) ||
            skill.name.toLowerCase().includes(normalized) ||
            skill.description.toLowerCase().includes(normalized)
          );
        })
        .map((skill) => ({
          kind: 'item' as const,
          id: skill.id,
          label: skill.name,
          hint: skill.description,
          payload: { skillId: skill.id },
        }));
    },
  };
}

/**
 * Build a `/` commands menu whose picks inject skill bodies into the leading
 * system message.
 *
 * Pass additional `sources` to list host commands alongside skills under one `/`
 * trigger — only one menu may own a trigger character.
 */
export function skillsMenu(options: {
  catalog: SkillCatalog;
  id?: string;
  trigger?: string;
  title?: string;
  icon?: string;
  sources?: Parameters<typeof commandsMenu>[0]['sources'];
  /**
   * Optional host resolver for non-skill picks. Skills always win when the id
   * matches the catalog; unknown ids fall through here, then to a prompt notice.
   */
  resolveOther?: ContextMenuDefinition['resolve'];
}): ContextMenuDefinition {
  const catalog = options.catalog;
  const skillSource = skillMenuSource(catalog);
  const sources = options.sources === undefined ? [skillSource] : [...options.sources, skillSource];

  return commandsMenu({
    id: options.id ?? 'commands',
    trigger: options.trigger ?? '/',
    title: options.title ?? 'Commands',
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    sources,
    resolve: async (input) => {
      const skill = await catalog.get(input.ref.id);
      if (skill !== null) {
        return {
          effect: 'prompt',
          text: formatSkillInjection(skill),
        };
      }
      if (options.resolveOther !== undefined) {
        return options.resolveOther(input);
      }
      return {
        effect: 'prompt',
        text: `Unknown skill '${input.ref.id}'.`,
      };
    },
  });
}
