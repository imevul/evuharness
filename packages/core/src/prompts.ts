import type { ChatModeId, PromptPreview, PromptSection, Scope } from '@evu/harness-protocol';
import type { ModeRegistry } from './modes.js';

export interface PromptSlotContext {
  mode: ChatModeId;
  scope: Scope;
  sessionId?: string | undefined;
}

/**
 * A host-supplied prompt section, evaluated at composition time.
 *
 * Dynamic slots are the reason preview exists: their content is not stored
 * anywhere, so the only honest way to show a person the real prompt is to run the
 * same composition a new session runs.
 */
export interface PromptSlot {
  id: string;
  label: string;
  render(ctx: PromptSlotContext): string | Promise<string>;
}

export interface PromptConfig {
  global?: string;
  perMode?: Record<string, string>;
  dynamic?: PromptSlot[];
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface ComposePromptInput {
  mode: ChatModeId;
  modes: ModeRegistry;
  prompts: PromptConfig;
  scope?: Scope;
  sessionId?: string | undefined;
  skills?: readonly SkillSummary[];
}

const SECTION_SEPARATOR = '\n\n';

/**
 * Compose the system prompt for a mode.
 *
 * One function serves both a new session and the preview endpoint. If preview
 * used a second code path it would drift, and a preview that lies is worse than
 * no preview.
 *
 * Empty sections are dropped rather than emitted as blank blocks, so a host that
 * configures nothing gets a clean prompt instead of a run of separators.
 */
export async function composePrompt(input: ComposePromptInput): Promise<PromptPreview> {
  const scope: Scope = input.scope ?? {};
  const ctx: PromptSlotContext = {
    mode: input.mode,
    scope,
    sessionId: input.sessionId,
  };

  const sections: PromptSection[] = [];

  const global = input.prompts.global?.trim() ?? '';
  if (global !== '') {
    sections.push({ id: 'global', label: 'Global', text: global, dynamic: false });
  }

  const blurb = input.modes.blurbFor(input.mode).trim();
  if (blurb !== '') {
    sections.push({
      id: 'mode',
      label: `Mode: ${input.mode}`,
      text: `You are operating in ${input.mode} mode — ${blurb}.`,
      dynamic: false,
    });
  }

  const perMode = input.prompts.perMode?.[input.mode]?.trim() ?? '';
  if (perMode !== '') {
    sections.push({
      id: `mode:${input.mode}`,
      label: `Mode prompt: ${input.mode}`,
      text: perMode,
      dynamic: false,
    });
  }

  for (const slot of input.prompts.dynamic ?? []) {
    const rendered = (await slot.render(ctx)).trim();
    if (rendered === '') {
      continue;
    }
    sections.push({ id: slot.id, label: slot.label, text: rendered, dynamic: true });
  }

  const skills = input.skills ?? [];
  if (skills.length > 0) {
    sections.push({
      id: 'skills',
      label: 'Skills',
      text: formatSkillCatalog(skills),
      dynamic: false,
    });
  }

  return {
    mode: input.mode,
    sections,
    text: sections.map((section) => section.text).join(SECTION_SEPARATOR),
  };
}

function formatSkillCatalog(skills: readonly SkillSummary[]): string {
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return ['Available skills (load one before relying on it):', ...lines].join('\n');
}

/**
 * Merge extra text into the leading system message.
 *
 * Deliberately not an inserted mid-thread system message. Some models handle only
 * a single system message and mishandle a later one, so injected content — skill
 * bodies, turn notes — is appended to the first message instead. Losing that
 * detail would break exactly the small local models this is meant to support.
 */
export function mergeIntoLeadingSystemMessage(
  messages: { role: string; content: string }[],
  addition: string,
): void {
  const trimmed = addition.trim();
  if (trimmed === '') {
    return;
  }

  const leading = messages[0];
  if (leading !== undefined && leading.role === 'system') {
    leading.content = `${leading.content}${SECTION_SEPARATOR}${trimmed}`;
    return;
  }

  messages.unshift({ role: 'system', content: trimmed });
}
