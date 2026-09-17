import type { MemoryEntry, MemoryEntryWrite } from '@evu/harness-protocol';
import { MemorySettings } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1',
    title: 'Decision',
    body: 'Prefer list/call MCP.',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderMemory(
  memories: MemoryEntry[] = [],
  userText = '',
  handlers: {
    onSaveUser?: (text: string) => Promise<void>;
    onSearch?: (query: string) => Promise<void>;
    onSaveMemory?: (write: MemoryEntryWrite) => Promise<void>;
    onDelete?: (id: string) => Promise<void>;
  } = {},
) {
  const onSaveUser = handlers.onSaveUser ?? vi.fn(async () => undefined);
  const onSearch = handlers.onSearch ?? vi.fn(async () => undefined);
  const onSaveMemory = handlers.onSaveMemory ?? vi.fn(async () => undefined);
  const onDelete = handlers.onDelete ?? vi.fn(async () => undefined);
  render(
    <MemorySettings
      userText={userText}
      memories={memories}
      onSaveUser={onSaveUser}
      onSearch={onSearch}
      onSaveMemory={onSaveMemory}
      onDelete={onDelete}
    />,
  );
  return { onSaveUser, onSearch, onSaveMemory, onDelete };
}

describe('MemorySettings', () => {
  it('splits USER.md and MEMORY into two panels', () => {
    renderMemory();
    expect(document.querySelector('[data-harness="memory-user"]')).not.toBeNull();
    expect(document.querySelector('[data-harness="memory-list"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'USER.md' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'MEMORY' })).toBeTruthy();
  });

  it('saves a dirty USER.md draft', async () => {
    const { onSaveUser } = renderMemory([], 'old');
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'Name: Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save USER.md' }));
    await waitFor(() => expect(onSaveUser).toHaveBeenCalledWith('Name: Ada'));
  });

  it('adds a memory through the modal', async () => {
    const { onSaveMemory } = renderMemory();
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Note' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Ship it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSaveMemory).toHaveBeenCalledWith({ title: 'Note', body: 'Ship it.' }),
    );
  });

  it('confirms delete before removing a row', async () => {
    const { onDelete } = renderMemory([entry()]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Decision' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('m1'));
  });
});
