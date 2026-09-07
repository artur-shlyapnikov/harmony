/**
 * Toast dedupe (§3.15 session.toasts): an identical live toast is replaced
 * rather than stacked, so repeated identical failures read as one alert.
 */
import { describe, expect, it } from 'vitest';

import { makeStore, type AppStore } from '@app/store';
import type { Toast } from '@state/sessionSlice';
import { selectToasts } from '@state/selectors';

const toast = (id: string, message: string, kind: Toast['kind'] = 'error'): Toast => ({
  id,
  kind,
  message,
});

const push = (store: AppStore, item: Toast) =>
  store.dispatch({ type: 'session/toastPushed', payload: { toast: item } });

const ids = (store: AppStore) =>
  selectToasts(store.getState()).map((t) => t.id);

describe('session/toastPushed dedupe', () => {
  it('replaces an identical live toast instead of stacking a second copy', () => {
    const store = makeStore();
    push(store, toast('a', 'MIDI 97 вне диапазона'));
    push(store, toast('b', 'MIDI 97 вне диапазона'));

    expect(ids(store)).toEqual(['b']);
  });

  it('keeps distinct messages as separate toasts', () => {
    const store = makeStore();
    push(store, toast('a', 'первая ошибка'));
    push(store, toast('b', 'вторая ошибка'));

    expect(ids(store)).toEqual(['a', 'b']);
  });

  it('treats the same message with a different kind as distinct', () => {
    const store = makeStore();
    push(store, toast('a', 'Готово', 'success'));
    push(store, toast('b', 'Готово', 'error'));

    expect(ids(store)).toEqual(['a', 'b']);
  });

  it('replaces only the matching entry and keeps unrelated neighbours in order', () => {
    const store = makeStore();
    push(store, toast('a', 'MIDI 97 вне диапазона'));
    push(store, toast('b', 'другая ошибка'));
    push(store, toast('c', 'MIDI 97 вне диапазона'));

    expect(ids(store)).toEqual(['c', 'b']);
  });

  it('a dismissed twin does not block a fresh push', () => {
    const store = makeStore();
    push(store, toast('a', 'сбой сохранения'));
    store.dispatch({ type: 'session/toastDismissed', payload: { id: 'a' } });
    push(store, toast('b', 'сбой сохранения'));

    expect(ids(store)).toEqual(['b']);
  });
});
