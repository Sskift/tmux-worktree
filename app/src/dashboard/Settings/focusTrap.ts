export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export type FocusDirection = -1 | 1;

/**
 * Returns a wrapped destination only when focus would otherwise leave the trap.
 * A null result means the browser can perform its normal in-range Tab movement.
 */
export function getWrappedFocusIndex(
  currentIndex: number,
  itemCount: number,
  direction: FocusDirection,
): number | null {
  if (itemCount <= 0) return null;
  if (currentIndex < 0) return direction === -1 ? itemCount - 1 : 0;
  if (direction === -1 && currentIndex === 0) return itemCount - 1;
  if (direction === 1 && currentIndex === itemCount - 1) return 0;
  return null;
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  return element.getClientRects().length > 0;
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

export function keepFocusInside(event: KeyboardEvent, container: HTMLElement): boolean {
  if (event.key !== "Tab") return false;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return true;
  }

  const activeElement = document.activeElement;
  const currentIndex = activeElement instanceof HTMLElement ? focusable.indexOf(activeElement) : -1;
  const direction: FocusDirection = event.shiftKey ? -1 : 1;
  const nextIndex = getWrappedFocusIndex(currentIndex, focusable.length, direction);
  if (nextIndex === null) return false;

  event.preventDefault();
  focusable[nextIndex]?.focus();
  return true;
}
