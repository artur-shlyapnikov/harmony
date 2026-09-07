/**
 * Round-11 shortcut/selection fixes:
 * - SC-1: `event.repeat` guard for Space (toggle) and Alt+Up/Alt+Down
 *   (bounded semitone move); plain arrows keep auto-repeat.
 * - SC-2: §3.20 Delete over a range selection removes every covered note AND
 *   chord via ONE canonical undoable command (deleteEventsInRangeCmd).
 * - SC-3: range nudge clamps against projectLengthTicks like chord placement.
 */
import { describe, expect, it, vi } from 'vitest';

import { makeStore, type AppDispatch } from '@app/store';
import {
  createProjectDocument,
  projectLengthTicks,
  type ProjectDocumentV1,
} from '@domain/model/project';
import { MIDI_MAX, parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID, NOTE_GRID } from '@domain/timeline/constants';
// Dynamic import so pre-fix runs fail with "deleteEventsInRangeCmd is not a
// function" (SC-2 red-on-old: no such command today) instead of a module-level
// import error that would mask the behavioral failures below.
const { deleteEventsInRangeCmd } = await import('@state/commands');
const {
  addNoteCmd,
  openProjectCmd,
  selectNoteCmd,
  selectRangeCmd,
} = await import('@state/commands');
import {
  selectMelodyNotes,
  selectSelection,
  selectToasts,
} from '@state/selectors';
import { createEditorShortcutHandler } from '@features/editor/useEditorShortcuts';

const C = parseSpelled('C')!;
const PROJECT: ProjectDocumentV1 = createProjectDocument({
  title: 't',
  tonic: C,
  mode: 'ionian',
});

/** Doc with notes and chords around the range [CHORD_GRID, 3*CHORD_GRID). */
function docWithEvents(): ProjectDocumentV1 {
  const doc = createProjectDocument({ title: 't', tonic: C, mode: 'ionian' });
  return {
    ...doc,
    melody: {
      ...doc.melody,
      notes: [
        { id: 'keep-before', startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 80 },
        // fully inside the range
        { id: 'kill-inside', startTick: CHORD_GRID + NOTE_GRID, durationTicks: NOTE_GRID, midi: 62, velocity: 80 },
        // straddles the left edge (ends after startTick)
        { id: 'kill-straddle', startTick: CHORD_GRID - NOTE_GRID / 2, durationTicks: NOTE_GRID, midi: 64, velocity: 80 },
        // starts exactly at the range end → NOT covered
        { id: 'keep-at-end', startTick: 3 * CHORD_GRID, durationTicks: NOTE_GRID, midi: 65, velocity: 80 },
      ],
    },
    harmony: {
      ...doc.harmony,
      chords: [
        // ends exactly at the range start → NOT covered
        { id: 'chord-before', startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } },
        // fully inside the range
        { id: 'chord-inside', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'min' } },
        // starts exactly at the range end → NOT covered
        { id: 'chord-after', startTick: 3 * CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: C, templateId: '7' } },
      ],
    },
  };
}

function seededStore(doc: ProjectDocumentV1) {
  const store = makeStore();
  store.dispatch({ type: 'document/replacedFromLoad', payload: { project: doc } });
  return store;
}

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
      repeat: false,
      ...partial,
    });
  return { store, press, transport };
}

describe('deleteEventsInRangeCmd (SC-2)', () => {
  it('removes all covered notes AND chords in ONE history entry', () => {
    const store = seededStore(docWithEvents());
    const pastBefore = store.getState().projectHistory.past.length;

    expect(
      deleteEventsInRangeCmd({ startTick: CHORD_GRID, endTick: 3 * CHORD_GRID })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);

    const doc = store.getState().projectHistory.present!;
    expect(doc.melody.notes.map((n) => n.id)).toEqual(['keep-before', 'keep-at-end']);
    expect(doc.harmony.chords.map((c) => c.id)).toEqual(['chord-before', 'chord-after']);
    // Both lanes changed in a single undoable mutation.
    expect(store.getState().projectHistory.past.length).toBe(pastBefore + 1);
  });

  it('single undo restores both kinds', () => {
    const store = seededStore(docWithEvents());
    deleteEventsInRangeCmd({ startTick: CHORD_GRID, endTick: 3 * CHORD_GRID })(
      store.dispatch,
      store.getState,
    );
    store.dispatch({ type: 'history/undo' });
    const restored = store.getState().projectHistory.present!;
    expect(restored.melody.notes.map((n) => n.id)).toContain('kill-inside');
    expect(restored.harmony.chords.map((c) => c.id)).toContain('chord-inside');
  });

  it('clears a range selection on success', () => {
    const store = seededStore(docWithEvents());
    store.dispatch(selectRangeCmd(CHORD_GRID, 2 * CHORD_GRID));
    deleteEventsInRangeCmd({ startTick: CHORD_GRID, endTick: 3 * CHORD_GRID })(
      store.dispatch,
      store.getState,
    );
    expect(selectSelection(store.getState())).toBeNull();
  });

  it('range covering nothing is a rejected no-op (no history entry)', () => {
    const store = seededStore(docWithEvents());
    const pastBefore = store.getState().projectHistory.past.length;
    const toastsBefore = selectToasts(store.getState()).length;
    const before = store.getState().projectHistory.present;
    // [1920..2880) hits nothing: every note ends before 1920 or starts at
    // 2880; chord-inside ends exactly at 1920 and chord-after starts at 2880.
    expect(
      deleteEventsInRangeCmd({ startTick: 2 * CHORD_GRID, endTick: 3 * CHORD_GRID })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(false);

    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past.length).toBe(pastBefore);
    // RD-T1: rejection surfaces the verbatim §3.20 copy (commands.ts).
    const newToasts = selectToasts(store.getState()).slice(toastsBefore);
    expect(newToasts).toHaveLength(1);
    expect(newToasts[0]!.kind).toBe('error');
    expect(newToasts[0]!.message).toBe('В выделенном диапазоне нет событий');
  });
});

describe('Delete over a range selection (SC-2 shortcut wiring)', () => {
  it('deletes covered notes AND chords and clears the selection', () => {
    const { store, press } = setupSync();
    store.dispatch({ type: 'document/replacedFromLoad', payload: { project: docWithEvents() } });
    store.dispatch(selectRangeCmd(CHORD_GRID, 2 * CHORD_GRID));

    press({ key: 'Delete' });

    const doc = store.getState().projectHistory.present!;
    expect(doc.melody.notes.map((n) => n.id)).toEqual(['keep-before', 'keep-at-end']);
    expect(doc.harmony.chords.map((c) => c.id)).toEqual(['chord-before', 'chord-after']);
    expect(selectSelection(store.getState())).toBeNull();

    // One undo restores both kinds.
    press({ key: 'z', ctrlKey: true });
    const restored = store.getState().projectHistory.present!;
    expect(restored.melody.notes).toHaveLength(4);
    expect(restored.harmony.chords).toHaveLength(3);
  });

  it('Backspace behaves identically', () => {
    const { store, press } = setupSync();
    store.dispatch({ type: 'document/replacedFromLoad', payload: { project: docWithEvents() } });
    store.dispatch(selectRangeCmd(CHORD_GRID, 2 * CHORD_GRID));

    press({ key: 'Backspace' });

    const doc = store.getState().projectHistory.present!;
    expect(doc.melody.notes.map((n) => n.id)).toEqual(['keep-before', 'keep-at-end']);
    expect(doc.harmony.chords.map((c) => c.id)).toEqual(['chord-before', 'chord-after']);
  });
});

describe('event.repeat guards (SC-1)', () => {
  it('holding Space does not machine-gun the play/pause toggle', () => {
    const { store, press, transport } = setupSync();

    press({ key: ' ' }); // real keydown → toggles once
    press({ key: ' ', repeat: true }); // OS auto-repeat → ignored

    expect(transport.toggle).toHaveBeenCalledTimes(1);
    expect(store.getState().projectHistory.present).not.toBeNull();
  });

  it('holding Alt+Up at MIDI_MAX does not spam rejection toasts', () => {
    const { store, press } = setupSync();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: MIDI_MAX, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]!.id;
    store.dispatch(selectNoteCmd(id));
    const toastsBefore = selectToasts(store.getState()).length;

    press({ key: 'ArrowUp', altKey: true, repeat: true });
    press({ key: 'ArrowUp', altKey: true, repeat: true });

    expect(selectToasts(store.getState()).length).toBe(toastsBefore);
    expect(selectMelodyNotes(store.getState())[0]!.midi).toBe(MIDI_MAX);
  });

  it('plain Up still auto-repeats (diatonic steps per keydown)', () => {
    const { store, press } = setupSync();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]!.id;
    store.dispatch(selectNoteCmd(id));

    press({ key: 'ArrowUp', repeat: true });

    // Auto-repeat is intentional for diatonic nudges: one step per event.
    expect(selectMelodyNotes(store.getState())[0]!.midi).not.toBe(60);
  });
});

describe('range nudge clamps against project length (SC-3)', () => {
  it('ArrowRight cannot push the range past projectLengthTicks', () => {
    const { store, press } = setupSync();
    const maxStart = projectLengthTicks(PROJECT) - CHORD_GRID;
    store.dispatch(selectRangeCmd(maxStart, CHORD_GRID));

    press({ key: 'ArrowRight' });

    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: maxStart,
      durationTicks: CHORD_GRID,
    });
  });

  it('ArrowLeft still clamps at 0', () => {
    const { store, press } = setupSync();
    store.dispatch(selectRangeCmd(0, CHORD_GRID));

    press({ key: 'ArrowLeft' });

    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: 0,
      durationTicks: CHORD_GRID,
    });
  });
});

describe('range-delete chord merge post-pass (§3.7 step 7 via SC-2)', () => {
  it('collapses adjacent identical chords left behind by a range delete', () => {
    // mergeAdjacentIdenticalChords requires strict contiguity
    // (prevEnd === next.start), so a deleted middle chord can never make its
    // own neighbors adjacent — survivors of [s, e) all lie at or beyond the
    // edges. The branch fires on documents that ALREADY hold a contiguous
    // identical pair (loaded docs are sorted, not merged) plus an unrelated
    // chord inside the range; dropping the post-pass leaves two chords.
    const doc = createProjectDocument({ title: 't', tonic: C, mode: 'ionian' });
    const mergeDoc: ProjectDocumentV1 = {
      ...doc,
      harmony: {
        ...doc.harmony,
        chords: [
          { id: 'chord-pair-left', startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } },
          { id: 'chord-pair-right', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } },
          // fully inside the range [2*CHORD_GRID, 4*CHORD_GRID)
          { id: 'chord-inside', startTick: 2 * CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'min' } },
        ],
      },
    };
    const store = seededStore(mergeDoc);
    const pastBefore = store.getState().projectHistory.past.length;

    expect(
      deleteEventsInRangeCmd({ startTick: 2 * CHORD_GRID, endTick: 4 * CHORD_GRID })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords).toHaveLength(1);
    // Merge keeps the earlier id and extends the span over both halves.
    expect(chords[0]!.id).toBe('chord-pair-left');
    expect(chords[0]!.startTick).toBe(0);
    expect(chords[0]!.durationTicks).toBe(2 * CHORD_GRID);
    expect(store.getState().projectHistory.past.length).toBe(pastBefore + 1);
  });
});
