import {
  emptyHarnessSettings,
  type HarnessSettings,
  type PromptPreview,
} from '@evu/harness-protocol';
import { PromptSettings } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

function baseSettings(overrides: Partial<HarnessSettings['prompts']> = {}): HarnessSettings {
  return {
    ...emptyHarnessSettings(),
    prompts: {
      global: 'You are helpful.',
      perMode: { ask: 'Be brief.' },
      ...overrides,
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

  it('gates Save and Reset on a real edit, and marks the preview as stale', async () => {
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

    const save = screen.getByRole('button', { name: 'Save prompts' }) as HTMLButtonElement;
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
    expect(document.querySelector('[data-harness="prompt-preview-stale"]')).toBeNull();

    const field = screen.getByLabelText('Global prompt');
    fireEvent.change(field, { target: { value: 'Edited.' } });
    expect(save.disabled).toBe(false);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(document.querySelector('[data-harness="prompt-preview-stale"]')).not.toBeNull();

    fireEvent.click(reset);
    expect((field as HTMLTextAreaElement).value).toBe('You are helpful.');
    expect(save.disabled).toBe(true);
  });

  it('marks modes that already carry text', async () => {
    render(
      <PromptSettings
        settings={baseSettings()}
        onChange={async () => undefined}
        loadPreview={async (mode) => previewFor(mode, 'x')}
      />,
    );

    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>('[data-harness="prompt-mode"] option'),
    ).map((option) => option.textContent);
    expect(options).toEqual(['ask (set)', 'plan', 'agent']);
  });

  it('switches the preview between sections and the assembled text', async () => {
    render(
      <PromptSettings
        settings={baseSettings()}
        onChange={async () => undefined}
        loadPreview={async (mode) => ({
          mode,
          sections: [
            { id: 'global', label: 'Global', text: 'Section text.', dynamic: false },
            { id: 'now', label: 'Date', text: 'Today.', dynamic: true },
          ],
          text: 'Section text.\n\nToday.',
        })}
      />,
    );

    await waitFor(() => expect(screen.getByText('Section text.')).toBeTruthy());
    expect(screen.getByText('dynamic')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Assembled' }));
    const assembled = document.querySelector('[data-harness="prompt-assembled"] pre');
    expect(assembled?.textContent).toBe('Section text.\n\nToday.');
    expect(screen.queryByText('dynamic')).toBeNull();
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
