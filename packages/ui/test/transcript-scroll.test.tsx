import { isNearBottom, Transcript } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  cleanup();
});

describe('isNearBottom', () => {
  it('treats the last 64px as the bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 936, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 })).toBe(false);
  });

  it('is true when the content fits', () => {
    expect(isNearBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});

describe('Transcript scroll-to-latest', () => {
  it('shows the jump control after scrolling away, then pins again on click', () => {
    const { container } = render(
      <Transcript
        rows={[
          { kind: 'user', text: 'one' },
          { kind: 'assistant', text: 'two' },
        ]}
      />,
    );

    const scroller = container.querySelector('[data-harness="transcript"]');
    expect(scroller).not.toBeNull();
    if (scroller === null) {
      return;
    }

    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Scroll to latest' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest' }));
    expect(scrollTop).toBe(2000);
    expect(screen.queryByRole('button', { name: 'Scroll to latest' })).toBeNull();
  });

  it('keeps a live thinking pane pinned as tokens arrive', () => {
    const turn = (reasoning: string) => ({
      phase: 'thinking' as const,
      content: '',
      reasoning,
      tools: [] as const,
      mode: 'agent' as const,
    });

    const { container, rerender } = render(<Transcript rows={[]} turn={turn('first')} />);
    const pane = container.querySelector('[data-harness="reasoning"] pre');
    expect(pane).not.toBeNull();
    if (pane === null) {
      return;
    }

    let scrollTop = 0;
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => 800 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 240 });
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    rerender(<Transcript rows={[]} turn={turn('first then more thinking')} />);
    expect(scrollTop).toBe(800);

    scrollTop = 20;
    fireEvent.scroll(pane);
    rerender(<Transcript rows={[]} turn={turn('first then more thinking and still more')} />);
    expect(scrollTop).toBe(20);

    scrollTop = 560;
    fireEvent.scroll(pane);
    rerender(<Transcript rows={[]} turn={turn('first then more thinking and still more again')} />);
    expect(scrollTop).toBe(800);
  });

  it('renders host afterRow chrome on that persisted row', () => {
    const { container } = render(
      <Transcript
        rows={[
          { kind: 'assistant', text: 'hi' },
          { kind: 'user', text: 'follow-up' },
        ]}
        afterRow={(row) => (row.kind === 'assistant' ? <p>cards</p> : null)}
      />,
    );
    const rows = container.querySelectorAll('[data-harness="transcript-row"]');
    expect(rows[0]?.textContent).toContain('cards');
    expect(rows[1]?.textContent).not.toContain('cards');
  });

  it('keeps the jump control hidden while already at the bottom', () => {
    const { container } = render(<Transcript rows={[{ kind: 'assistant', text: 'hi' }]} />);
    const scroller = container.querySelector('[data-harness="transcript"]');
    expect(scroller).not.toBeNull();
    if (scroller === null) {
      return;
    }

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 1600 });
    fireEvent.scroll(scroller);

    expect(screen.queryByRole('button', { name: 'Scroll to latest' })).toBeNull();
  });
});
