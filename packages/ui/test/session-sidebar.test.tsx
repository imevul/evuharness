import { SessionSidebar } from '@evu/harness-ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

describe('SessionSidebar', () => {
  it('keeps the full title available when the label is long', () => {
    const title = 'Find the current population of Sundsvall and nearby towns';
    render(
      <SessionSidebar
        sessions={[
          {
            id: 's1',
            title,
            mode: 'agent',
            createdAt: '2026-09-17T01:00:00.000Z',
            updatedAt: '2026-09-17T01:00:00.000Z',
            usage: { promptTokensTotal: 0, completionTokensTotal: 0, lastPromptTokens: 0 },
          },
        ]}
        activeId="s1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText(title).getAttribute('title')).toBe(title);
    expect(screen.getByRole('button', { name: `Delete ${title}` })).toBeTruthy();
  });
});
