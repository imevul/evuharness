import type { AgentProfile } from '@evu/harness-protocol';

export interface PromptSoul {
  id: string;
  label: string;
  text: string;
}

/**
 * Which souls a turn should compose.
 *
 * A session pin names one agent, even if it is no longer settings-active.
 * Unset means no agent — settings `active` is picker membership, not a stack.
 */
export function resolveSessionAgents(
  agents: readonly AgentProfile[],
  sessionAgentId: string | undefined,
): AgentProfile[] {
  if (sessionAgentId === undefined) {
    return [];
  }
  const match = agents.find((agent) => agent.id === sessionAgentId);
  return match === undefined ? [] : [match];
}

export function soulsForPrompt(agents: readonly AgentProfile[]): PromptSoul[] {
  const souls: PromptSoul[] = [];
  for (const agent of agents) {
    const text = agent.soul.trim();
    if (text === '') {
      continue;
    }
    souls.push({
      id: agent.id,
      label: agent.label ?? agent.id,
      text,
    });
  }
  return souls;
}
