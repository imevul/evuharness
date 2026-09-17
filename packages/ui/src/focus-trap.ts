/**
 * Focus containment for dialog-like surfaces.
 *
 * Separate from the component so a host that builds its own dialog can reuse the
 * same selector and Tab handling instead of re-deriving what counts as focusable.
 */

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Focusable descendants in document order.
 *
 * Deliberately no visibility filtering: `offsetParent` and layout boxes are not
 * meaningful under jsdom, so a filter that looks correct would silently empty the
 * list in tests and make the trap untestable.
 */
export function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (container === null) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Keep Tab inside `container`, wrapping at both ends.
 *
 * Call only for a Tab keydown. When the container holds nothing focusable the
 * container itself takes focus, which is why a dialog panel carries `tabIndex={-1}`.
 */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement | null): void {
  if (container === null) return;

  const focusable = focusableWithin(container);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (first === undefined || last === undefined) {
    event.preventDefault();
    container.focus();
    return;
  }

  const active = document.activeElement;
  const outside = !(active instanceof Node) || !container.contains(active);

  if (event.shiftKey) {
    if (active === first || outside) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (active === last || outside) {
    event.preventDefault();
    first.focus();
  }
}
