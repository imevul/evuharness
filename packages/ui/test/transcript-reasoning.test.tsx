import { Transcript } from '@evu/harness-ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('Transcript reasoning presentation', () => {
  it('renders live reasoning outside the assistant bubble', () => {
    const { container } = render(
      <Transcript
        rows={[]}
        turn={{
          phase: 'thinking',
          content: 'Hello',
          reasoning: 'step one',
          tools: [],
          mode: 'agent',
        }}
      />,
    );

    const reasoning = container.querySelector('[data-harness="reasoning"]');
    const bubble = container.querySelector('[data-harness="bubble"]');

    expect(reasoning).not.toBeNull();
    expect(reasoning?.textContent).toContain('Thinking');
    expect(reasoning?.textContent).toContain('step one');
    expect(reasoning?.hasAttribute('open')).toBe(true);
    expect(bubble?.textContent).toBe('Hello');
    expect(bubble?.textContent).not.toContain('step one');
  });

  it('renders completed reasoning collapsed and separate from prose', () => {
    const { container } = render(
      <Transcript
        rows={[
          {
            kind: 'assistant',
            text: 'Final answer',
            reasoning: 'I weighed alternatives',
          },
        ]}
      />,
    );

    const reasoning = container.querySelector('[data-harness="reasoning"]');
    const bubble = container.querySelector('[data-harness="bubble"]');

    expect(reasoning).not.toBeNull();
    expect(reasoning?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('I weighed alternatives')).toBeTruthy();
    expect(bubble?.textContent).toBe('Final answer');
    expect(bubble?.textContent).not.toContain('weighed');
  });

  it('hides the reasoning block when none was emitted', () => {
    const { container } = render(
      <Transcript rows={[{ kind: 'assistant', text: 'No thoughts shared' }]} />,
    );

    expect(container.querySelector('[data-harness="reasoning"]')).toBeNull();
    expect(screen.getByText('No thoughts shared')).toBeTruthy();
  });

  it('keeps a reasoning-only completed row without an empty bubble', () => {
    const { container } = render(
      <Transcript
        rows={[
          {
            kind: 'assistant',
            text: '',
            reasoning: 'only thinking so far',
            cancelled: true,
          },
        ]}
      />,
    );

    expect(container.querySelector('[data-harness="reasoning"]')).not.toBeNull();
    expect(container.querySelector('[data-harness="bubble"]')).toBeNull();
  });
});
