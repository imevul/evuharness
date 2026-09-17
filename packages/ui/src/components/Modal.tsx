import { type ReactNode, useEffect, useId, useRef } from 'react';
import { FOCUSABLE_SELECTOR, trapTabKey } from '../focus-trap.js';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Actions row. Omitted for a dialog whose body owns its own buttons. */
  footer?: ReactNode;
  /** False while a decision is pending, so Escape cannot skip it. Default true. */
  closeOnEscape?: boolean;
  /** False when a stray click must not discard input. Default true. */
  closeOnBackdrop?: boolean;
  className?: string;
}

/**
 * A modal dialog.
 *
 * Structure and behavior only, like every other part of this kit: focus handling,
 * Escape, and the ARIA wiring live here; size, backdrop, and elevation are the
 * host's CSS against the `data-harness` hooks.
 *
 * The gates are intentionally not built on this. A queued tool approval has to stay
 * visible behind whatever else is open, which a dialog stack cannot do.
 */
export function Modal(props: ModalProps) {
  const {
    open,
    onClose,
    title,
    children,
    footer,
    closeOnEscape = true,
    closeOnBackdrop = true,
    className,
  } = props;

  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Read through refs inside the effect so a parent re-render — a settings refetch,
  // an inline arrow prop — cannot re-run initial focus and yank the caret mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;

  useEffect(() => {
    if (!open) return;

    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const panel = panelRef.current;
    const body = panel?.querySelector<HTMLElement>('[data-harness="modal-body"]') ?? null;
    const preferred =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      body?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      panel;
    preferred?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (closeOnEscapeRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key === 'Tab') {
        trapTabKey(event, panel);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      restoreRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className={className} data-harness="modal">
      <button
        type="button"
        tabIndex={-1}
        data-harness="modal-backdrop"
        aria-label="Close dialog"
        onClick={() => {
          if (closeOnBackdrop) onClose();
        }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-harness="modal-panel"
      >
        <header data-harness="modal-header">
          <h2 id={titleId} data-harness="modal-title">
            {title}
          </h2>
          <button
            type="button"
            data-harness="modal-close"
            data-variant="ghost"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div data-harness="modal-body">{children}</div>

        {footer !== undefined && <footer data-harness="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
