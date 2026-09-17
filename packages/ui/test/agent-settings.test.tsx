import {
  type AgentProfile,
  emptyHarnessSettings,
  type HarnessSettings,
  type HarnessSettingsUpdate,
} from '@evu/harness-protocol';
import { AgentSettings } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { id: 'guide', label: 'Guide', soul: 'Be brief.', ...overrides };
}

function settingsWith(
  agents: AgentProfile[],
  activeAgentId: string | null = null,
): HarnessSettings {
  return { ...emptyHarnessSettings(), agents, activeAgentId };
}

describe('AgentSettings', () => {
  it('marks the active soul and offers Use on the others', async () => {
    const onChange = vi.fn(async (_update: HarnessSettingsUpdate) => undefined);
    render(
      <AgentSettings
        settings={settingsWith([agent(), agent({ id: 'poet', label: 'Poet' })], 'guide')}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByText('Active')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ activeAgentId: 'poet' }));
  });

  it('confirms delete before removing an agent', async () => {
    const onChange = vi.fn(async (_update: HarnessSettingsUpdate) => undefined);
    render(<AgentSettings settings={settingsWith([agent()], 'guide')} onChange={onChange} />);

    fireEvent.click(screen.getByText('✕'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ removeAgentIds: ['guide'] }));
  });
});
