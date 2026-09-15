import {
  agentMode,
  askMode,
  type ModePolicy,
  ModeRegistry,
  planMode,
  STOCK_MODES,
  ToolRegistry,
} from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

function registryWithTools() {
  return new ToolRegistry([
    {
      name: 'read_status',
      description: 'Read status',
      parameters: {},
      mutates: false,
      handler: () => 'ok',
    },
    {
      name: 'restart_service',
      description: 'Restart a service',
      parameters: {},
      mutates: true,
      handler: () => 'ok',
    },
    {
      name: 'unannotated_tool',
      description: 'Host forgot to annotate this one',
      parameters: {},
      handler: () => 'ok',
    },
    {
      name: 'agent_only',
      description: 'Pinned to one mode',
      parameters: {},
      modes: ['agent'],
      handler: () => 'ok',
    },
    {
      name: 'propose_plan',
      description: 'Propose a plan',
      parameters: {},
      handler: () => 'ok',
    },
    {
      name: 'ask_user',
      description: 'Ask the user',
      parameters: {},
      handler: () => 'ok',
    },
  ]);
}

describe('mode tool selection', () => {
  const tools = registryWithTools();
  const ctx = tools.modeContext();

  it('gives ask mode read-only tools', () => {
    const allowed = askMode.toolNames(ctx);

    expect(allowed.has('read_status')).toBe(true);
    expect(allowed.has('restart_service')).toBe(false);
  });

  it('excludes an unannotated tool from read-only modes', () => {
    // The safe default: a tool nobody annotated is assumed to have side effects,
    // so forgetting the annotation costs availability rather than safety.
    expect(askMode.toolNames(ctx).has('unannotated_tool')).toBe(false);
    expect(agentMode.toolNames(ctx).has('unannotated_tool')).toBe(true);
  });

  it('honors an explicit mode pin over the mutates heuristic', () => {
    expect(askMode.toolNames(ctx).has('agent_only')).toBe(false);
    expect(agentMode.toolNames(ctx).has('agent_only')).toBe(true);
  });

  it('gives agent mode the mutating tools', () => {
    expect(agentMode.toolNames(ctx).has('restart_service')).toBe(true);
  });

  it('keeps plan mode read-only', () => {
    const allowed = planMode.toolNames(ctx);

    expect(allowed.has('read_status')).toBe(true);
    expect(allowed.has('restart_service')).toBe(false);
  });

  it('offers propose_plan in plan mode', () => {
    expect(planMode.toolNames(ctx).has('propose_plan')).toBe(true);
  });

  it('makes gate tools available in every mode', () => {
    for (const mode of STOCK_MODES) {
      expect(mode.toolNames(ctx).has('ask_user')).toBe(true);
    }
  });

  it('never returns a tool that is not registered', () => {
    const registered = new Set(tools.specs().map((spec) => spec.name));

    for (const mode of STOCK_MODES) {
      for (const name of mode.toolNames(ctx)) {
        expect(registered.has(name)).toBe(true);
      }
    }
  });
});

describe('ModeRegistry', () => {
  it('registers the stock modes by default', () => {
    expect(new ModeRegistry().ids()).toEqual(['ask', 'plan', 'agent']);
  });

  it('rejects duplicate mode ids', () => {
    expect(() => new ModeRegistry([askMode, askMode])).toThrow(/Duplicate mode id/);
  });

  it('rejects an empty policy list', () => {
    expect(() => new ModeRegistry([])).toThrow(/At least one mode policy/);
  });

  it('throws on an unknown mode rather than silently downgrading', () => {
    // Falling back to a default would run the turn under a policy nobody asked
    // for, which is the sort of failure that looks like a working system.
    expect(() => new ModeRegistry().get('nonexistent')).toThrow(/Unknown mode/);
  });

  it('accepts a host-defined mode', () => {
    const reviewMode: ModePolicy = {
      id: 'review',
      toolNames: () => new Set(['read_status']),
      systemBlurb: () => 'reviewing',
    };
    const registry = new ModeRegistry([askMode, reviewMode]);

    expect(registry.ids()).toContain('review');
    expect(registry.blurbFor('review')).toBe('reviewing');
  });

  it('uses the first registered mode as the default', () => {
    expect(new ModeRegistry([agentMode, askMode]).defaultMode).toBe('agent');
  });
});

describe('ToolRegistry', () => {
  it('rejects a duplicate tool name', () => {
    const registry = new ToolRegistry([
      { name: 'a', description: 'a', parameters: {}, handler: () => '' },
    ]);

    expect(() =>
      registry.register({ name: 'a', description: 'a', parameters: {}, handler: () => '' }),
    ).toThrow(/Duplicate tool name/);
  });

  it('defaults mutates to true', () => {
    const registry = new ToolRegistry([
      { name: 'a', description: 'a', parameters: {}, handler: () => '' },
    ]);

    expect(registry.get('a').spec.mutates).toBe(true);
  });

  it('defaults approval to requires_approval', () => {
    const registry = new ToolRegistry([
      { name: 'a', description: 'a', parameters: {}, handler: () => '' },
    ]);

    expect(registry.get('a').spec.approval).toBe('requires_approval');
  });

  it('marks a runtime-owned tool as builtin automatically', () => {
    const registry = new ToolRegistry([
      { name: 'ask_user', description: 'ask', parameters: {}, handler: () => '' },
    ]);

    expect(registry.get('ask_user').spec.builtin).toBe(true);
  });

  it('flags availability per mode in the catalog', () => {
    const tools = registryWithTools();
    const allowed = askMode.toolNames(tools.modeContext());
    const catalog = tools.catalogForMode(allowed);

    expect(catalog.find((entry) => entry.name === 'read_status')?.availableInMode).toBe(true);
    expect(catalog.find((entry) => entry.name === 'restart_service')?.availableInMode).toBe(false);
  });

  it('throws on an unknown tool lookup', () => {
    expect(() => new ToolRegistry().get('nope')).toThrow(/Unknown tool/);
  });
});
