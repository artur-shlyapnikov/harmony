/**
 * Minimal modal focus trap (§4 shared UI): while `active`, Tab/Shift+Tab cycle
 * inside the referenced dialog container, focus lands on the first focusable
 * element on open (unless the dialog already focused something itself, e.g.
 * via autoFocus), and on close/unmount focus returns to the previously
 * focused element (the trigger).
 */

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * jsdom has no layout engine, so this walks computed styles up the ancestor
 * chain instead of probing geometry: a display:none / visibility:hidden
 * element (or one hidden via an ancestor) cannot receive .focus().
 */
function isVisible(element: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node !== null) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style !== undefined && style !== null) {
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    node = node.parentElement;
  }
  return true;
}

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled') && isVisible(element),
  );
}

/**
 * Document-wide focus history: `previousFocused` is the element focused
 * BEFORE the currently focused one. autoFocus attributes inside a dialog
 * commit before the trap effect runs, so restoring `document.activeElement`
 * would target the dialog's own element (detached after close). The
 * one-step history recovers the real trigger instead.
 */
let lastFocused: Element | null = null;
let previousFocused: Element | null = null;

function trackFocus(event: Event): void {
  previousFocused = lastFocused;
  lastFocused = event.target instanceof Element ? event.target : null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', trackFocus, true);
}

export function useFocusTrap<T extends HTMLElement>(active: boolean): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    if (container === null) return undefined;

    // Initial focus: skip when the dialog already moved focus itself
    // (autoFocus attributes commit before this effect runs).
    const current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const alreadyInside = current !== null && container.contains(current);
    const restoreTo = alreadyInside && previousFocused instanceof HTMLElement
      ? previousFocused
      : current;

    if (!alreadyInside) {
      const target = focusableIn(container)[0] ?? container;
      target.focus();
    }


    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const items = focusableIn(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      const inside = current instanceof HTMLElement && container.contains(current);
      if (event.shiftKey) {
        if (!inside || current === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      restoreTo?.focus();
    };
  }, [active]);

  return ref;
}
