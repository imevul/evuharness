import { BUILTIN_TOOL_NAMES } from '@evu/harness-protocol';
import type { ToolDefinition } from './tools.js';

/**
 * Runtime-owned gate tools.
 *
 * Registered so modes can offer them to the model. The turn loop intercepts
 * these names before the handler runs; the handlers exist only as a safe
 * fallback if a host somehow executes them outside the loop.
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
  ];
}
