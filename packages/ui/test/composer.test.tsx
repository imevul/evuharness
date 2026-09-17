import type { ContextMenuDescriptor, ContextMenuNode } from '@evu/harness-protocol';
import { Composer } from '@evu/harness-ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

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

/**
 * Assign a live FileList and fire change. Clearing `input.value` must empty
 * this list, matching a real file input.
 */
function chooseFiles(input: HTMLInputElement, files: File[]) {
  let current = files.slice();
  const list = {
    get length() {
      return current.length;
    },
    item(index: number) {
      return current[index] ?? null;
    },
    *[Symbol.iterator]() {
      yield* current;
    },
  } as FileList;

  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => list,
  });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => (current.length === 0 ? '' : `C:\\fakepath\\${current[0]?.name ?? ''}`),
    set: (next: string) => {
      if (next === '') current = [];
    },
  });
  fireEvent.change(input);
}

function typeTrigger(input: HTMLElement, text: string) {
  input.focus();
  input.textContent = text;
  const selection = window.getSelection();
  const range = document.createRange();
  const textNode = input.firstChild;
  if (textNode !== null && textNode.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, text.length);
    range.collapse(true);
  } else {
    range.selectNodeContents(input);
    range.collapse(false);
  }
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.input(input);
}

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
        menuDebounceMs={0}
      />,
    );

    const input = screen.getByRole('textbox');

    await act(async () => {
      typeTrigger(input, '@ap');
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
        menuDebounceMs={0}
      />,
    );

    const input = screen.getByRole('textbox');

    await act(async () => {
      typeTrigger(input, '@a');
    });

    await waitFor(() => expect(screen.getByRole('option')).toBeTruthy());
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(input.querySelector('[data-harness="chip"]')).not.toBeNull());

    await act(async () => {
      const chip = input.querySelector('[data-harness="chip"]');
      expect(chip).not.toBeNull();
      // Drop the trailing space paint left after the chip, then put the caret
      // immediately after the chip so Backspace hits deleteChipBeforeCaret.
      for (const child of Array.from(input.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          child.textContent = '';
        }
      }
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStartAfter(chip as Node);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.keyDown(input, { key: 'Backspace' });
    });

    await waitFor(() => expect(input.querySelector('[data-harness="chip"]')).toBeNull());

    const send = screen.getByRole('button', { name: 'Send' });
    if (!(send as HTMLButtonElement).disabled) {
      fireEvent.click(send);
      const payload = onSend.mock.calls[0]?.[0] as { refs: unknown[] };
      expect(payload.refs).toEqual([]);
    }
  });

  it('removes a chip from its trailing x control without sending', async () => {
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
        menuDebounceMs={0}
      />,
    );

    const input = screen.getByRole('textbox');
    await act(async () => {
      typeTrigger(input, '@a');
    });
    await waitFor(() => expect(screen.getByRole('option')).toBeTruthy());
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove API Gateway' })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove API Gateway' }));
    await waitFor(() => expect(input.querySelector('[data-harness="chip"]')).toBeNull());
    expect(onSend).not.toHaveBeenCalled();
  });

  it('inserts a markdown chip from a live FileList after the input resets', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
        attachmentsEnabled
      />,
    );

    const fileInput = container.querySelector('[data-harness="composer-attach-input"]');
    if (!(fileInput instanceof HTMLInputElement)) {
      return;
    }

    const file = new File(['# Hello'], 'notes.md', { type: 'text/markdown' });
    await act(async () => {
      chooseFiles(fileInput, [file]);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-kind="attachment"]')?.textContent).toContain(
        'notes.md',
      );
    });
    expect(fileInput.files).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ name: 'notes.md', text: '# Hello' })],
      }),
    );
  });

  it('removes an attachment chip from its trailing x control', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
        attachmentsEnabled
      />,
    );

    const fileInput = container.querySelector('[data-harness="composer-attach-input"]');
    if (!(fileInput instanceof HTMLInputElement)) {
      return;
    }

    await act(async () => {
      chooseFiles(fileInput, [new File(['# Hello'], 'notes.md', { type: 'text/markdown' })]);
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove notes.md' })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }));
    await waitFor(() => expect(container.querySelector('[data-kind="attachment"]')).toBeNull());
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('inserts an attachment chip and forwards it on send', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
        attachmentsEnabled
      />,
    );

    const fileInput = container.querySelector('[data-harness="composer-attach-input"]');
    expect(fileInput).not.toBeNull();
    if (!(fileInput instanceof HTMLInputElement)) {
      return;
    }

    const file = new File(['hello notes'], 'notes.txt', { type: 'text/plain' });
    await act(async () => {
      chooseFiles(fileInput, [file]);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-kind="attachment"]')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            kind: 'file',
            name: 'notes.txt',
            text: 'hello notes',
          }),
        ],
      }),
    );
  });

  it('paints a chip for file text that would be illegal in a data-* attribute', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
        attachmentsEnabled
      />,
    );

    const fileInput = container.querySelector('[data-harness="composer-attach-input"]');
    expect(fileInput).toBeInstanceOf(HTMLInputElement);
    if (!(fileInput instanceof HTMLInputElement)) {
      return;
    }

    const body = 'line one\nline two\u0001quotes "and" <tags>';
    const file = new File([body], 'awkward.md', { type: 'text/markdown' });
    await act(async () => {
      chooseFiles(fileInput, [file]);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-kind="attachment"]')).not.toBeNull();
    });
    const chip = container.querySelector('[data-kind="attachment"]');
    expect(chip?.getAttribute('data-text')).toBeNull();
    expect(chip?.textContent).toContain('awkward.md');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ name: 'awkward.md', text: body })],
      }),
    );
  });

  it('keeps an image payload off the chip and still sends the data URL', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
        attachmentsEnabled
      />,
    );

    const fileInput = container.querySelector('[data-harness="composer-attach-input"]');
    if (!(fileInput instanceof HTMLInputElement)) {
      return;
    }

    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
      type: 'image/png',
    });
    await act(async () => {
      chooseFiles(fileInput, [file]);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-kind="attachment"]')).not.toBeNull();
    });
    expect(
      container.querySelector('[data-kind="attachment"]')?.getAttribute('data-url'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const payload = onSend.mock.calls[0]?.[0] as { attachments: { url?: string; name: string }[] };
    expect(payload.attachments[0]?.name).toBe('shot.png');
    expect(payload.attachments[0]?.url?.startsWith('data:image/png')).toBe(true);
  });

  it('picks an action item without inserting a chip or sending', async () => {
    const fetchItems = vi.fn(async () => ({
      nodes: [
        {
          kind: 'item' as const,
          id: 'model',
          label: 'model',
          action: 'open-model-picker',
        },
      ],
    }));
    const onSend = vi.fn();
    const onAction = vi.fn();

    render(
      <Composer
        menus={[
          {
            id: 'commands',
            trigger: '/',
            title: 'Commands',
            insert: 'chip',
            effect: 'prompt',
            emptyQueryBehavior: 'flat',
            searchScope: 'flat',
            minQueryLength: 0,
          },
        ]}
        fetchItems={fetchItems}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={onSend}
        onAction={onAction}
        menuDebounceMs={0}
      />,
    );

    const input = screen.getByRole('textbox');
    await act(async () => {
      typeTrigger(input, '/mod');
    });
    await waitFor(() => expect(screen.getByRole('option')).toBeTruthy());

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => expect(onAction).toHaveBeenCalledWith('open-model-picker'));
    expect(input.querySelector('[data-harness="chip"]')).toBeNull();
    expect(input.textContent ?? '').not.toContain('/mod');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('hides the inlaid mode chip on agent and shows it for plan', () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask', 'plan', 'agent']}
        mode="agent"
        onModeChange={onModeChange}
        onSend={() => undefined}
      />,
    );

    expect(document.querySelector('[data-harness="composer"]')?.getAttribute('data-chrome')).toBe(
      'inlaid',
    );
    expect(document.querySelector('[data-harness="composer"]')?.getAttribute('data-layout')).toBe(
      'single',
    );
    expect(document.querySelector('[data-harness="mode-chip"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();

    rerender(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask', 'plan', 'agent']}
        mode="plan"
        onModeChange={onModeChange}
        onSend={() => undefined}
      />,
    );

    expect(document.querySelector('[data-harness="mode-chip"]')?.getAttribute('data-mode')).toBe(
      'plan',
    );
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
    expect(document.querySelector('[data-harness="mode-chip-label"] svg')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use agent mode' }));
    expect(onModeChange).toHaveBeenCalledWith('agent');
  });

  it('switches inlaid chrome to a stacked layout after a newline', () => {
    render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['agent']}
        mode="agent"
        onModeChange={() => undefined}
        onSend={() => undefined}
      />,
    );

    const root = document.querySelector('[data-harness="composer"]');
    expect(root?.getAttribute('data-layout')).toBe('single');

    const input = screen.getByRole('textbox');
    typeTrigger(input, 'hello\nworld');
    expect(root?.getAttribute('data-layout')).toBe('multi');
  });

  it('stays single-line after inserting a chip and pressing backspace', async () => {
    const fetchItems = vi.fn(async () => ({
      nodes: [{ kind: 'item' as const, id: 'readme', label: 'README.md' }],
    }));

    render(
      <Composer
        menus={[
          {
            id: 'mentions',
            trigger: '@',
            title: 'Mentions',
            insert: 'chip',
            effect: 'prompt',
            emptyQueryBehavior: 'flat',
            searchScope: 'flat',
            minQueryLength: 0,
          },
        ]}
        fetchItems={fetchItems}
        modes={['agent']}
        mode="agent"
        onModeChange={() => undefined}
        onSend={() => undefined}
        menuDebounceMs={0}
      />,
    );

    const root = document.querySelector('[data-harness="composer"]');
    const input = screen.getByRole('textbox');

    await act(async () => {
      typeTrigger(input, '@re');
    });
    await waitFor(() => expect(screen.getByRole('option')).toBeTruthy());
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(input.querySelector('[data-harness="chip"]')).not.toBeNull());
    expect(root?.getAttribute('data-layout')).toBe('single');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Backspace' });
    });
    expect(input.querySelector('[data-harness="chip"]')).not.toBeNull();
    expect(root?.getAttribute('data-layout')).toBe('single');
  });

  it('stays single-line when backspace is pressed on an empty draft', () => {
    render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['agent']}
        mode="agent"
        onModeChange={() => undefined}
        onSend={() => undefined}
      />,
    );

    const root = document.querySelector('[data-harness="composer"]');
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    typeTrigger(input, '\n');
    expect(root?.getAttribute('data-layout')).toBe('single');
  });

  it('inserts a catalog trigger from the add menu', async () => {
    const fetchItems = vi.fn(async () => ({
      nodes: [{ kind: 'item' as const, id: 'doctor', label: 'doctor' }],
    }));

    render(
      <Composer
        menus={[
          {
            id: 'commands',
            trigger: '/',
            title: 'Commands',
            insert: 'chip',
            effect: 'prompt',
            emptyQueryBehavior: 'flat',
            searchScope: 'flat',
            minQueryLength: 0,
          },
        ]}
        fetchItems={fetchItems}
        modes={['agent']}
        mode="agent"
        onModeChange={() => undefined}
        onSend={() => undefined}
        menuDebounceMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search' }));
    expect(
      screen
        .getByRole('option', { name: 'Commands' })
        .querySelector('[data-harness="composer-add-icon"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Commands' }));

    await waitFor(() => expect(fetchItems).toHaveBeenCalled());
    expect(screen.getByRole('textbox').textContent).toContain('/');
  });

  it('filters add-menu rows and inserts a catalog hit from search', async () => {
    const fetchItems = vi.fn(async (_menuId: string, request: { query: string }) => ({
      nodes:
        request.query === ''
          ? []
          : [
              {
                kind: 'item' as const,
                id: 'doctor',
                label: 'doctor',
                icon: 'search',
                hint: 'Look something up',
              },
            ],
    }));
    const onAction = vi.fn();

    render(
      <Composer
        menus={[
          {
            id: 'commands',
            trigger: '/',
            title: 'Commands',
            insert: 'chip',
            effect: 'prompt',
            emptyQueryBehavior: 'flat',
            searchScope: 'flat',
            minQueryLength: 0,
          },
        ]}
        fetchItems={fetchItems}
        modes={['ask', 'plan', 'agent']}
        mode="agent"
        onModeChange={() => undefined}
        onSend={() => undefined}
        onAction={onAction}
        menuDebounceMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'doc' },
    });

    await waitFor(() => expect(screen.getByRole('option', { name: /doctor/ })).toBeTruthy());
    expect(
      screen
        .getByRole('option', { name: /doctor/ })
        .querySelector('[data-harness="composer-add-icon"]')?.textContent,
    ).toBe('/');
    expect(screen.queryByRole('option', { name: 'Ask' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Plan' })).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: /doctor/ }));
    await waitFor(() =>
      expect(
        screen.getByRole('textbox').querySelector('[data-harness="chip"]')?.textContent,
      ).toContain('doctor'),
    );
    expect(onAction).not.toHaveBeenCalled();
  });

  it('fires onAction when a searched add-menu item declares action', async () => {
    const fetchItems = vi.fn(async () => ({
      nodes: [
        {
          kind: 'item' as const,
          id: 'model',
          label: 'model',
          action: 'open-model-picker',
        },
      ],
    }));
    const onAction = vi.fn();

    render(
      <Composer
        menus={[
          {
            id: 'commands',
            trigger: '/',
            title: 'Commands',
            insert: 'chip',
            effect: 'prompt',
            emptyQueryBehavior: 'flat',
            searchScope: 'flat',
            minQueryLength: 0,
          },
        ]}
        fetchItems={fetchItems}
        modes={['agent']}
        mode="agent"
        onModeChange={() => undefined}
        onSend={() => undefined}
        onAction={onAction}
        menuDebounceMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'model' },
    });
    await waitFor(() => expect(screen.getByRole('option', { name: /model/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: /model/ }));
    expect(onAction).toHaveBeenCalledWith('open-model-picker');
    expect(screen.getByRole('textbox').textContent ?? '').not.toContain('/model');
  });

  it('fires onAction when a searched add-menu plan item is picked', async () => {
    const fetchItems = vi.fn(async () => ({
      nodes: [
        {
          kind: 'item' as const,
          id: 'plan',
          label: 'plan',
          action: 'switch-to-plan-mode',
        },
      ],
    }));
    const onAction = vi.fn();
    const onModeChange = vi.fn();

    render(
      <Composer
        menus={[
          {
            id: 'commands',
            trigger: '/',
            title: 'Commands',
            insert: 'chip',
            effect: 'prompt',
            emptyQueryBehavior: 'flat',
            searchScope: 'flat',
            minQueryLength: 0,
          },
        ]}
        fetchItems={fetchItems}
        modes={['ask', 'plan', 'agent']}
        mode="agent"
        onModeChange={onModeChange}
        onSend={() => undefined}
        onAction={onAction}
        menuDebounceMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'plan' },
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-harness="composer-add-item"][data-kind="item"]'),
      ).not.toBeNull(),
    );
    const hit = document.querySelector('[data-harness="composer-add-item"][data-kind="item"]');
    expect(hit).not.toBeNull();
    if (hit !== null) {
      fireEvent.click(hit);
    }
    expect(onAction).toHaveBeenCalledWith('switch-to-plan-mode');
    expect(onModeChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox').querySelector('[data-harness="chip"]')).toBeNull();
  });

  it('keeps the original action row when chrome is bar', () => {
    render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={() => undefined}
        chrome="bar"
        attachmentsEnabled
      />,
    );

    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).textContent).toContain('Send');
    expect(document.querySelector('[data-harness="composer"]')?.getAttribute('data-chrome')).toBe(
      'bar',
    );
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
