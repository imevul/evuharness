import type {
  HarnessSettings,
  HarnessSettingsUpdate,
  ProviderProfile,
} from '@evu/harness-protocol';
import { ProviderSettings } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'local',
    label: 'Local llama.cpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3-30b',
    models: [],
    hasApiKey: false,
    supportsEffort: false,
    modelContextWindows: {},
    modelContextWindowOverrides: {},
    ...overrides,
  };
}

function settingsWith(
  providers: ProviderProfile[],
  activeProviderId: string | null = null,
): HarnessSettings {
  return {
    providers,
    activeProviderId,
    prompts: { global: '', perMode: {} },
    policies: { toolApprovals: {}, askUserEnabled: true, maxToolRounds: 12 },
    modes: ['ask', 'plan', 'agent'],
  };
}

function renderSettings(
  settings: HarnessSettings,
  onChange = vi.fn(async (_update: HarnessSettingsUpdate) => undefined),
) {
  const view = render(
    <ProviderSettings
      settings={settings}
      onChange={onChange}
      onTest={async () => ({ ok: true })}
      onListModels={async () => []}
    />,
  );
  return { view, onChange };
}

describe('ProviderSettings list', () => {
  it('marks the active profile and offers Use on the others', async () => {
    const settings = settingsWith([profile(), profile({ id: 'cloud', label: 'Cloud' })], 'local');
    const { onChange } = renderSettings(settings);

    const rows = document.querySelectorAll('[data-harness="provider-row"]');
    expect(rows[0]?.getAttribute('data-active')).toBe('true');
    expect(rows[1]?.getAttribute('data-active')).toBe('false');
    expect(screen.getAllByText('Active')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ activeProviderId: 'cloud' }));
  });

  it('shows the effective context window per row', () => {
    renderSettings(
      settingsWith([
        profile({ modelContextWindows: { 'qwen3-30b': 8_192 } }),
        profile({
          id: 'override',
          label: 'Override',
          modelContextWindows: { 'qwen3-30b': 8_192 },
          modelContextWindowOverrides: { 'qwen3-30b': 32_768 },
        }),
      ]),
    );

    expect(screen.getByText('8Ki ctx')).toBeTruthy();
    expect(screen.getByText('32Ki ctx')).toBeTruthy();
  });

  it('points at the empty state before anything is configured', () => {
    renderSettings(settingsWith([]));
    expect(screen.getByText(/No provider yet/)).toBeTruthy();
  });

  it('deletes only after the confirm dialog', async () => {
    const { onChange } = renderSettings(settingsWith([profile()], 'local'));

    fireEvent.click(screen.getByLabelText('Delete Local llama.cpp'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Delete Local llama.cpp?' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete provider' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ removeProviderIds: ['local'] }));
  });
});

describe('ProviderSettings form', () => {
  it('creates a profile through the modal and activates the first one', async () => {
    const { onChange } = renderSettings(settingsWith([]));

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Second box' } });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'http://10.0.0.2:8080/v1' },
    });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-oss-20b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and use' }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const update = onChange.mock.calls[0]?.[0];
    const written = update?.providers?.[0];

    expect(written?.label).toBe('Second box');
    expect(written?.baseUrl).toBe('http://10.0.0.2:8080/v1');
    expect(written?.model).toBe('gpt-oss-20b');
    // The first profile has to become active, or the demo has a provider it never uses.
    expect(update?.activeProviderId).toBe(written?.id);
  });

  it('expands k-notation and reports where the context window comes from', async () => {
    const { onChange } = renderSettings(
      settingsWith([profile({ modelContextWindows: { 'qwen3-30b': 8_192 } })], 'local'),
    );

    fireEvent.click(screen.getByLabelText('Edit Local llama.cpp'));

    const hint = () => document.querySelector('[data-harness="provider-context-hint"]');
    expect(hint()?.getAttribute('data-source')).toBe('catalog');
    expect(hint()?.textContent).toContain('From provider: 8Ki');

    const field = screen.getByLabelText('Max context tokens');
    fireEvent.change(field, { target: { value: '32Ki' } });
    expect(hint()?.getAttribute('data-source')).toBe('override');
    expect(hint()?.textContent).toContain('32,768');

    fireEvent.change(field, { target: { value: 'nonsense' } });
    expect(hint()?.getAttribute('data-source')).toBe('invalid');

    fireEvent.change(field, { target: { value: '32Ki' } });
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe('32768');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    const update = onChange.mock.calls[0]?.[0];
    expect(update?.providers?.[0]?.modelContextWindowOverrides).toEqual({ 'qwen3-30b': 32_768 });
    // Editing an existing profile must not silently re-point the active one.
    expect(update?.activeProviderId).toBeUndefined();
  });

  it('leaves a stored key alone unless clearing is explicit', async () => {
    const { onChange } = renderSettings(settingsWith([profile({ hasApiKey: true })], 'local'));

    fireEvent.click(screen.getByLabelText('Edit Local llama.cpp'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]?.[0]?.providers?.[0]).not.toHaveProperty('apiKey');

    fireEvent.click(screen.getByLabelText('Edit Local llama.cpp'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear stored key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange.mock.calls[1]?.[0]?.providers?.[0]?.apiKey).toBeNull();
  });

  it('cannot browse models for a profile that does not exist yet', () => {
    renderSettings(settingsWith([]));

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect((screen.getByRole('button', { name: 'Browse' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
