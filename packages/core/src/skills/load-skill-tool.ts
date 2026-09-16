import { BUILTIN_TOOL_NAMES } from '@evu/harness-protocol';
import type { ToolDefinition } from '../tools.js';

/**
 * Builtin `load_skill` registration.
 *
 * The turn loop intercepts this name and merges the skill body into the leading
 * system message. The handler is only a safe fallback if something executes it
 * outside the loop.
 */
export function builtinLoadSkillTool(): ToolDefinition {
  return {
    name: BUILTIN_TOOL_NAMES.loadSkill,
    description:
      'Load a skill by id or name and merge its instructions into the leading system message. Prefer this before relying on a skill from the catalog.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill id or name from the available-skills catalog.',
        },
      },
      required: ['name'],
    },
    mutates: false,
    approval: 'always_allow',
    builtin: true,
    handler: () => 'load_skill must be handled by the turn loop.',
  };
}
