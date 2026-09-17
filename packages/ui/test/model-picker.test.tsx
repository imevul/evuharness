import type { ModelCatalogEntry } from '@evu/harness-protocol';
import { ModelPickerField } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

const catalog: ModelCatalogEntry[] = [
  { id: 'qwen3-30b', contextWindow: 32_768 },
  { id: 'llama-3.1-8b' },
];

describe('ModelPickerField', () => {
  it('keeps the field free text', () => {
    const onChange = vi.fn();
    render(
      <ModelPickerField value="typed-model" onChange={onChange} loadModels={async () => []} />,
    );

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'not-in-catalog' } });
    expect(onChange).toHaveBeenCalledWith('not-in-catalog');
  });

  it('disables Browse and explains why when there is nothing to ask', () => {
    render(
      <ModelPickerField
        value="local-model"
        onChange={() => undefined}
        browseHint="Save the provider first."
      />,
    );

    expect((screen.getByRole('button', { name: 'Browse' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('Save the provider first.')).toBeTruthy();
  });

  it('loads on open and sets the field from a pick', async () => {
    const onChange = vi.fn();
    const loadModels = vi.fn(async () => catalog);
    render(<ModelPickerField value="qwen3-30b" onChange={onChange} loadModels={loadModels} />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(loadModels).toHaveBeenCalledTimes(1);

    // Context windows come back as k-notation so the number is readable at a glance.
    await waitFor(() => expect(screen.getByText('32Ki')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /llama-3\.1-8b/ }));
    expect(onChange).toHaveBeenCalledWith('llama-3.1-8b');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters the catalog as you type', async () => {
    render(
      <ModelPickerField value="" onChange={() => undefined} loadModels={async () => catalog} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect(screen.getByText('qwen3-30b')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'llama' } });
    expect(screen.queryByText('qwen3-30b')).toBeNull();
    expect(screen.getByText('llama-3.1-8b')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'nope' } });
    expect(screen.getByText(/No model matches/)).toBeTruthy();
  });

  it('reports an empty catalog and a failed load distinctly', async () => {
    const view = render(
      <ModelPickerField value="" onChange={() => undefined} loadModels={async () => []} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() =>
      expect(screen.getByText('This provider did not return any models.')).toBeTruthy(),
    );

    view.rerender(
      <ModelPickerField
        value=""
        onChange={() => undefined}
        loadModels={async () => {
          throw new Error('connection refused');
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect(screen.getByText('connection refused')).toBeTruthy());
  });
});
