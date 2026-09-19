import type { ChatModeId } from '@evu/harness-protocol';
import { Composer } from '@evu/harness-ui';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

interface Options {
  mode?: ChatModeId;
  renderModeGlyph?: (mode: ChatModeId) => ReactNode;
}

function mount(options: Options = {}) {
  return render(
    <Composer
      menus={[]}
      fetchItems={vi.fn(async () => ({ nodes: [] }))}
      modes={['ask', 'plan', 'agent', 'review']}
      mode={options.mode ?? 'review'}
      onModeChange={() => undefined}
      onSend={() => undefined}
      {...(options.renderModeGlyph === undefined
        ? {}
        : { renderModeGlyph: options.renderModeGlyph })}
    />,
  );
}

function query(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (found === null) throw new Error(`${selector} not rendered`);
  return found as HTMLElement;
}

/** A host mark for `review` only, leaving the stock three to the library. */
const reviewOnly = (mode: ChatModeId): ReactNode =>
  mode === 'review' ? <svg data-harness="review-mark" /> : undefined;

describe('Composer renderModeGlyph', () => {
  /**
   * The gap this prop closes. Mode ids are open strings so hosts can register
   * their own, but the built-in glyphs cover only ask, plan, and agent — a
   * custom mode falls back to its first letter, which reads as a rendering bug
   * sitting next to three drawn marks.
   */
  it('falls back to a bare initial for a custom mode without the prop', () => {
    const { container } = mount();
    const chip = query(container, '[data-harness="mode-chip"]');

    expect(chip.textContent).toContain('r');
    expect(chip.querySelector('svg')).toBeNull();
  });

  it('uses the host mark for a custom mode', () => {
    const { container } = mount({ renderModeGlyph: reviewOnly });

    expect(
      query(container, '[data-harness="mode-chip"]').querySelector('[data-harness="review-mark"]'),
    ).not.toBeNull();
  });

  /**
   * `undefined` means "use the built-in", so a host supplying one mark does not
   * have to redraw the stock three. Without that, adopting the prop at all
   * would mean reimplementing glyphs the library already has.
   */
  it('keeps the built-in glyph when the host returns undefined', () => {
    const { container } = mount({ mode: 'plan', renderModeGlyph: reviewOnly });
    const chip = query(container, '[data-harness="mode-chip"]');

    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.querySelector('[data-harness="review-mark"]')).toBeNull();
  });

  /** `null` is distinct from `undefined`: a host may want text alone. */
  it('draws no mark when the host returns null', () => {
    const { container } = mount({ renderModeGlyph: () => null });
    const chip = query(container, '[data-harness="mode-chip"]');

    expect(chip.querySelector('svg')).toBeNull();
    expect(chip.textContent).toContain('Review');
  });

  // `plan` rather than `agent`: agent is the unmarked mode in inlaid chrome, so
  // it paints no chip at all and there would be nothing to assert against.
  it('overrides a built-in glyph when the host chooses to', () => {
    const { container } = mount({
      mode: 'plan',
      renderModeGlyph: () => <svg data-harness="host-mark" />,
    });

    expect(
      query(container, '[data-harness="mode-chip"]').querySelector('[data-harness="host-mark"]'),
    ).not.toBeNull();
  });

  /**
   * The add menu lists the same modes as the chip. If only the chip honoured
   * the prop, a custom mode would show a drawn mark in one place and a letter
   * in the other — exactly the inconsistency this is meant to remove.
   */
  it('uses the host mark for mode rows in the add menu too', async () => {
    const { container } = mount({ mode: 'agent', renderModeGlyph: reviewOnly });

    await act(async () => {
      fireEvent.click(query(container, '[data-harness="composer-add-trigger"]'));
    });

    const menu = query(container, '[data-harness="composer-add-menu"]');
    expect(menu.querySelector('[data-harness="review-mark"]')).not.toBeNull();
  });
});
