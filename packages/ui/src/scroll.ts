/** Pixels of slack that still count as "at the bottom" while content is growing. */
export const SCROLL_BOTTOM_THRESHOLD_PX = 64;

/**
 * Tighter slack for capped thinking/tool panes. 64px is a large share of a
 * 240px pane and would keep following after a real scroll-up.
 */
export const WORK_SCROLL_THRESHOLD_PX = 16;

/** Capped thinking and tool panes inside a work disclosure. */
export const WORK_SCROLLER_SELECTOR = '[data-harness="reasoning"] pre, [data-harness="tool"] pre';

export function listWorkScrollers(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(WORK_SCROLLER_SELECTOR)];
}

export function isWorkScroller(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLElement && el.matches(WORK_SCROLLER_SELECTOR);
}

export function distanceFromBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** True when the scroller is at (or within the threshold of) its end. */
export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(el) <= threshold;
}
