import type { HarnessSettings, PromptPreview } from '@evu/harness-protocol';
import { PromptSettings } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

function baseSettings(overrides: Partial<HarnessSettings['prompts']> = {}): HarnessSettings {
  return {
    providers: [],
    activeProviderId: null,
    prompts: {
      global: 'You are helpful.',
      perMode: { ask: 'Be brief.' },
      ...overrides,
    },
    policies: {
      toolApprovals: {},
      askUserEnabled: true,
      maxToolRounds: 12,
    },
    modes: ['ask', 'plan', 'agent'],
  };
}

function previewFor(mode: string, text: string): PromptPreview {
  return {
    mode,
    sections: [{ id: 'global', label: 'Global', text, dynamic: false }],
    text,
  };
}

describe('PromptSettings', () => {
  it('loads a composed preview on mount and after save', async () => {
    let current = baseSettings();
    const loadPreview = vi.fn(async () => previewFor('ask', current.prompts.global));
    const onChange = vi.fn(async (update) => {
      current = {
        ...current,
        prompts: {
          global: update.prompts?.global ?? current.prompts.global,
          perMode: { ...current.prompts.perMode, ...update.prompts?.perMode },
        },
      };
    });

    const view = render(
      <PromptSettings settings={current} onChange={onChange} loadPreview={loadPreview} />,
    );

    await waitFor(() => {
      expect(screen.getByText('You are helpful.')).toBeTruthy();
    });
    expect(loadPreview).toHaveBeenCalledWith('ask');

    fireEvent.change(screen.getByLabelText('Global prompt'), {
      target: { value: 'Edited global.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save prompts' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        prompts: {
          global: 'Edited global.',
          perMode: { ask: 'Be brief.' },
        },
      });
    });

    view.rerender(
      <PromptSettings settings={current} onChange={onChange} loadPreview={loadPreview} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Edited global.')).toBeTruthy();
    });
  });

  it('patches only the selected mode when saving a per-mode prompt', async () => {
    const settings = baseSettings();
    const loadPreview = vi.fn(async (mode: string) => previewFor(mode, `mode=${mode}`));
    const onChange = vi.fn(async () => undefined);

    render(<PromptSettings settings={settings} onChange={onChange} loadPreview={loadPreview} />);

    await waitFor(() => expect(loadPreview).toHaveBeenCalledWith('ask'));

    fireEvent.change(screen.getByLabelText('Per-mode prompt (ask)'), {
      target: { value: 'Ship it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save prompts' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        prompts: {
          global: 'You are helpful.',
          perMode: { ask: 'Ship it.' },
        },
      });
    });
  });

  it('reloads preview when the mode selector changes', async () => {
    const settings = baseSettings();
    const loadPreview = vi.fn(async (mode: string) => previewFor(mode, `mode=${mode}`));

    render(
      <PromptSettings
        settings={settings}
        onChange={async () => undefined}
        loadPreview={loadPreview}
      />,
    );

    await waitFor(() => expect(loadPreview).toHaveBeenCalledWith('ask'));

    const modeSelect = document.querySelector<HTMLSelectElement>('[data-harness="prompt-mode"]');
    expect(modeSelect).not.toBeNull();
    fireEvent.change(modeSelect!, { target: { value: 'plan' } });

    await waitFor(() => {
      expect(modeSelect?.value).toBe('plan');
      expect(loadPreview).toHaveBeenCalledWith('plan');
    });
  });
});
