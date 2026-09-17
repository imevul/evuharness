/** Pixels of slack that still count as "at the bottom" while content is growing. */
export const SCROLL_BOTTOM_THRESHOLD_PX = 64;

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
