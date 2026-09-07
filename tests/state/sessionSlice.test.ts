/**
 * Session reducer state transitions (§3.15, §3.18).
 */

import { describe, expect, it } from 'vitest';

import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { openProjectCmd, selectChordCmd, selectNoteCmd } from '@state/commands';

describe('session/projectOpened', () => {
  it('resets stale save error state from a previously opened project', () => {
    const store = makeStore();
    store.dispatch({ type: 'session/saveStatusSet', payload: { status: 'error' } });
    store.dispatch({
      type: 'session/persistenceErrorSet',
      payload: { error: 'хранилище переполнено' },
    });

    const doc = createProjectDocument({ title: 'B', tonic: parseSpelled('C')!, mode: 'ionian' });
    store.dispatch(openProjectCmd(doc));

    const state = store.getState().session;
    expect(state.activeProjectId).toBe(doc.id);
    expect(state.saveStatus).toBe('idle');
    expect(state.persistenceError).toBeUndefined();
  });

  it('selecting a note then a chord leaves only the chord selected (§3.15 single-selection)', () => {
    const store = makeStore();
    selectNoteCmd('note-1')(store.dispatch);
    expect(store.getState().session.selection).toEqual({ kind: 'note', id: 'note-1' });

    selectChordCmd('chord-1')(store.dispatch);

    // The `selection` union holds ONE kind at a time: the note id is gone.
    expect(store.getState().session.selection).toEqual({ kind: 'chord', id: 'chord-1' });
  });

  it('selecting a chord then a note leaves only the note selected (§3.15 symmetric)', () => {
    const store = makeStore();
    selectChordCmd('chord-1')(store.dispatch);
    expect(store.getState().session.selection).toEqual({ kind: 'chord', id: 'chord-1' });

    selectNoteCmd('note-1')(store.dispatch);

    expect(store.getState().session.selection).toEqual({ kind: 'note', id: 'note-1' });
  });
  it('clears seeded toasts alongside save status on a fresh open (§3.15 no cross-project bleed)', () => {
    const store = makeStore();
    store.dispatch({
      type: 'session/toastPushed',
      payload: { toast: { id: 't1', kind: 'error', message: 'хранилище переполнено' } },
    });
    store.dispatch({ type: 'session/saveStatusSet', payload: { status: 'error' } });

    const doc = createProjectDocument({ title: 'C', tonic: parseSpelled('C')!, mode: 'ionian' });
    store.dispatch(openProjectCmd(doc));

    const state = store.getState().session;
    expect(state.toasts).toEqual([]);
    expect(state.saveStatus).toBe('idle');
    expect(state.activeProjectId).toBe(doc.id);
  });
});
