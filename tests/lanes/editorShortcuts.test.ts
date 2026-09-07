/**
 * Reducer-level shortcut flows (§3.20 Keyboard shortcuts): the shared handler
 * factory is exercised against a real store with synthetic key events.
 */

import { describe, expect, it, vi } from 'vitest';

import { makeStore, type AppDispatch } from '@app/store';
import { createProjectDocument, type ProjectDocumentV1 } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID, NOTE_GRID } from '@domain/timeline/constants';
import {
  addChordRangeCmd,
  addNoteCmd,
  openProjectCmd,
  selectChordCmd,
  selectNoteCmd,
  selectRangeCmd,
} from '@state/commands';
import { selectChords, selectMelodyNotes, selectSelection } from '@state/selectors';
import { REDO_ACTION_TYPE, UNDO_ACTION_TYPE } from '@state/historyReducer';
import { createEditorShortcutHandler } from '@features/editor/useEditorShortcuts';

const C = parseSpelled('C')!;
const PROJECT: ProjectDocumentV1 = createProjectDocument({
  title: 't',
  tonic: C,
  mode: 'ionian',
});

function setupSync() {
  const store = makeStore();
  store.dispatch(openProjectCmd(PROJECT));
  const transport = { toggle: vi.fn() };
  const handler = createEditorShortcutHandler({
    dispatch: store.dispatch as AppDispatch,
    getState: store.getState,
    transport,
  });
  const press = (partial: { key: string; target?: EventTarget | null } & Record<string, unknown>) =>
    handler({
      target: null,
      preventDefault: vi.fn(),
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...partial,
    });
    const addSelectedNote = (startTick: number, midi: number): string => {
    store.dispatch(addNoteCmd({ startTick, durationTicks: NOTE_GRID, midi, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));
    return id;
  };
  return { store, press, transport, handler, addSelectedNote };
}

describe('undo/redo', () => {
  it('Cmd+Z undoes and Cmd+Shift+Z redoes a note addition', () => {
    const { store, press } = setupSync();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 72, velocity: 80 }));
    expect(selectMelodyNotes(store.getState())).toHaveLength(1);

    press({ key: 'z', ctrlKey: true });
    expect(selectMelodyNotes(store.getState())).toHaveLength(0);

    press({ key: 'z', ctrlKey: true, shiftKey: true });
    expect(selectMelodyNotes(store.getState())).toHaveLength(1);
  });

  it('dispatches history actions directly', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(PROJECT));
    const spy = vi.spyOn(store, 'dispatch');
    const transport = { toggle: vi.fn() };
    const handler = createEditorShortcutHandler({
      dispatch: spy,
      getState: store.getState,
      transport,
    });
    const event = {
      key: 'z',
      target: null,
      preventDefault: vi.fn(),
      shiftKey: false,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
    };
    handler(event);
    expect(spy).toHaveBeenCalledWith({ type: UNDO_ACTION_TYPE });
    handler({ ...event, shiftKey: true });
    expect(spy).toHaveBeenCalledWith({ type: REDO_ACTION_TYPE });
  });
});

describe('selection deletion', () => {
  it('deletes the selected note and clears selection', () => {
    const { store, press, addSelectedNote } = setupSync();
    addSelectedNote(0, 60);

    press({ key: 'Delete' });
    expect(selectMelodyNotes(store.getState())).toHaveLength(0);
    expect(selectSelection(store.getState())).toBeNull();
  });

  it('Escape clears the active selection without deleting events', () => {
    const { store, press, addSelectedNote } = setupSync();
    addSelectedNote(0, 60);
    expect(selectSelection(store.getState())).not.toBeNull();

    press({ key: 'Escape' });

    expect(selectMelodyNotes(store.getState())).toHaveLength(1); // note survives
    expect(selectSelection(store.getState())).toBeNull();
  });

  it('deletes the selected chord via Backspace', () => {
    const { store, press } = setupSync();
    store.dispatch(
      addChordRangeCmd({
        startTick: 0,
        durationTicks: CHORD_GRID,
        chord: { root: C, templateId: 'maj7' },
      }),
    );
    const id = selectChords(store.getState())[0]?.id as string;
    store.dispatch(selectChordCmd(id));

    press({ key: 'Backspace' });
    expect(selectChords(store.getState())).toHaveLength(0);
  });
});

describe('grid movement', () => {
  it('Left/Right move a note by NOTE_GRID and clamp at 0', () => {
    const { store, press, addSelectedNote } = setupSync();
    addSelectedNote(NOTE_GRID, 60);

    press({ key: 'ArrowRight' });
    expect(selectMelodyNotes(store.getState())[0]?.startTick).toBe(NOTE_GRID * 2);

    press({ key: 'ArrowLeft' });
    press({ key: 'ArrowLeft' });
    expect(selectMelodyNotes(store.getState())[0]?.startTick).toBe(0);
  });

  it('Shift+Left/Right resize by grid without going below one step', () => {
    const { store, press } = setupSync();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID * 2, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    press({ key: 'ArrowRight', shiftKey: true });
    expect(selectMelodyNotes(store.getState())[0]?.durationTicks).toBe(NOTE_GRID * 3);

    for (let i = 0; i < 5; i++) press({ key: 'ArrowLeft', shiftKey: true });
    expect(selectMelodyNotes(store.getState())[0]?.durationTicks).toBe(NOTE_GRID);
  });

  it('moves a range selection by CHORD_GRID', () => {
    const { store, press } = setupSync();
    store.dispatch(selectRangeCmd(CHORD_GRID, CHORD_GRID * 2));

    press({ key: 'ArrowRight' });
    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: CHORD_GRID * 2,
      durationTicks: CHORD_GRID * 2,
    });
  });
});

describe('pitch movement', () => {
  it('Up/Down move diatonically in C major (B4 -> C5)', () => {
    const { store, press, addSelectedNote } = setupSync();
    addSelectedNote(0, 71); // B4

    press({ key: 'ArrowUp' });
    expect(selectMelodyNotes(store.getState())[0]?.midi).toBe(72);
    press({ key: 'ArrowDown' });
    expect(selectMelodyNotes(store.getState())[0]?.midi).toBe(71);
  });

  it('Alt+Up/Down move chromatically', () => {
    const { store, press, addSelectedNote } = setupSync();
    addSelectedNote(0, 60);

    press({ key: 'ArrowUp', altKey: true });
    expect(selectMelodyNotes(store.getState())[0]?.midi).toBe(61);
    press({ key: 'ArrowDown', altKey: true });
    expect(selectMelodyNotes(store.getState())[0]?.midi).toBe(60);
  });
});

describe('space transport toggle', () => {
  it('toggles the transport with the open document', () => {
    const { press, transport } = setupSync();
    press({ key: ' ' });
    // Wiring only: pause/play/«starting» decisions live in the ProjectTransport
    // (tests/audio/projectTransport.test.ts).
    expect(transport.toggle).toHaveBeenCalledTimes(1);
    expect(transport.toggle).toHaveBeenCalledWith(PROJECT);
  });

  it('toggles when a note/chord lane block holds focus (lane blocks must not swallow Space)', () => {
    const { press, transport } = setupSync();
    // NoteBlock/ChordBlock render role=button DIVs; after a click the block
    // keeps focus, and Space must still reach the transport toggle (7e1efa6).
    // A plain div does not match the shortcut layer's 'button, a[href]'
    // carve-out, so playback wins over any native button activation.
    press({ key: ' ', target: { tagName: 'DIV' } as unknown as EventTarget });
    expect(transport.toggle).toHaveBeenCalledTimes(1);
  });

  it('leaves Space native when a real <button> holds focus (toolbar tools, undo/redo, export)', () => {
    const { press, transport } = setupSync();
    const preventDefault = vi.fn();
    let clicked = false;
    // Duck-typed DOM button: closest('button, a[href]') hits.
    const target = {
      tagName: 'BUTTON',
      closest: (selector: string) =>
        selector === 'button, a[href]' ? { click: () => (clicked = true) } : null,
    } as unknown as EventTarget;
    press({ key: ' ', target, preventDefault });
    // The shortcut layer bails BEFORE consuming the event: no preventDefault
    // means the browser fires the button's native click activation.
    expect(preventDefault).not.toHaveBeenCalled();
    expect(transport.toggle).not.toHaveBeenCalled();
    expect(clicked).toBe(false);
  });

  it('ignores keys typed inside inputs', () => {
    const { press, transport } = setupSync();
    press({
      key: ' ',
      target: { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget,
    });
    expect(transport.toggle).not.toHaveBeenCalled();
  });
});

describe('modifier-key input guard', () => {
  const TYPING_TARGET = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget;

  it('Alt+ArrowUp, Cmd+Z, and Shift+Left typed inside a text input never reach the shortcuts (§3.20 keyboard table scope)', () => {
    const { store, press, transport, addSelectedNote } = setupSync();
    const id = addSelectedNote(0, 60);
    const noteBefore = selectMelodyNotes(store.getState())[0]!;
    const pastBefore = store.getState().projectHistory.past.length;

    press({ key: 'ArrowUp', altKey: true, target: TYPING_TARGET });
    press({ key: 'z', metaKey: true, target: TYPING_TARGET });
    press({ key: 'ArrowLeft', shiftKey: true, target: TYPING_TARGET });

    // No transport, no semitone move, no undo/redo, no grid move/resize.
    expect(transport.toggle).not.toHaveBeenCalled();
    const noteAfter = selectMelodyNotes(store.getState())[0]!;
    expect(noteAfter.midi).toBe(noteBefore.midi);
    expect(noteAfter.startTick).toBe(noteBefore.startTick);
    expect(noteAfter.durationTicks).toBe(noteBefore.durationTicks);
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore);
    // The selection itself is untouched.
    expect(selectSelection(store.getState())).toEqual({ kind: 'note', id });
  });
});

describe('[data-modal] guard (RevUI-3 belt-and-suspenders)', () => {
  it('a Delete keydown whose target sits inside a [data-modal] ancestor never reaches the shortcuts even when delivered straight to the handler', () => {
    const { store, transport, handler, addSelectedNote } = setupSync();
    const id = addSelectedNote(0, 60);
    const pastBefore = store.getState().projectHistory.past.length;

    const preventDefault = vi.fn();
    handler({
      key: 'Delete',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      preventDefault,
      // Duck-typed target: closest('[data-modal]') hits, so the guard must
      // bail before any shortcut arm runs.
      target: {
        closest: (selector: string) => (selector === '[data-modal]' ? {} : null),
      } as unknown as EventTarget,
    });

    // No deletion, no history entry, selection intact, no transport, and
    // the guard returned BEFORE consuming the event.
    expect(selectMelodyNotes(store.getState())).toHaveLength(1);
    expect(selectSelection(store.getState())).toEqual({ kind: 'note', id });
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(transport.toggle).not.toHaveBeenCalled();
  });
});

describe('range slider focus (Громкость is not a typing target)', () => {
  const RANGE_TARGET = {
    tagName: 'INPUT',
    type: 'range',
    isContentEditable: false,
  } as unknown as EventTarget;

  it('⌘Z undoes while the velocity slider holds focus', () => {
    const { store, press } = setupSync();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 72, velocity: 80 }));
    expect(selectMelodyNotes(store.getState())).toHaveLength(1);

    press({ key: 'z', metaKey: true, target: RANGE_TARGET });
    expect(selectMelodyNotes(store.getState())).toHaveLength(0);
  });

  it('Space toggles playback while the slider holds focus (native range ignores Space)', () => {
    const { press, transport } = setupSync();
    press({ key: ' ', target: RANGE_TARGET });
    expect(transport.toggle).toHaveBeenCalledTimes(1);
  });

  it('arrows keep their native slider stepping: no note nudge while the slider holds focus', () => {
    const { store, press, addSelectedNote } = setupSync();
    const id = addSelectedNote(NOTE_GRID, 60);
    const before = selectMelodyNotes(store.getState())[0]!;

    press({ key: 'ArrowRight', target: RANGE_TARGET });
    press({ key: 'ArrowUp', target: RANGE_TARGET });

    const after = selectMelodyNotes(store.getState())[0]!;
    expect(after.id).toBe(id);
    expect(after.startTick).toBe(before.startTick);
    expect(after.midi).toBe(before.midi);
  });
});
