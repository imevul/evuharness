import {
  type ChatModeId,
  isBuiltinToolName,
  type Scope,
  type ToolCatalogEntry,
  type ToolSpec,
  ToolSpecSchema,
} from '@evu/harness-protocol';
import type { ModeToolContext } from './modes.js';

/** What a tool handler receives. */
export interface ToolContext {
  sessionId: string;
  /** The turn's pinned mode, not the session default. */
  mode: ChatModeId;
  /** Threaded so a host tool can scope its effect without re-plumbing anything. */
  scope: Scope;
  signal: AbortSignal;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string> | string;

/** A tool as registered: the advertised spec plus the code behind it. */
export interface ToolRegistration {
  spec: ToolSpec;
  handler: ToolHandler;
}

/** Registration input, accepting spec fields with schema defaults unapplied. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  modes?: string[];
  mutates?: boolean;
  approval?: ToolSpec['approval'];
  builtin?: boolean;
  handler: ToolHandler;
}

export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistration>();

  constructor(definitions: Iterable<ToolDefinition> = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: ToolDefinition): void {
    if (this.entries.has(definition.name)) {
      throw new Error(`Duplicate tool name: ${definition.name}`);
    }

    const { handler, ...specInput } = definition;
    const spec = ToolSpecSchema.parse({
      ...specInput,
      builtin: specInput.builtin ?? isBuiltinToolName(definition.name),
    });

    this.entries.set(spec.name, { spec, handler });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get(name: string): ToolRegistration {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return entry;
  }

  specs(): readonly ToolSpec[] {
    return [...this.entries.values()].map((entry) => entry.spec);
  }

  get size(): number {
    return this.entries.size;
  }

  modeContext(): ModeToolContext {
    return { tools: this.specs() };
  }

  /**
   * The specs a mode permits, in registration order.
   *
   * This is what becomes a turn's tool allowlist, pinned at send time.
   */
  specsForMode(allowedNames: ReadonlySet<string>): readonly ToolSpec[] {
    return this.specs().filter((spec) => allowedNames.has(spec.name));
  }

  /** Catalog view: every tool, each flagged for availability in one mode. */
  catalogForMode(allowedNames: ReadonlySet<string>): ToolCatalogEntry[] {
    return this.specs().map((spec) => ({
      ...spec,
      availableInMode: allowedNames.has(spec.name),
    }));
  }
}
