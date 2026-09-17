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
