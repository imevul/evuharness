import { BUILTIN_TOOL_NAMES, type ChatModeId, type ToolSpec } from '@evu/harness-protocol';

export interface ModeToolContext {
  /** Every registered tool, host and builtin. */
  tools: readonly ToolSpec[];
}

/**
 * A mode is a policy, not a feature flag: an id, the tools it permits, and a
 * short blurb appended to the system prompt.
 *
 * Hosts implement this interface to add a mode. Nothing else in the runtime needs
 * to change, which is the point.
 */
export interface ModePolicy {
  readonly id: ChatModeId;
  toolNames(ctx: ModeToolContext): ReadonlySet<string>;
  systemBlurb(): string;
}

/**
 * Tools the model uses to talk to the person or load a skill.
 *
 * Available in every mode. Gate tools suspend the turn; `report_progress` only
 * writes a short note. None of them cause a host side effect on their own.
 */
const GATE_TOOLS: readonly string[] = [
  BUILTIN_TOOL_NAMES.requestModeSwitch,
  BUILTIN_TOOL_NAMES.proposePlan,
  BUILTIN_TOOL_NAMES.askUser,
  BUILTIN_TOOL_NAMES.loadSkill,
  BUILTIN_TOOL_NAMES.reportProgress,
];

/**
 * Select tools for a mode.
 *
 * An explicit `modes` list on a tool always wins, so a host can pin a tool to
 * exactly the modes it wants. Otherwise the decision falls to `mutates`, whose
 * default is `true` — an unannotated tool is treated as having side effects and
 * therefore stays out of read-only modes.
 */
function selectTools(
  ctx: ModeToolContext,
  modeId: ChatModeId,
  options: { allowMutating: boolean; extraTools?: readonly string[] },
): ReadonlySet<string> {
  const allowed = new Set<string>();

  for (const tool of ctx.tools) {
    if (tool.modes.length > 0) {
      if (tool.modes.includes(modeId)) {
        allowed.add(tool.name);
      }
      continue;
    }

    if (options.allowMutating || !tool.mutates) {
      allowed.add(tool.name);
    }
  }

  const registered = new Set(ctx.tools.map((tool) => tool.name));
  for (const name of GATE_TOOLS) {
    if (registered.has(name)) {
      allowed.add(name);
    }
  }

  for (const name of options.extraTools ?? []) {
    if (registered.has(name)) {
      allowed.add(name);
    }
  }

  return allowed;
}

/** Read-only. Answer, inspect, do not mutate. */
export const askMode: ModePolicy = {
  id: 'ask',
  toolNames(ctx) {
    return selectTools(ctx, 'ask', { allowMutating: false });
  },
  systemBlurb() {
    return 'read-only: answer and inspect, and do not attempt changes';
  },
};

/**
 * Read-only discovery that ends in a plan.
 *
 * Plan does not unlock writes. Approving a plan switches the session to `agent`
 * and mints the receipts for the approved steps; it never widens what the
 * planning turn itself could do.
 */
export const planMode: ModePolicy = {
  id: 'plan',
  toolNames(ctx) {
    return selectTools(ctx, 'plan', {
      allowMutating: false,
      extraTools: [BUILTIN_TOOL_NAMES.proposePlan],
    });
  },
  systemBlurb() {
    return 'planning: investigate read-only, then propose a plan for approval rather than acting';
  },
};

/** Mutating work, subject to the approval policy. */
export const agentMode: ModePolicy = {
  id: 'agent',
  toolNames(ctx) {
    return selectTools(ctx, 'agent', { allowMutating: true });
  },
  systemBlurb() {
    return 'acting: make changes, and expect gated tools to require approval';
  },
};

export const STOCK_MODES: readonly ModePolicy[] = [askMode, planMode, agentMode];

/**
 * A registered set of mode policies.
 *
 * Lookup is strict rather than falling back to a default mode: a request naming
 * an unregistered mode is a bug in the caller, and silently downgrading it would
 * mean running a turn under a policy nobody asked for.
 */
export class ModeRegistry {
  private readonly policies = new Map<ChatModeId, ModePolicy>();

  constructor(policies: Iterable<ModePolicy> = STOCK_MODES) {
    for (const policy of policies) {
      if (this.policies.has(policy.id)) {
        throw new Error(`Duplicate mode id: ${policy.id}`);
      }
      this.policies.set(policy.id, policy);
    }
    if (this.policies.size === 0) {
      throw new Error('At least one mode policy is required');
    }
  }

  has(id: ChatModeId): boolean {
    return this.policies.has(id);
  }

  get(id: ChatModeId): ModePolicy {
    const policy = this.policies.get(id);
    if (policy === undefined) {
      throw new Error(`Unknown mode: ${id}. Registered modes: ${this.ids().join(', ')}`);
    }
    return policy;
  }

  ids(): ChatModeId[] {
    return [...this.policies.keys()];
  }

  /** The mode a new session gets when a caller does not name one. */
  get defaultMode(): ChatModeId {
    const first = this.ids()[0];
    if (first === undefined) {
      throw new Error('Mode registry is empty');
    }
    return first;
  }

  toolNamesFor(id: ChatModeId, ctx: ModeToolContext): ReadonlySet<string> {
    return this.get(id).toolNames(ctx);
  }

  blurbFor(id: ChatModeId): string {
    return this.get(id).systemBlurb();
  }
}
