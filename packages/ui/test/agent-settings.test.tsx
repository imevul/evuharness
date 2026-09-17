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
  return { id: 'guide', label: 'Guide', soul: 'Be brief.', active: true, ...overrides };
}

function settingsWith(agents: AgentProfile[]): HarnessSettings {
  return { ...emptyHarnessSettings(), agents };
}

describe('AgentSettings', () => {
  it('toggles an agent active without a Use control', async () => {
    const onChange = vi.fn(async (_update: HarnessSettingsUpdate) => undefined);
    render(
      <AgentSettings
        settings={settingsWith([
          agent({ active: true }),
          agent({ id: 'poet', label: 'Poet', active: false }),
        ])}
        onChange={onChange}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Poet' }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        agents: [expect.objectContaining({ id: 'poet', active: true })],
      }),
    );
  });

  it('confirms delete before removing an agent', async () => {
    const onChange = vi.fn(async (_update: HarnessSettingsUpdate) => undefined);
    render(
      <AgentSettings settings={settingsWith([agent({ active: true })])} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText('✕'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ removeAgentIds: ['guide'] }));
  });
});
