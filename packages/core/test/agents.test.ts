import { resolveSessionAgents, soulsForPrompt } from '@evu/harness-core';
import type { AgentProfile } from '@evu/harness-protocol';
import { describe, expect, it } from 'vitest';

const agents: AgentProfile[] = [
  { id: 'guide', label: 'Guide', soul: 'Be careful.', active: true },
  { id: 'quiet', label: 'Quiet', soul: 'Stay quiet.', active: false },
  { id: 'poet', label: 'Poet', soul: 'Write verse.', active: true },
];

describe('resolveSessionAgents', () => {
  it('returns no soul when the session has no pin', () => {
    expect(resolveSessionAgents(agents, undefined)).toEqual([]);
  });

  it('returns the pinned agent even when it is inactive', () => {
    expect(resolveSessionAgents(agents, 'quiet').map((agent) => agent.id)).toEqual(['quiet']);
  });

  it('returns nothing for an unknown pin', () => {
    expect(resolveSessionAgents(agents, 'missing')).toEqual([]);
  });
});

describe('soulsForPrompt', () => {
  it('skips blank souls and uses the id when a label is missing', () => {
    expect(
      soulsForPrompt([
        { id: 'blank', soul: '   ', active: true },
        { id: 'raw', soul: 'Speak.', active: true },
      ]),
    ).toEqual([{ id: 'raw', label: 'raw', text: 'Speak.' }]);
  });
});
