import { Modal } from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

function Body() {
  return (
    <>
      <input aria-label="First" />
      <button type="button">Last</button>
    </>
  );
}

describe('Modal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <Modal open={false} onClose={() => undefined} title="Hidden">
        <Body />
      </Modal>,
    );
    expect(container.querySelector('[data-harness="modal-panel"]')).toBeNull();
  });

  it('labels the dialog with its title and focuses the first control in the body', () => {
    render(
      <Modal open onClose={() => undefined} title="Pick a model">
        <Body />
      </Modal>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Pick a model' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('First'));
  });

  it('prefers an explicit autofocus target over the first control', () => {
    render(
      <Modal open onClose={() => undefined} title="Filtered">
        <input aria-label="First" />
        <input aria-label="Filter" data-autofocus />
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('Filter'));
  });

  it('closes on Escape, the backdrop, and the header button', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Closable">
        <Body />
      </Modal>,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('honours the dismissal opt-outs', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Sticky" closeOnEscape={false} closeOnBackdrop={false}>
        <Body />
      </Modal>,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('wraps Tab at both ends of the panel', () => {
    render(
      <Modal open onClose={() => undefined} title="Trapped">
        <Body />
      </Modal>,
    );

    const close = screen.getByLabelText('Close');
    const last = screen.getByRole('button', { name: 'Last' });

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the opener when it unmounts', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const view = render(
      <Modal open onClose={() => undefined} title="Transient">
        <Body />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('First'));

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
