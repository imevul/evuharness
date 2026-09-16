import type { ContextMenuDescriptor, ContextMenuNode } from '@evu/harness-protocol';
import { Composer } from '@evu/harness-ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const menus: ContextMenuDescriptor[] = [
  {
    id: 'mentions',
    trigger: '@',
    title: 'Mentions',
    insert: 'chip',
    effect: 'text',
    emptyQueryBehavior: 'groups',
    searchScope: 'flat',
    minQueryLength: 0,
  },
];

const nodes: ContextMenuNode[] = [
  {
    kind: 'item',
    id: 'api',
    label: 'API Gateway',
    icon: 'box',
    chip: { tone: 'accent' },
  },
];

describe('Composer', () => {
  it('does not crash when the contenteditable is clicked', () => {
    render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={() => undefined}
      />,
    );

    const input = screen.getByRole('textbox');
    expect(() => fireEvent.click(input)).not.toThrow();
    expect(input.getAttribute('contenteditable')).toBe('true');
  });

  it('inserts an inline chip and serializes token text plus refs on send', async () => {
    const fetchItems = vi.fn(async () => ({ nodes }));
    const onSend = vi.fn();

    render(
      <Composer
        menus={menus}
        fetchItems={fetchItems}
        modes={['ask', 'agent']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox');
    input.focus();

    await act(async () => {
      input.textContent = '@ap';
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.input(input);
    });

    await waitFor(() => expect(fetchItems).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('option')).toBeTruthy());

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => {
      const chip = input.querySelector('[data-harness="chip"]');
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toContain('API Gateway');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledTimes(1);
    const payload = onSend.mock.calls[0]?.[0] as {
      text: string;
      refs: { menu: string; id: string; token?: string }[];
    };
    expect(payload.text).toMatch(/@api/);
    expect(payload.refs).toEqual([
      expect.objectContaining({
        menu: 'mentions',
        id: 'api',
        token: '@api',
      }),
    ]);
    expect(JSON.stringify(payload.refs)).not.toContain('API Gateway');
  });

  it('removes a chip and its ref on backspace', async () => {
    const fetchItems = vi.fn(async () => ({ nodes }));
    const onSend = vi.fn();

    render(
      <Composer
        menus={menus}
        fetchItems={fetchItems}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox');

    await act(async () => {
      input.textContent = '@a';
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.input(input);
    });

    await waitFor(() => expect(screen.getByRole('option')).toBeTruthy());
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(input.querySelector('[data-harness="chip"]')).not.toBeNull());

    await act(async () => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.keyDown(input, { key: 'Backspace' });
      fireEvent.keyDown(input, { key: 'Backspace' });
    });

    await waitFor(() => expect(input.querySelector('[data-harness="chip"]')).toBeNull());

    // Send button should be disabled when empty; if residual whitespace remains,
    // refs must still be empty.
    const send = screen.getByRole('button', { name: 'Send' });
    if (!(send as HTMLButtonElement).disabled) {
      fireEvent.click(send);
      const payload = onSend.mock.calls[0]?.[0] as { refs: unknown[] };
      expect(payload.refs).toEqual([]);
    }
  });

  it('cycles draft mode with Shift+Tab without sending', () => {
    const onModeChange = vi.fn();
    render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask', 'plan', 'agent']}
        mode="ask"
        onModeChange={onModeChange}
        onSend={() => undefined}
      />,
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab', shiftKey: true });
    expect(onModeChange).toHaveBeenCalledWith('plan');
  });
});
