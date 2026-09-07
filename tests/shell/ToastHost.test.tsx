// @vitest-environment jsdom
/**
 * Toast surface accessibility (§3.15): the aria-live region persists even
 * when there are no toasts (a live region mounted together with its first
 * content is often not announced), error toasts opt into assertive
 * announcement while others inherit the polite host, and dismissing a
 * focused toast never drops focus to <body>.
 */

import { Provider } from 'react-redux';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeStore, type AppStore } from '../../src/app/store';
import { TOAST_AUTO_DISMISS_MS, ToastHost } from '../../src/shared/ToastHost';

type ToastInput = { id: string; kind: 'error' | 'info' | 'success'; message: string };

function pushToast(store: AppStore, toast: ToastInput): void {
  act(() => {
    store.dispatch({ type: 'session/toastPushed', payload: { toast } });
  });
}

function renderHost() {
  const store = makeStore();
  const view = render(
    <Provider store={store}>
      <ToastHost />
    </Provider>,
  );
  const host = () => document.querySelector<HTMLElement>('.toast-host')!;
  return { view, store, host };
}

describe('toast host accessibility', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('host stays mounted as an empty polite live region when there are no toasts', () => {
    const { host } = renderHost();
    expect(host()).not.toBeNull();
    expect(host().getAttribute('aria-live')).toBe('polite');
    expect(host().children.length).toBe(0);
  });

  it('error toast announces assertively; non-error toasts carry no per-item live role', () => {
    const { store, host } = renderHost();
    pushToast(store, { id: 't-info', kind: 'info', message: 'Проект пуст' });
    pushToast(store, { id: 't-err', kind: 'error', message: 'Не удалось сохранить' });

    const info = host().querySelector<HTMLElement>('.toast-info')!;
    const failure = host().querySelector<HTMLElement>('.toast-error')!;
    expect(info.getAttribute('role')).toBeNull();
    // Assertive override for errors; the polite host would otherwise win.
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.closest('[aria-live="polite"]')).toBe(host());
  });

  it('closing a focused toast keeps focus inside the host instead of dropping to body', () => {
    const { store, host } = renderHost();
    pushToast(store, { id: 't-err', kind: 'error', message: 'Сбой' });

    const closeButton = screen.getByRole('button', { name: 'Закрыть уведомление' });
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    fireEvent.click(closeButton);

    expect(store.getState().session.toasts).toHaveLength(0);
    expect(document.activeElement).toBe(host());
  });

  it('auto-dismissing a focused toast keeps focus inside the host', () => {
    vi.useFakeTimers();
    const { store, host } = renderHost();
    pushToast(store, { id: 't-info', kind: 'info', message: 'Экспортировано' });

    const closeButton = screen.getByRole('button', { name: 'Закрыть уведомление' });
    closeButton.focus();

    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 1);
    });

    expect(store.getState().session.toasts).toHaveLength(0);
    expect(document.activeElement).toBe(host());
  });
});
