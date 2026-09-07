/**
 * Toast surface (§3.15 session.toasts → §4 ownership). Renders every toast in
 * session state and auto-dismisses each after TOAST_AUTO_DISMISS_MS (≥4s per
 * plan, paused while hovered so limit/error text stays readable); a toast
 * can also be dismissed manually. Focus does NOT pause the timer: a focused
 * toast still auto-dismisses with focus parked on the host sentinel.
 *
 * Accessibility: the host is ALWAYS mounted so the aria-live region exists
 * before the first toast is inserted (a region mounted together with its
 * content is often not announced). The host itself stays polite; error items
 * opt into assertive announcement via role="alert". Items carry no per-item
 * role="status" — that would duplicate the host's announcement.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import { selectToasts } from '@state/selectors';
import type { Toast } from '@state/sessionSlice';

export const TOAST_AUTO_DISMISS_MS = 4500;

function ToastItem({
  toast,
  hostRef,
  onDismiss,
}: {
  toast: Toast;
  hostRef: RefObject<HTMLDivElement | null>;
  onDismiss: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => {
    // Removing the focused close button would silently drop focus to <body>;
    // park it on the always-mounted host sentinel instead.
    const active = document.activeElement;
    if (active instanceof HTMLElement && ref.current?.contains(active)) {
      hostRef.current?.focus();
    }
    onDismiss(toast.id);
  }, [hostRef, onDismiss, toast.id]);
  useEffect(() => {
    let timer = setTimeout(dismiss, TOAST_AUTO_DISMISS_MS);
    const pause = (): void => clearTimeout(timer);
    const resume = (): void => {
      clearTimeout(timer);
      timer = setTimeout(dismiss, TOAST_AUTO_DISMISS_MS);
    };
    const node = ref.current;
    node?.addEventListener('mouseenter', pause);
    node?.addEventListener('mouseleave', resume);
    return () => {
      clearTimeout(timer);
      node?.removeEventListener('mouseenter', pause);
      node?.removeEventListener('mouseleave', resume);
    };
  }, [dismiss]);

  return (
    <div
      ref={ref}
      className={`toast toast-${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : undefined}
    >
      <span className="toast-message">{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Закрыть уведомление"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}

export function ToastHost({ className }: { className?: string }) {
  const toasts = useAppSelector(selectToasts);
  const dispatch = useAppDispatch();
  // Stable sentinel: focus lands here when a focused toast is dismissed.
  const hostRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(
    (id: string) => dispatch({ type: 'session/toastDismissed', payload: { id } }),
    [dispatch],
  );

  return (
    <div
      ref={hostRef}
      className={className === undefined ? 'toast-host' : `toast-host ${className}`}
      aria-live="polite"
      tabIndex={-1}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} hostRef={hostRef} onDismiss={dismiss} />
      ))}
    </div>
  );
}
