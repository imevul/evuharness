import { BUILTIN_TOOL_NAMES } from '@evu/harness-protocol';
import type { ToolDefinition } from './tools.js';

/**
 * Runtime-owned tools offered in every stock mode.
 *
 * Gate names are intercepted by the turn loop; their handlers are a safe
 * fallback if a host executes them outside it. `report_progress` runs as a
 * normal always-allow tool and only writes a user-visible note.
 */
export function builtinGateTools(): ToolDefinition[] {
  return [
    {
      name: BUILTIN_TOOL_NAMES.proposePlan,
      description:
        'Propose a multi-step plan for approval. Suspends the turn until a person approves or discards it.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short plan title.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: 'Optional tool this step will call.' },
                summary: { type: 'string', description: 'What this step does.' },
                arguments: {
                  type: 'object',
                  description: 'Exact arguments for a one-shot receipt when approved.',
                },
              },
              required: ['summary'],
            },
          },
        },
        required: ['title', 'steps'],
      },
      mutates: false,
      approval: 'always_allow',
      builtin: true,
      handler: () => 'Plan proposal must be handled by the turn loop.',
    },
    {
      name: BUILTIN_TOOL_NAMES.requestModeSwitch,
      description:
        'Request switching the session default mode. Suspends until a person approves or denies.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            enum: ['ask', 'plan', 'agent'],
            description: 'Mode to switch the session default to.',
          },
          reason: { type: 'string', description: 'Why the switch is needed.' },
        },
        required: ['to', 'reason'],
      },
      mutates: false,
      approval: 'always_allow',
      builtin: true,
      handler: () => 'Mode switch request must be handled by the turn loop.',
    },
    builtinProgressTool(),
  ];
}

/**
 * Short user-visible status line. No side effects; the handler only acknowledges.
 */
export function builtinProgressTool(): ToolDefinition {
  return {
    name: BUILTIN_TOOL_NAMES.reportProgress,
    description:
      'Share a one- or two-sentence progress note with the user. Call this after thinking or after a tool result to say what you just did, what you will do next, or what you are checking. Do not use it for the final answer.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'One or two short sentences. No markdown, no lists.',
        },
      },
      required: ['text'],
    },
    mutates: false,
    approval: 'always_allow',
    builtin: true,
    handler: () => 'Noted.',
  };
}
