import type { ProviderProfile } from '@evu/harness-protocol';
import { StatusBar } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

const usage = { promptTokensTotal: 12_400, completionTokensTotal: 10, lastPromptTokens: 12_400 };

const profiles: ProviderProfile[] = [
  {
    id: 'local',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3-30b',
    models: [],
    hasApiKey: false,
    supportsEffort: false,
    supportsReasoning: false,
    timeoutMs: 120_000,
    modelContextWindows: {},
    modelContextWindowOverrides: {},
    active: true,
  },
];

describe('StatusBar', () => {
  it('omits the donut when no max is known', () => {
    render(<StatusBar provider={{ id: 'local', model: 'm' }} usage={usage} />);

    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText('m')).toBeTruthy();
    expect(document.querySelector('[data-harness="status-donut"]')).toBeNull();
  });

  it('shows a custom tooltip, not a native title', () => {
    render(
      <StatusBar
        provider={{ id: 'local', label: 'Local', model: 'm', contextWindow: 32_768 }}
        usage={usage}
      />,
    );

    const donut = screen.getByRole('button');
    expect(donut.getAttribute('title')).toBeNull();
    fireEvent.focus(donut);
    expect(screen.getByRole('tooltip').textContent).toMatch(
      /Context: 12[,.]?400 \/ 32[,.]?768 \(38%\)/,
    );
  });

  it('surfaces an effective effort override', () => {
    render(<StatusBar provider={{ id: 'local', model: 'm', effort: 'high' }} usage={usage} />);
    expect(screen.getByText('high')).toBeTruthy();
  });

  it('stays display-only without a change callback', () => {
    render(<StatusBar provider={{ id: 'local', model: 'm' }} usage={usage} providers={profiles} />);
    expect(document.querySelector('[data-harness="status-provider-trigger"]')).toBeNull();
  });
});

describe('StatusBar provider picker', () => {
  function renderPicker(override: Parameters<typeof StatusBar>[0]['override'] = null) {
    const onProviderChange = vi.fn();
    const onListModels = vi.fn(async () => [
      { id: 'qwen3-30b', contextWindow: 32_768 },
      { id: 'gpt-oss-20b' },
    ]);
    render(
      <StatusBar
        provider={{ id: 'local', label: 'Local', model: 'qwen3-30b' }}
        usage={usage}
        providers={profiles}
        override={override}
        onProviderChange={onProviderChange}
        onListModels={onListModels}
      />,
    );
    return { onProviderChange, onListModels };
  }

  it('opens a menu of the current provider, model, and context', () => {
    renderPicker();

    const trigger = screen.getByRole('button', { name: /Local/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Provider for this chat' })).toBeTruthy();

    // Each row states its value in place, so reading needs no further clicks.
    expect(screen.getByRole('button', { name: /Provider.*Local/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Model.*qwen3-30b/ })).toBeTruthy();
  });

  /** The status bar readout repeats the same names, so options are queried in scope. */
  function flyout() {
    const element = document.querySelector<HTMLElement>('[data-harness="provider-menu-flyout"]');
    if (element === null) throw new Error('no flyout is open');
    return within(element);
  }

  function optionLabels() {
    return Array.from(document.querySelectorAll('[data-harness="provider-menu-option-label"]')).map(
      (node) => node.textContent,
    );
  }

  it('picks a provider from the flyout and drops a pinned model with it', () => {
    const { onProviderChange } = renderPicker({ providerId: 'other', model: 'stale-model' });

    fireEvent.click(screen.getByRole('button', { name: /Local/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Provider/ }));
    fireEvent.click(flyout().getByRole('button', { name: /Local/ }));

    // The model goes with it: a model id only means something on the box serving it.
    expect(onProviderChange).toHaveBeenCalledWith({ providerId: 'local' });
  });

  it('marks the readout while an override is in force', () => {
    renderPicker({ providerId: 'local' });
    const trigger = screen.getByRole('button', { name: /Local/ });
    expect(trigger.getAttribute('data-overridden')).toBe('true');
  });

  it('fetches the chosen provider models when the model row opens', async () => {
    const { onProviderChange, onListModels } = renderPicker();

    fireEvent.click(screen.getByRole('button', { name: /Local/ }));
    expect(onListModels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Model/ }));
    expect(onListModels).toHaveBeenCalledWith('local');

    await waitFor(() => expect(optionLabels()).toEqual(['Default', 'qwen3-30b', 'gpt-oss-20b']));
    expect(flyout().getByText('32Ki')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'oss' } });
    expect(optionLabels()).toEqual(['Default', 'gpt-oss-20b']);

    fireEvent.click(flyout().getByRole('button', { name: /gpt-oss-20b/ }));
    expect(onProviderChange).toHaveBeenCalledWith({ model: 'gpt-oss-20b' });
  });

  it('clears the whole override from the reset row', () => {
    const { onProviderChange } = renderPicker({ model: 'gpt-oss-20b' });

    fireEvent.click(screen.getByRole('button', { name: /Local/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the settings default' }));
    expect(onProviderChange).toHaveBeenCalledWith(null);
  });

  it('backs out of a flyout on Escape before closing the menu', async () => {
    renderPicker();

    const trigger = screen.getByRole('button', { name: /Local/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /^Model/ }));
    await waitFor(() => expect(screen.getByLabelText('Search models')).toBeTruthy());

    fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' });
    expect(screen.queryByLabelText('Search models')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and on a click outside', () => {
    renderPicker();
    const trigger = screen.getByRole('button', { name: /Local/ });

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('disables the trigger when there is nothing to pin an override to', () => {
    render(
      <StatusBar
        provider={null}
        usage={usage}
        providers={profiles}
        pickerDisabled
        onProviderChange={() => undefined}
      />,
    );

    expect(
      (screen.getByRole('button', { name: /No provider/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('hides inactive providers from the picker', async () => {
    render(
      <StatusBar
        provider={{ id: 'local', label: 'Local', model: 'qwen3-30b' }}
        usage={usage}
        providers={[
          ...profiles,
          {
            ...profiles[0]!,
            id: 'asleep',
            label: 'Asleep',
            active: false,
          },
        ]}
        onProviderChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Local/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Provider/ }));
    expect(optionLabels()).toContain('Local');
    expect(optionLabels()).not.toContain('Asleep');
  });
});

describe('StatusBar agent picker', () => {
  it('pins one agent and can return to Default', () => {
    const onAgentChange = vi.fn();
    render(
      <StatusBar
        provider={{ id: 'local', model: 'm' }}
        usage={usage}
        agents={[
          { id: 'guide', label: 'Guide', soul: 'a', active: true },
          { id: 'poet', label: 'Poet', soul: 'b', active: true },
        ]}
        agentId={null}
        onAgentChange={onAgentChange}
      />,
    );

    expect(screen.getByText('None')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /None/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Poet' }));
    expect(onAgentChange).toHaveBeenCalledWith('poet');
  });

  it('clears the session pin from None', () => {
    const onAgentChange = vi.fn();
    render(
      <StatusBar
        provider={{ id: 'local', model: 'm' }}
        usage={usage}
        agents={[{ id: 'guide', label: 'Guide', soul: 'a', active: true }]}
        agentId="guide"
        onAgentChange={onAgentChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Guide/ }));
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(onAgentChange).toHaveBeenCalledWith(null);
  });

  it('omits inactive agents unless they are the session pin', () => {
    const onAgentChange = vi.fn();
    render(
      <StatusBar
        provider={{ id: 'local', model: 'm' }}
        usage={usage}
        agents={[
          { id: 'guide', label: 'Guide', soul: 'a', active: true },
          { id: 'quiet', label: 'Quiet', soul: 'b', active: false },
        ]}
        agentId={null}
        onAgentChange={onAgentChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /None/ }));
    expect(screen.getByRole('option', { name: 'Guide' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Quiet' })).toBeNull();
  });
});
