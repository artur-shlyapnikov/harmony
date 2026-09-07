// @vitest-environment jsdom
/**
 * §3.8 rename (toolbar click-to-edit): setTitleCmd is one undoable document
 * mutation — trims input, rejects empty titles with an error toast, treats
 * re-entering the current title as a silent no-op, and flows through the
 * standard dirty→autosave pipeline.
 */

import { describe, expect, it } from 'vitest';

import { makeStore } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import { openProjectCmd, setTitleCmd } from '../../src/state/commands';
import { UNDO_ACTION_TYPE } from '../../src/state/historyReducer';
import { selectPresentProject } from '../../src/state/selectors';

function setup() {
  const store = makeStore();
  store.dispatch(
    openProjectCmd(
      createProjectDocument({
        title: 'Черновик',
        tonic: { letter: 'C', accidental: 0 },
        mode: 'ionian',
      }),
    ),
  );
  return store;
}

describe('setTitleCmd', () => {
  it('renames the project as one undoable mutation', () => {
    const store = setup();
    expect(store.dispatch(setTitleCmd('Соната'))).toBe(true);
    expect(selectPresentProject(store.getState())?.title).toBe('Соната');

    store.dispatch({ type: UNDO_ACTION_TYPE });
    expect(selectPresentProject(store.getState())?.title).toBe('Черновик');
  });

  it('rejects empty and whitespace-only titles with an error toast', () => {
    const store = setup();
    expect(store.dispatch(setTitleCmd('   '))).toBe(false);
    expect(selectPresentProject(store.getState())?.title).toBe('Черновик');
    const toasts = store.getState().session.toasts;
    expect(toasts.some((toast) => toast.kind === 'error')).toBe(true);
  });

  it('re-entering the current title is a silent no-op without history', () => {
    const store = setup();
    const pastBefore = store.getState().projectHistory.past.length;
    expect(store.dispatch(setTitleCmd('  Черновик  '))).toBe(true);
    expect(store.getState().projectHistory.past.length).toBe(pastBefore);
    expect(selectPresentProject(store.getState())?.title).toBe('Черновик');
  });

  it('clamps input to 60 characters', () => {
    const store = setup();
    store.dispatch(setTitleCmd('Я'.repeat(100)));
    expect(selectPresentProject(store.getState())?.title).toBe('Я'.repeat(60));
  });

  it('renaming flips the save status to dirty (autosave picks it up)', () => {
    const store = setup();
    // The listener middleware marks the session dirty synchronously on any
    // document mutation; the debounced save follows.
    store.dispatch(setTitleCmd('Финал'));
    expect(store.getState().session.saveStatus).toBe('dirty');
  });
});
