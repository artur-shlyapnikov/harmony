/**
 * Store-level editor flows (§3.7, §3.8, §3.14, §3.15, §3.16).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeStore, type RootState } from '@app/store';
import { createProjectDocument, projectLengthTicks, type ProjectDocumentV1 } from '@domain/model/project';
import { parseSpelled, type SpelledPitchClass } from '@domain/model/pitch';
import { CHORD_GRID, MAX_BARS, MAX_CHORD_EVENTS, MAX_MELODY_NOTES, MIN_BARS, NOTE_GRID, TICKS_PER_BAR } from '@domain/timeline/constants';
import {
  addChordRangeCmd,
  addNoteCmd,
  changeBpmCmd,
  clearSelectionCmd,
  deleteChordCmd,
  deleteNoteCmd,
  diatonicStepTargetMidi,
  moveChordCmd,
  moveNoteCmd,
  moveResizeChordCmd,
  moveResizeNoteCmd,
  openProjectByIdCmd,
  openProjectCmd,
  resizeNoteCmd,
  selectChordCmd,
  selectNoteCmd,
  selectRangeCmd,
  setActiveToolCmd,
  setBarsCmd,
  setDefaultPatternCmd,
  setModeCmd,
  setChordPatternOverrideCmd,
  setChordSpecCmd,
  moveNoteSemitonesCmd,
  setNoteSpellingOverrideCmd,
  setNoteVelocityCmd,
  transposeToTonicCmd,
} from '@state/commands';
import { setDependenciesForTesting, type AppDependencies } from '@app/dependencies';
import { getProjectTransport } from '@audio/projectTransport';
import {
  createSelectRecommendations,
  selectChordLabels,
  selectHasProject,
  selectNoteAnalysisMap,
  selectHarmonyContext,
  selectResolvedVoicings,
  selectSelection,
  selectToasts,
} from '@state/selectors';

import { applyProjectEdit } from '@domain/editing/projectEditor';
import { validateProjectDocument } from '@domain/validation/projectSchema';
const C = parseSpelled('C')!;
const D = parseSpelled('D')!;

function freshDoc(): ProjectDocumentV1 {
  return createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian' });
}

function openedStore(doc: ProjectDocumentV1 = freshDoc()) {
  const store = makeStore();
  store.dispatch(openProjectCmd(doc));
  return store;
}

function lastToast(store: { getState: () => RootState }) {
  const toasts = selectToasts(store.getState());
  return toasts[toasts.length - 1];
}

describe('document + history flows', () => {
  it('open project → addNote: present updated, past has 1 entry', () => {
    const store = openedStore();
    expect(selectHasProject(store.getState())).toBe(true);

    expect(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID * 2, midi: 60, velocity: 90 })(store.dispatch, store.getState)).toBe(true);

    const { present, past } = store.getState().projectHistory;
    expect(present?.melody.notes).toHaveLength(1);
    expect(past).toHaveLength(1);
  });

  it('undo/redo round-trip restores the exact document', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const afterAdd = store.getState().projectHistory.present;

    store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.present?.melody.notes).toHaveLength(0);

    store.dispatch({ type: 'history/redo' });
    expect(store.getState().projectHistory.present).toEqual(afterAdd);
  });

  it('105 rapid addNotes cap past at 100 entries', () => {
    const store = openedStore();
    for (let i = 0; i < 105; i += 1) {
      addNoteCmd({ startTick: i * NOTE_GRID, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    }
    expect(store.getState().projectHistory.past).toHaveLength(100);
    expect(store.getState().projectHistory.present?.melody.notes).toHaveLength(105);
  });

  it('addChordRange merges two adjacent identical chords into one', () => {
    const store = openedStore();
    const chord = { root: C, templateId: 'maj' as const };
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: 960, durationTicks: 960, chord })(store.dispatch, store.getState);

    const chords = store.getState().projectHistory.present?.harmony.chords ?? [];
    expect(chords).toHaveLength(1);
    expect(chords[0]?.startTick).toBe(0);
    expect(chords[0]?.durationTicks).toBe(1920);
  });

  it('moveNote clamps against the neighbor without truncating it', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 480, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addNoteCmd({ startTick: 960, durationTicks: 480, midi: 64, velocity: 90 })(store.dispatch, store.getState);

    const notes = store.getState().projectHistory.present!.melody.notes;
    const secondId = notes[1]!.id;

    // Try dragging the second note far left onto the first.
    moveNoteCmd({ id: secondId, newStartTick: 0, newMidi: 64 })(store.dispatch, store.getState);

    const moved = store.getState().projectHistory.present!.melody.notes;
    expect(moved).toHaveLength(2);
    expect(moved[0]!.startTick).toBe(0);
    expect(moved[0]!.durationTicks).toBe(480); // first note untouched
    expect(moved[1]!.startTick).toBe(480); // clamped to prevEnd
    expect(moved[1]!.durationTicks).toBe(480);
  });

  it('moveNote and moveResizeNote quantize an off-grid startTick (§3.4)', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 480, midi: 60, velocity: 90 })(store.dispatch, store.getState);

    const id = store.getState().projectHistory.present!.melody.notes[0]!.id;
    moveNoteCmd({ id, newStartTick: 500, newMidi: 60 })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.melody.notes[0]!.startTick).toBe(2 * NOTE_GRID);

    moveResizeNoteCmd({ id, newStartTick: 250, newDurationTicks: 480 })(
      store.dispatch,
      store.getState,
    );
    const moved = store.getState().projectHistory.present!.melody.notes[0]!;
    expect(moved.startTick).toBe(NOTE_GRID); // floor(250/240)*240
    expect(moved.durationTicks).toBe(480);
  });

  it('moveNote and moveNoteSemitones coerce midi to an integer (§3.5)', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 480, midi: 60, velocity: 90 })(store.dispatch, store.getState);

    const id = store.getState().projectHistory.present!.melody.notes[0]!.id;
    moveNoteCmd({ id, newStartTick: 0, newMidi: 63.6 })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.melody.notes[0]!.midi).toBe(64);

    moveNoteSemitonesCmd({ id, delta: -2.4 })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.melody.notes[0]!.midi).toBe(62);
  });

  it('resizeNote respects the next neighbor', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addNoteCmd({ startTick: 960, durationTicks: 240, midi: 64, velocity: 90 })(store.dispatch, store.getState);

    const firstId = store.getState().projectHistory.present!.melody.notes[0]!.id;
    resizeNoteCmd({ id: firstId, newDurationTicks: 3840 })(store.dispatch, store.getState);

    const notes = store.getState().projectHistory.present!.melody.notes;
    expect(notes[0]!.durationTicks).toBe(960); // capped at neighbor start
    expect(notes[1]!.startTick).toBe(960); // neighbor untouched
  });

  it('moveResizeNote applies BOTH changes as ONE history entry (§3.7/§3.8)', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 480, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addNoteCmd({ startTick: 960, durationTicks: 480, midi: 64, velocity: 90 })(store.dispatch, store.getState);

    const pastBefore = store.getState().projectHistory.past.length;
    const secondId = store.getState().projectHistory.present!.melody.notes[1]!.id;

    // Left-edge resize: pull start back to the first note's end AND grow.
    expect(
      moveResizeNoteCmd({ id: secondId, newStartTick: 0, newDurationTicks: 1440 })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);

    const notes = store.getState().projectHistory.present!.melody.notes;
    expect(notes[0]).toEqual(store.getState().projectHistory.past.at(-1)!.melody.notes[0]); // first note untouched
    expect(notes[1]!.startTick).toBe(480); // clamped into the neighbor window
    expect(notes[1]!.durationTicks).toBe(1440); // quantized, uncapped here

    // Exactly ONE new undo entry for the whole drag (§3.8).
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore + 1);

    // One undo step restores the pre-drag geometry exactly.
    store.dispatch({ type: 'history/undo' });
    const restored = store.getState().projectHistory.present!.melody.notes;
    expect(restored[1]!.startTick).toBe(960);
    expect(restored[1]!.durationTicks).toBe(480);
  });

  it('moveResizeNote caps the new length at the next neighbor', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 480, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addNoteCmd({ startTick: 960, durationTicks: 480, midi: 64, velocity: 90 })(store.dispatch, store.getState);
    addNoteCmd({ startTick: 1920, durationTicks: 480, midi: 67, velocity: 90 })(store.dispatch, store.getState);

    const notesBefore = store.getState().projectHistory.present!.melody.notes;
    const middleId = notesBefore[1]!.id;

    // Requested growth would swallow the third note — capped at its start.
    moveResizeNoteCmd({ id: middleId, newStartTick: 480, newDurationTicks: 3840 })(
      store.dispatch,
      store.getState,
    );

    const notes = store.getState().projectHistory.present!.melody.notes;
    expect(notes[1]!.startTick).toBe(480);
    expect(notes[1]!.durationTicks).toBe(1440); // end flush with neighbor start
    expect(notes[2]!.startTick).toBe(1920); // neighbor untouched
  });

  it('moveResizeChord applies BOTH fields as ONE history entry (RevUI-1 regression)', () => {
    const store = openedStore();
    // A=[0..960], B=[1920..2880], C=[2880..3840] — distinct roots so nothing
    // merges flush-to-flush.
    const add = (startTick: number, root: SpelledPitchClass) =>
      addChordRangeCmd({ startTick, durationTicks: CHORD_GRID, chord: { root, templateId: 'maj' } })(
        store.dispatch,
        store.getState,
      );
    add(0, C);
    add(2 * CHORD_GRID, D);
    add(3 * CHORD_GRID, parseSpelled('E')!);

    const chordsBefore = store.getState().projectHistory.present!.harmony.chords;
    expect(chordsBefore.map((c) => [c.startTick, c.startTick + c.durationTicks])).toEqual([
      [0, CHORD_GRID],
      [2 * CHORD_GRID, 3 * CHORD_GRID],
      [3 * CHORD_GRID, 4 * CHORD_GRID],
    ]);
    const middleId = chordsBefore[1]!.id;
    const pastBefore = store.getState().projectHistory.past.length;
    const toastsBefore = selectToasts(store.getState()).length;

    // Dragging B's LEFT edge onto A's end must extend B backwards in one
    // mutation — the old resize→move pair rejected this exact drag.
    expect(
      moveResizeChordCmd({
        id: middleId,
        newStartTick: CHORD_GRID,
        newDurationTicks: 2 * CHORD_GRID,
      })(store.dispatch, store.getState),
    ).toBe(true);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords).toHaveLength(3); // distinct roots → no merges
    expect(chords[0]).toEqual(store.getState().projectHistory.past.at(-1)!.harmony.chords[0]); // A untouched
    expect(chords[1]!.startTick).toBe(CHORD_GRID); // clamped into the window
    expect(chords[1]!.durationTicks).toBe(2 * CHORD_GRID); // B = [960..2880]
    expect(chords[2]!.startTick).toBe(3 * CHORD_GRID); // neighbor untouched
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore + 1); // ONE entry
    expect(selectToasts(store.getState())).toHaveLength(toastsBefore); // no error toast

    // One undo step restores the pre-drag geometry exactly.
    store.dispatch({ type: 'history/undo' });
    const restored = store.getState().projectHistory.present!.harmony.chords;
    expect(restored[1]!.startTick).toBe(2 * CHORD_GRID);
    expect(restored[1]!.durationTicks).toBe(CHORD_GRID);
  });

  it('moveResizeChord caps the new length at the next neighbor', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(
      store.dispatch,
      store.getState,
    );
    addChordRangeCmd({
      startTick: 2 * CHORD_GRID,
      durationTicks: CHORD_GRID,
      chord: { root: D, templateId: 'maj' },
    })(store.dispatch, store.getState);
    addChordRangeCmd({
      startTick: 3 * CHORD_GRID,
      durationTicks: CHORD_GRID,
      chord: { root: parseSpelled('E')!, templateId: 'maj' },
    })(store.dispatch, store.getState);

    const middleId = store.getState().projectHistory.present!.harmony.chords[1]!.id;

    moveResizeChordCmd({
      id: middleId,
      newStartTick: 0,
      newDurationTicks: 4 * CHORD_GRID,
    })(store.dispatch, store.getState);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords[1]!.startTick).toBe(CHORD_GRID); // clamped to prevEnd
    expect(chords[1]!.durationTicks).toBe(2 * CHORD_GRID); // end flush with neighbor start
    expect(chords[2]!.startTick).toBe(3 * CHORD_GRID); // neighbor untouched
  });

  it('deleteNote removes the note and is undoable', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const id = store.getState().projectHistory.present!.melody.notes[0]!.id;

    deleteNoteCmd({ id })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present?.melody.notes).toHaveLength(0);
    expect(store.getState().projectHistory.past).toHaveLength(2);

    store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.present?.melody.notes).toHaveLength(1);
  });

  it('setChordPatternOverride sets and clears (roundtrip)', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const chordId = store.getState().projectHistory.present!.harmony.chords[0]!.id;

    const pattern = {
      kind: 'block' as const,
      subdivisionTicks: 480 as const,
      gate: 0.9,
      octaveSpan: 1 as const,
      velocity: 100,
    };
    setChordPatternOverrideCmd({ id: chordId, pattern })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.patternOverride).toEqual(pattern);

    setChordPatternOverrideCmd({ id: chordId, pattern: null })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.patternOverride).toBeUndefined();
  });

  it('setChordPatternOverride with an identical override is a no-op (same reference, no history push)', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const chordId = store.getState().projectHistory.present!.harmony.chords[0]!.id;

    const pattern = {
      kind: 'up' as const,
      subdivisionTicks: 480 as const,
      gate: 0.8,
      octaveSpan: 2 as const,
      velocity: 100,
    };
    setChordPatternOverrideCmd({ id: chordId, pattern })(store.dispatch, store.getState);
    const afterSet = store.getState().projectHistory.present!;
    expect(afterSet.harmony.chords[0]!.patternOverride).toEqual(pattern);
    const pastBefore = store.getState().projectHistory.past.length;

    // Identical value-equality → silent no-op: same document reference, no
    // undo entry, no toast (§3.8 mutation economy via the ProjectEditor).
    expect(
      setChordPatternOverrideCmd({ id: chordId, pattern: { ...pattern } })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);
    expect(store.getState().projectHistory.present).toBe(afterSet);
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore);

    // Clearing when no override exists is also a no-op.
    setChordPatternOverrideCmd({ id: chordId, pattern: null })(store.dispatch, store.getState);
    setChordPatternOverrideCmd({ id: chordId, pattern: null })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore + 1); // only the real clear pushed
  });

  it('setChordPatternOverride replacing with a DIFFERENT spec commits one history entry; undo restores the previous override (§3.7 step 7/§3.8)', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const chordId = store.getState().projectHistory.present!.harmony.chords[0]!.id;

    const first = {
      kind: 'block' as const,
      subdivisionTicks: 480 as const,
      gate: 0.9,
      octaveSpan: 1 as const,
      velocity: 100,
    };
    setChordPatternOverrideCmd({ id: chordId, pattern: first })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.patternOverride).toEqual(first);
    const pastAfterFirst = store.getState().projectHistory.past.length;

    const second = {
      kind: 'up' as const,
      subdivisionTicks: 240 as const,
      gate: 0.8,
      octaveSpan: 1 as const,
      velocity: 90,
    };
    setChordPatternOverrideCmd({ id: chordId, pattern: second })(store.dispatch, store.getState);
    // Exactly ONE new undo entry for the replacement — not two.
    expect(store.getState().projectHistory.past).toHaveLength(pastAfterFirst + 1);
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.patternOverride).toEqual(second);

    store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.patternOverride).toEqual(first);

    store.dispatch({ type: 'history/redo' });
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.patternOverride).toEqual(second);
  });

  it('setChordPatternOverrideCmd with an unknown chord id returns false, pushes the «Аккорд не найден» error toast, and leaves history untouched (§3.20 command seam)', () => {
    const store = openedStore();
    const before = store.getState().projectHistory.present;
    const pastBefore = store.getState().projectHistory.past.length;

    const pattern = {
      kind: 'up' as const,
      subdivisionTicks: 480 as const,
      gate: 0.8,
      octaveSpan: 1 as const,
      velocity: 80,
    };
    expect(
      setChordPatternOverrideCmd({ id: 'missing', pattern })(store.dispatch, store.getState),
    ).toBe(false);

    const toast = lastToast(store);
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toBe('Аккорд не найден');
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore);
    expect(store.getState().projectHistory.present).toBe(before);
  });

  it('moveChord and moveResizeChord quantize an off-grid startTick (§3.4)', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const chordId = store.getState().projectHistory.present!.harmony.chords[0]!.id;

    moveChordCmd({ id: chordId, newStartTick: 1000 })(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.startTick).toBe(CHORD_GRID);

    moveResizeChordCmd({ id: chordId, newStartTick: 1005, newDurationTicks: CHORD_GRID })(
      store.dispatch,
      store.getState,
    );
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.startTick).toBe(CHORD_GRID);
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.durationTicks).toBe(CHORD_GRID);
  });

  it('setBpm rejects 999 with an error toast and keeps bpm', () => {
    const store = openedStore();
    expect(changeBpmCmd(999)(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present?.timing.bpm).toBe(120);
    expect(store.getState().projectHistory.past).toHaveLength(0);
    expect(lastToast(store)?.kind).toBe('error');
  });

  it('setBpm accepts a fractional tempo within the range (§3.5)', () => {
    const store = openedStore();
    expect(changeBpmCmd(120.5)(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.present?.timing.bpm).toBe(120.5);
  });

  it('selection / viewport / toast actions never touch history', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const history = store.getState().projectHistory;

    selectNoteCmd('note-1')(store.dispatch);
    selectChordCmd('chord-1')(store.dispatch);
    selectRangeCmd(0, 1920)(store.dispatch);
    clearSelectionCmd()(store.dispatch);
    setActiveToolCmd('drawNote')(store.dispatch);
    store.dispatch({ type: 'session/viewportChanged', payload: { scrollTick: 960, zoomPxPerBeat: 80 } });
    store.dispatch({ type: 'session/toastPushed', payload: { toast: { id: 't1', kind: 'info', message: 'hi' } } });

    expect(store.getState().projectHistory).toBe(history);
    expect(selectSelection(store.getState())).toBeNull();
  });

  it('MAX_MELODY_NOTES: addNote beyond 2000 notes is rejected with a toast', () => {
    const doc = freshDoc();
    // Seed document only: notes start past the added range so nothing is
    // replaced — rejection comes from the projected-size check (§3.21).
    const notes = Array.from({ length: 2000 }, (_, i) => ({
      id: `n${i}`,
      startTick: 480 + (i % 128) * NOTE_GRID,
      durationTicks: NOTE_GRID,
      midi: 60,
      velocity: 90,
    }));
    const seeded: ProjectDocumentV1 = { ...doc, melody: { notes } };
    const store = makeStore();
    store.dispatch({ type: 'document/replacedFromLoad', payload: { project: seeded } });

    const before = store.getState().projectHistory.present;
    expect(addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(lastToast(store)?.kind).toBe('error');
    expect(store.getState().projectHistory.past).toHaveLength(0);
  });

  it('out-of-scale note over C major applies cleanly and classifies chromatic', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const toastsBefore = selectToasts(store.getState()).length;

    // F#4 (midi 66) is outside C ionian and outside the C major triad.
    expect(addNoteCmd({ startTick: 0, durationTicks: 480, midi: 66, velocity: 90 })(store.dispatch, store.getState)).toBe(true);

    expect(selectToasts(store.getState())).toHaveLength(toastsBefore); // no error toast
    const noteId = store.getState().projectHistory.present!.melody.notes[0]!.id;
    const spans = selectNoteAnalysisMap(store.getState()).get(noteId)!;
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.classification).toBe('chromatic');
    }
  });

  it('MAX_CHORD_EVENTS: addChordRange beyond 512 chords is rejected with a toast', () => {
    const doc = freshDoc();
    // Seed document only: chords start past the added range so nothing is
    // replaced — rejection comes from the projected-size check (§3.21).
    const chords = Array.from({ length: 512 }, (_, i) => ({
      id: `c${i}`,
      startTick: (i + 1) * CHORD_GRID,
      durationTicks: CHORD_GRID,
      chord: { root: i % 2 ? C : D, templateId: 'maj' as const },
    }));
    const seeded: ProjectDocumentV1 = { ...doc, harmony: { ...doc.harmony, chords } };
    const store = makeStore();
    store.dispatch({ type: 'document/replacedFromLoad', payload: { project: seeded } });

    const before = store.getState().projectHistory.present;
    expect(addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(lastToast(store)?.kind).toBe('error');
    expect(lastToast(store)?.message).toContain('512');
    expect(store.getState().projectHistory.past).toHaveLength(0);
  });

  it('addNote caps duration at project length (§3.4 invariant)', () => {
    const store = openedStore();
    const length = projectLengthTicks(store.getState().projectHistory.present!);

    expect(addNoteCmd({ startTick: 0, durationTicks: length * 2, midi: 60, velocity: 90 })(store.dispatch, store.getState)).toBe(true);

    const doc = store.getState().projectHistory.present!;
    const note = doc.melody.notes[0]!;
    expect(note.startTick).toBe(0);
    expect(note.durationTicks).toBe(length);
    expect(note.startTick + note.durationTicks).toBeLessThanOrEqual(projectLengthTicks(doc));
  });

  it('addChordRange caps duration at project length (§3.4 invariant)', () => {
    const store = openedStore();
    const length = projectLengthTicks(store.getState().projectHistory.present!);

    expect(
      addChordRangeCmd({ startTick: 0, durationTicks: length * 2, chord: { root: C, templateId: 'maj' } })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);

    const doc = store.getState().projectHistory.present!;
    const chord = doc.harmony.chords[0]!;
    expect(chord.startTick).toBe(0);
    expect(chord.durationTicks).toBe(length);
  });

  it('MAX_MELODY_NOTES: a replacing add that shrinks the lane at the cap is accepted', () => {
    // §3.4: the seed itself must be legal — 2000 non-overlapping grid notes
    // need 2000*240 ticks, so widen the project to 128 bars.
    const doc = createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian', bars: 128 });
    // Exactly at the cap; notes n0/n1 are adjacent at 480/720. The added
    // note [480, 960) replaces both with one → net shrink → §3.21 allows it.
    const notes = Array.from({ length: MAX_MELODY_NOTES }, (_, i) => ({
      id: `n${i}`,
      startTick: i < 2 ? 480 + i * NOTE_GRID : 960 + (i - 2) * NOTE_GRID,
      durationTicks: NOTE_GRID,
      midi: 60,
      velocity: 90,
    }));
    const seeded: ProjectDocumentV1 = { ...doc, melody: { notes } };
    const store = makeStore();
    store.dispatch({ type: 'document/replacedFromLoad', payload: { project: seeded } });

    expect(addNoteCmd({ startTick: 480, durationTicks: 2 * NOTE_GRID, midi: 62, velocity: 90 })(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.present!.melody.notes).toHaveLength(MAX_MELODY_NOTES - 1);
  });

  it('MAX_CHORD_EVENTS: a replacing add that shrinks the lane at the cap is accepted', () => {
    // §3.4: the seed itself must be legal — 512 chord slots need 512*960
    // ticks, so widen the project to 128 bars.
    const doc = createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian', bars: 128 });
    // Exactly at the cap. The added chord covers the LAST two slots and
    // replaces both with one → net shrink → §3.21 allows it.
    const chords = Array.from({ length: MAX_CHORD_EVENTS }, (_, i) => ({
      id: `c${i}`,
      startTick: i * CHORD_GRID,
      durationTicks: CHORD_GRID,
      chord: { root: i % 2 ? C : D, templateId: 'maj' as const },
    }));
    const seeded: ProjectDocumentV1 = { ...doc, harmony: { ...doc.harmony, chords } };
    const store = makeStore();
    store.dispatch({ type: 'document/replacedFromLoad', payload: { project: seeded } });

    expect(
      addChordRangeCmd(
        {
          startTick: (MAX_CHORD_EVENTS - 2) * CHORD_GRID,
          durationTicks: 2 * CHORD_GRID,
          // Root differs from the preceding c509 (C) — no §3.7 step 7 merge.
          chord: { root: D, templateId: 'maj' },
        },
      )(store.dispatch, store.getState),
    ).toBe(true);
    expect(store.getState().projectHistory.present!.harmony.chords).toHaveLength(MAX_CHORD_EVENTS - 1);
  });

  it('replacedFromLoad resets history', () => {
    const store = openedStore();

    // §3.8: undo on empty past is a no-op — future must stay empty.
    store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.past).toHaveLength(0);
    expect(store.getState().projectHistory.future).toHaveLength(0);

    // Real reset path: build past+future first, then load replaces both.
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.past).toHaveLength(0);
    expect(store.getState().projectHistory.future).toHaveLength(1);

    store.dispatch({ type: 'document/replacedFromLoad', payload: { project: freshDoc() } });
    expect(store.getState().projectHistory.past).toHaveLength(0);
    expect(store.getState().projectHistory.future).toHaveLength(0);
  });

  it('setNoteVelocity clamps out-of-range values via command validation', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const id = store.getState().projectHistory.present!.melody.notes[0]!.id;

    expect(setNoteVelocityCmd({ id, velocity: 500 })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present!.melody.notes[0]!.velocity).toBe(90);
    expect(setNoteVelocityCmd({ id, velocity: 40 })(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.present!.melody.notes[0]!.velocity).toBe(40);
  });
});

describe('transpose and mode flows (§3.14)', () => {
  function docWithNoteAndChord(): ProjectDocumentV1 {
    return freshDoc();
  }

  it('transpose overflow → error toast, document unchanged', () => {
    const store = openedStore(docWithNoteAndChord());
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 96, velocity: 90 })(store.dispatch, store.getState);

    const before = store.getState().projectHistory.present;
    expect(transposeToTonicCmd(D)(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    const toast = lastToast(store);
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('1 нота выйдет');
  });

  it('transpose C→D respells roots to D, undo restores C', () => {
    const store = openedStore(docWithNoteAndChord());
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);

    expect(transposeToTonicCmd(D)(store.dispatch, store.getState)).toBe(true);

    const doc = store.getState().projectHistory.present!;
    expect(doc.harmonyContext.tonic).toEqual(D);
    expect(doc.harmony.chords[0]!.chord.root).toEqual(D);
    expect(doc.melody.notes[0]!.midi).toBe(62);
    expect(lastToast(store)?.kind).toBe('success');

    store.dispatch({ type: 'history/undo' });
    const restored = store.getState().projectHistory.present!;
    expect(restored.harmonyContext.tonic).toEqual(C);
    expect(restored.harmony.chords[0]!.chord.root).toEqual(C);
    expect(restored.melody.notes[0]!.midi).toBe(60);
  });

  it('transpose onto a doc violating a NON load-tolerated invariant → error toast, no history entry', () => {
    // §3.7 step 8: replacedFromLoad bypasses the gate, so a loaded doc can
    // carry 'overlap'/'out_of_bounds' legally — those stay accepted. Any
    // other violation kind arrives only through a bug; the transposed result
    // inherits it and applyProjectEdit rejects it as invariant_violation.
    const chord = { root: C, templateId: 'maj' } as const;
    const base = freshDoc();
    const store = openedStore({
      ...base,
      harmony: {
        ...base.harmony,
        chords: [
          { id: 'a', startTick: 0, durationTicks: 2 * CHORD_GRID, chord },
          { id: 'bad', startTick: 1, durationTicks: CHORD_GRID, chord }, // off-grid
        ],
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const before = store.getState().projectHistory.present;
    expect(transposeToTonicCmd(D)(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past).toHaveLength(0);
    const toast = lastToast(store);
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('инварианты');

    error.mockRestore();
  });

  it('setModeCmd keeps melody midis byte-equal', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const midisBefore = store.getState().projectHistory.present!.melody.notes.map((n) => n.midi);

    expect(setModeCmd('dorian')(store.dispatch, store.getState)).toBe(true);
    const midisAfter = store.getState().projectHistory.present!.melody.notes.map((n) => n.midi);
    expect(midisAfter).toEqual(midisBefore);
    expect(store.getState().projectHistory.present!.harmonyContext.mode).toBe('dorian');
  });
});

describe('derived selectors', () => {
  it('selectResolvedVoicings: one entry per chord, roles aligned to notes', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: 960, durationTicks: 960, chord: { root: parseSpelled('G')!, templateId: 'maj' } })(store.dispatch, store.getState);

    const voicings = selectResolvedVoicings(store.getState());
    expect(voicings).toHaveLength(2);
    for (const voicing of voicings) {
      expect(voicing.midiNotes.length).toBeGreaterThan(0);
      expect(voicing.toneRoles).toHaveLength(voicing.midiNotes.length);
    }
  });

  it('selectNoteAnalysisMap splits a long note across a chord boundary', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 1920, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: 960, durationTicks: 960, chord: { root: parseSpelled('G')!, templateId: 'maj' } })(store.dispatch, store.getState);

    const map = selectNoteAnalysisMap(store.getState());
    const noteId = store.getState().projectHistory.present!.melody.notes[0]!.id;
    const spans = map.get(noteId)!;
    expect(spans).toHaveLength(2);
    expect(spans[0]!.chordEventId).not.toBe(spans[1]!.chordEventId);
  });

  it('selectChordLabels gives symbol and roman numeral per chord id', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);

    const labels = selectChordLabels(store.getState());
    const chordId = store.getState().projectHistory.present!.harmony.chords[0]!.id;
    const label = labels.get(chordId)!;
    expect(label.symbol).toBe('C');
    expect(label.roman.length).toBeGreaterThan(0);
  });

  it('selectRecommendations returns ≤32 unique cards with valid categories', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);

    const select = createSelectRecommendations();
    const recommendations = select(store.getState(), { startTick: 960, durationTicks: 960 });

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations.length).toBeLessThanOrEqual(32);
    const signatures = new Set(recommendations.map((r) => `${r.chord.root.letter}${r.chord.templateId}`));
    expect(signatures.size).toBe(recommendations.length);
    for (const rec of recommendations) {
      expect(['safe', 'smooth', 'strong', 'color']).toContain(rec.category);
      expect(rec.romanNumeral.length).toBeGreaterThan(0);
      expect(rec.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('document setter no-op equality short-circuits', () => {
  it('setNoteSpellingOverrideCmd with the current value keeps history and reference', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const id = store.getState().projectHistory.present!.melody.notes[0]!.id;

    expect(setNoteSpellingOverrideCmd({ id, override: C })(store.dispatch, store.getState)).toBe(true);
    const afterSet = store.getState().projectHistory;
    const pastLengthAfterSet = store.getState().projectHistory.past.length;
    expect(pastLengthAfterSet).toBeGreaterThan(0);

    // Re-dispatching the identical override is a no-op: same document
    // reference, no history push.
    expect(store.getState().projectHistory.past).toHaveLength(pastLengthAfterSet);
    expect(store.getState().projectHistory.present).toBe(afterSet.present);
  });

  it('setDefaultPatternCmd with an equivalent PatternSpec keeps history and reference', () => {
    const store = openedStore();
    const before = store.getState().projectHistory;

    const equivalent = {
      kind: 'block',
      subdivisionTicks: 480,
      gate: 0.9,
      octaveSpan: 1,
      velocity: 80,
    } as const;
    setDefaultPatternCmd(equivalent)(store.dispatch, store.getState);
    expect(store.getState().projectHistory.past).toHaveLength(0);
    expect(store.getState().projectHistory.present).toBe(before.present);
  });

  it('changeBpmCmd with the current bpm is a silent no-op', () => {
    const store = openedStore();
    const before = store.getState().projectHistory;
    const toastsBefore = selectToasts(store.getState()).length;

    expect(changeBpmCmd(120)(store.dispatch, store.getState)).toBe(true);

    expect(store.getState().projectHistory.past).toHaveLength(0);
    expect(store.getState().projectHistory.present).toBe(before.present);
    expect(selectToasts(store.getState())).toHaveLength(toastsBefore);
  });

  it('setChordSpecCmd with a byte-identical spec is a silent no-op; a new spec applies', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } })(
      store.dispatch,
      store.getState,
    );
    const id = store.getState().projectHistory.present!.harmony.chords[0]!.id;
    const toastsBefore = selectToasts(store.getState()).length;
    const pastAfterAdd = store.getState().projectHistory.past.length;

    expect(setChordSpecCmd({ id, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.past).toHaveLength(pastAfterAdd);
    expect(selectToasts(store.getState())).toHaveLength(toastsBefore);

    // A genuinely different spec still applies and is undoable.
    expect(setChordSpecCmd({ id, chord: { root: C, templateId: 'min' } })(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.past).toHaveLength(pastAfterAdd + 1);
    expect(store.getState().projectHistory.present!.harmony.chords[0]!.chord.templateId).toBe('min');
  });

  it('openProjectCmd clears the session selection (§3.15)', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: 240, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const noteId = store.getState().projectHistory.present!.melody.notes[0]!.id;
    selectNoteCmd(noteId)(store.dispatch);
    expect(selectSelection(store.getState())).not.toBeNull();

    openProjectCmd(freshDoc())(store.dispatch);

    expect(selectSelection(store.getState())).toBeNull();
  });
});

describe('history branching (§3.8 past/present/future)', () => {
  it('undo then a new canonical action clears the redo stack; redo afterwards is a no-op', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState); // A
    addNoteCmd({ startTick: NOTE_GRID, durationTicks: NOTE_GRID, midi: 62, velocity: 90 })(store.dispatch, store.getState); // B

    store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.future).toHaveLength(1);

    // Canonical new action after undo: the future branch is discarded.
    addNoteCmd({ startTick: 2 * NOTE_GRID, durationTicks: NOTE_GRID, midi: 64, velocity: 90 })(store.dispatch, store.getState); // C
    const afterC = store.getState().projectHistory;
    expect(afterC.present?.melody.notes).toHaveLength(2);
    expect(afterC.past).toHaveLength(2); // [initial, after-A] — the discarded B branch is gone
    expect(afterC.future).toEqual([]);

    // Redo must not resurrect the discarded B-branch state.
    store.dispatch({ type: 'history/redo' });
    expect(store.getState().projectHistory).toEqual(afterC);
  });

  it('draining undo then draining redo returns the byte-equal latest document; extra redo changes nothing', () => {
    const store = openedStore();
    const initial = store.getState().projectHistory.present;

    for (let i = 0; i < 3; i += 1) {
      addNoteCmd({ startTick: i * NOTE_GRID, durationTicks: NOTE_GRID, midi: 60 + i, velocity: 90 })(store.dispatch, store.getState);
    }
    const latest = store.getState().projectHistory.present;

    for (let i = 0; i < 3; i += 1) store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.present).toEqual(initial);

    for (let i = 0; i < 3; i += 1) store.dispatch({ type: 'history/redo' });
    expect(store.getState().projectHistory.present).toEqual(latest);

    store.dispatch({ type: 'history/redo' }); // past the end
    expect(store.getState().projectHistory.present).toEqual(latest);
  });
});

describe('diatonic nudge at the §3.5 midi range edges', () => {
  it('ArrowUp at midi 96 finds no target and never moves the note out of range', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 96, velocity: 90 })(store.dispatch, store.getState);
    const noteId = store.getState().projectHistory.present!.melody.notes[0]!.id;
    selectNoteCmd(noteId)(store.dispatch);
    const before = store.getState().projectHistory.present;

    // The shortcut layer (useEditorShortcuts ArrowUp) dispatches ONLY when
    // diatonicStepTargetMidi returns a target; at the top edge it returns
    // null → no command → document untouched.
    const target = diatonicStepTargetMidi(96, 1, selectHarmonyContext(store.getState()));
    expect(target).toBeNull();
    expect(store.getState().projectHistory.present).toEqual(before);

    // The mirror direction stays inside the range.
    const downTarget = diatonicStepTargetMidi(96, -1, selectHarmonyContext(store.getState()));
    expect(downTarget).not.toBeNull();
    expect(downTarget!).toBeGreaterThanOrEqual(36);
    expect(downTarget!).toBeLessThanOrEqual(96);
    moveNoteCmd({ id: noteId, newStartTick: 0, newMidi: downTarget! })(store.dispatch, store.getState);
    expect(validateProjectDocument(store.getState().projectHistory.present).ok).toBe(true);
    expect(store.getState().projectHistory.present!.melody.notes[0]!.midi).toBe(95);
  });

  it('ArrowDown at midi 36 finds no target; ArrowUp lands on a scale pitch in range', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 36, velocity: 90 })(store.dispatch, store.getState);
    const noteId = store.getState().projectHistory.present!.melody.notes[0]!.id;
    selectNoteCmd(noteId)(store.dispatch);

    expect(diatonicStepTargetMidi(36, -1, selectHarmonyContext(store.getState()))).toBeNull();
    expect(store.getState().projectHistory.present!.melody.notes[0]!.midi).toBe(36);

    const upTarget = diatonicStepTargetMidi(36, 1, selectHarmonyContext(store.getState()));
    expect(upTarget).not.toBeNull();
    expect(upTarget!).toBeGreaterThanOrEqual(36);
    expect(upTarget!).toBeLessThanOrEqual(96);
    moveNoteCmd({ id: noteId, newStartTick: 0, newMidi: upTarget! })(store.dispatch, store.getState);
    expect(validateProjectDocument(store.getState().projectHistory.present).ok).toBe(true);
  });
});

describe('non-finite midi/velocity ingress is rejected (§3.5/§3.7 step 8)', () => {
  it('addNoteCmd with NaN midi leaves the doc unchanged with no history entry', () => {
    const store = openedStore();
    const before = store.getState().projectHistory.present;

    expect(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: Number.NaN, velocity: 90 })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past).toHaveLength(0);

    expect(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: Number.NaN })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past).toHaveLength(0);
  });

  it('moveNoteCmd with NaN newMidi leaves the doc unchanged with no history entry', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const before = store.getState().projectHistory.present;
    const pastLength = store.getState().projectHistory.past.length;
    const noteId = before!.melody.notes[0]!.id;

    expect(moveNoteCmd({ id: noteId, newStartTick: NOTE_GRID, newMidi: Number.NaN })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past).toHaveLength(pastLength);
  });

  it('moveNoteSemitonesCmd with NaN delta returns false and keeps the doc unchanged', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const before = store.getState().projectHistory.present;
    const noteId = before!.melody.notes[0]!.id;

    expect(moveNoteSemitonesCmd({ id: noteId, delta: Number.NaN })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past).toHaveLength(1);
  });

  it('setNoteVelocityCmd with NaN velocity returns false and keeps the doc unchanged', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const before = store.getState().projectHistory.present;
    const noteId = before!.melody.notes[0]!.id;

    expect(setNoteVelocityCmd({ id: noteId, velocity: Number.NaN })(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past).toHaveLength(1);
  });

  it('the §3.4 sweep rejects ANY mutation once a lane carries non-canonical pitch', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    // Bypass the reducer like REPLACED_FROM_LOAD does, then corrupt pitch.
    const corrupted = structuredClone(store.getState().projectHistory.present!);
    corrupted.melody.notes[0]!.midi = 127; // outside §3.5 [36..96]
    store.dispatch(openProjectCmd(corrupted));
    const before = store.getState().projectHistory.present;

    expect(changeBpmCmd(90)(store.dispatch, store.getState)).toBe(false);
    expect(store.getState().projectHistory.present).toBe(before);
  });
});

describe('history cap under undo/redo (§3.8)', () => {
  it('undo then redo at the cap keeps past within MAX_UNDO_ENTRIES', () => {
    const store = openedStore();
    for (let i = 0; i < 100; i += 1) {
      addNoteCmd({ startTick: i * NOTE_GRID, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    }
    store.dispatch({ type: 'history/undo' });
    store.dispatch({ type: 'history/redo' });
    expect(store.getState().projectHistory.past).toHaveLength(100);
  });
});

// CMD-N1 (round 5): the closed-document guard in runEdit — any document
// command with no project open must return false, toast the shared «Проект не
// открыт» (not the command-specific failureMessage), and leave history null.
describe('closed-document command dispatch (§3.20 command seam)', () => {
  it('with no document open, a document command returns false, surfaces «Проект не открыт», and leaves history untouched', () => {
    // Arrange: fresh store WITHOUT opening a document.
    const store = makeStore();
    expect(store.getState().projectHistory.present).toBeNull();

    // Act: two different command families through the same seam.
    const addNoteResult = addNoteCmd({
      startTick: 0,
      durationTicks: NOTE_GRID * 2,
      midi: 60,
      velocity: 90,
    })(store.dispatch, store.getState);
    const velocityResult = setNoteVelocityCmd({ id: 'x', velocity: 80 })(
      store.dispatch,
      store.getState,
    );

    // Assert: both rejected, shared closed-project toast, no history entry.
    expect(addNoteResult).toBe(false);
    expect(velocityResult).toBe(false);
    const toast = lastToast(store);
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toBe('Проект не открыт');
    expect(store.getState().projectHistory.present).toBeNull();

    expect(store.getState().projectHistory.past).toHaveLength(0);
  });
});
// SEL-2 (round 8): §3.8 «add/remove bars» as one undoable document mutation.
// Growing keeps every event byte-identical; shrinking drops events fully at/
// after the new boundary, truncates straddlers (ids preserved), and a single
// undo restores the full document. Non-finite/non-integer/out-of-range input
// is rejected by the ProjectEditor with no history entry (BARS-A1).
describe('setBars document flow (§3.8 add/remove bars)', () => {
  it('growing bars keeps all melody notes and chords unchanged', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const before = store.getState().projectHistory.present!;

    expect(setBarsCmd(before.timing.bars + 8)(store.dispatch, store.getState)).toBe(true);

    const after = store.getState().projectHistory.present!;
    expect(after.timing.bars).toBe(before.timing.bars + 8);
    expect(after.melody.notes).toEqual(before.melody.notes);
    expect(after.harmony.chords).toEqual(before.harmony.chords);
    expect(projectLengthTicks(after)).toBe(after.timing.bars * TICKS_PER_BAR);
  });

  it('shrinking drops beyond-boundary events and truncates straddlers, preserving ids', () => {
    const store = openedStore();
    // Boundary of 2 bars: 2 * TICKS_PER_BAR = 7680.
    const boundary = 2 * TICKS_PER_BAR;
    // Fully inside — survives untouched.
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    // Straddler — truncated to end exactly at the boundary.
    addNoteCmd({ startTick: boundary - NOTE_GRID, durationTicks: NOTE_GRID * 3, midi: 62, velocity: 90 })(store.dispatch, store.getState);
    // Fully at/after the boundary — removed.
    addNoteCmd({ startTick: boundary + NOTE_GRID, durationTicks: NOTE_GRID, midi: 64, velocity: 90 })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: boundary - CHORD_GRID, durationTicks: CHORD_GRID * 3, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: boundary + CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'maj' } })(store.dispatch, store.getState);

    const idsBefore = {
      notes: store.getState().projectHistory.present!.melody.notes.map((n) => n.id),
      chords: store.getState().projectHistory.present!.harmony.chords.map((c) => c.id),
    };

    expect(setBarsCmd(2)(store.dispatch, store.getState)).toBe(true);

    const doc = store.getState().projectHistory.present!;
    expect(doc.timing.bars).toBe(2);
    expect(projectLengthTicks(doc)).toBe(boundary);

    expect(doc.melody.notes).toHaveLength(2);
    expect(doc.melody.notes.map((n) => n.id)).toEqual(idsBefore.notes.slice(0, 2));
    expect(doc.melody.notes[0]).toMatchObject({ startTick: 0, durationTicks: NOTE_GRID });
    // Straddler truncated to the boundary; id unchanged.
    expect(doc.melody.notes[1]).toMatchObject({ startTick: boundary - NOTE_GRID, durationTicks: NOTE_GRID });

    expect(doc.harmony.chords).toHaveLength(1);
    expect(doc.harmony.chords[0]!.id).toBe(idsBefore.chords[0]);
    expect(doc.harmony.chords[0]).toMatchObject({ startTick: boundary - CHORD_GRID, durationTicks: CHORD_GRID });

    expect(validateProjectDocument(doc).ok).toBe(true);
  });

  it('a shrink is ONE undo entry: undo restores the full pre-shrink document', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 6 * TICKS_PER_BAR, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: 5 * TICKS_PER_BAR, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const fullDoc = store.getState().projectHistory.present!;

    setBarsCmd(2)(store.dispatch, store.getState);
    expect(store.getState().projectHistory.present!.melody.notes).toHaveLength(0);

    store.dispatch({ type: 'history/undo' });
    expect(store.getState().projectHistory.present).toEqual(fullDoc);
    expect(store.getState().projectHistory.past).toHaveLength(2); // initial open, then the two adds — exactly ONE entry for the shrink
  });

  it('non-integer/NaN/out-of-range command input is rejected without touching state or history', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const before = store.getState().projectHistory;

    for (const bad of [2.5, Number.NaN, Number.POSITIVE_INFINITY, MIN_BARS - 1, MAX_BARS + 1]) {
      expect(setBarsCmd(bad)(store.dispatch, store.getState)).toBe(false);
      const toast = lastToast(store);
      expect(toast?.kind).toBe('error');
      expect(toast?.message).toBe(`Количество тактов должно быть целым числом от ${MIN_BARS} до ${MAX_BARS}`);
    }

    expect(store.getState().projectHistory.present).toEqual(before.present);
    expect(store.getState().projectHistory.past).toEqual(before.past);
    expect(store.getState().projectHistory.future).toEqual(before.future);
  });

  it('re-entering the current bar count is a silent semantic no-op', () => {
    const store = openedStore();
    const pastLen = store.getState().projectHistory.past.length;
    expect(setBarsCmd(freshDoc().timing.bars)(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.past.length).toBe(pastLen);
  });

  it('out-of-range/non-integer bar counts are rejected by the ProjectEditor, never clamped (BARS-A1)', () => {
    // The old reducer silently CLAMPED raw out-of-range payloads; that
    // branch was unreachable through commands and is gone — the editor
    // rejects out-of-range values outright.
    const store = openedStore();
    const doc = store.getState().projectHistory.present!;

    for (const bad of [MAX_BARS + 50, -10, Number.NaN, 8.5]) {
      expect(applyProjectEdit(doc, { kind: 'setBars', bars: bad })).toEqual({
        kind: 'rejected',
        reason: { kind: 'bars_out_of_range' },
      });
    }

    // MIN/MAX themselves stay legal end-to-end.
    expect(setBarsCmd(MIN_BARS)(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.present!.timing.bars).toBe(MIN_BARS);
    expect(setBarsCmd(MAX_BARS)(store.dispatch, store.getState)).toBe(true);
    expect(store.getState().projectHistory.present!.timing.bars).toBe(MAX_BARS);
  });

  it('BARS-E1 (§3.8): an event ending exactly at the new boundary survives whole — kept by reference, never truncated, in BOTH lanes', () => {
    const store = openedStore();
    const boundary = 2 * TICKS_PER_BAR;
    // Each event ends EXACTLY at the shrink boundary: startTick + durationTicks === boundary.
    addNoteCmd({ startTick: boundary - NOTE_GRID, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: boundary - CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    const noteRef = store.getState().projectHistory.present!.melody.notes[0];
    const chordRef = store.getState().projectHistory.present!.harmony.chords[0];

    expect(setBarsCmd(2)(store.dispatch, store.getState)).toBe(true);

    const doc = store.getState().projectHistory.present!;
    expect(doc.timing.bars).toBe(2);
    expect(doc.melody.notes).toHaveLength(1);
    expect(doc.harmony.chords).toHaveLength(1);
    // Identity IS the contract for untouched events through a resize
    // (round-5 §5.2 / round-6 §5.2): no truncation, no gratuitous clone.
    expect(doc.melody.notes[0]).toBe(noteRef);
    expect(doc.harmony.chords[0]).toBe(chordRef);
    expect(doc.melody.notes[0]!.durationTicks).toBe(NOTE_GRID);
    expect(doc.harmony.chords[0]!.durationTicks).toBe(CHORD_GRID);
    expect(validateProjectDocument(doc).ok).toBe(true);
  });
});

// SEL-1 (round 8): deleting an event must not leave a dangling selection.
describe('selection cleanup after delete (§3.16)', () => {
  it('deleting the selected note clears the selection', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addNoteCmd({ startTick: NOTE_GRID, durationTicks: NOTE_GRID, midi: 62, velocity: 90 })(store.dispatch, store.getState);
    const [firstId] = store.getState().projectHistory.present!.melody.notes.map((n) => n.id);
    selectNoteCmd(firstId!)(store.dispatch);
    expect(selectSelection(store.getState())).toEqual({ kind: 'note', id: firstId });

    expect(deleteNoteCmd({ id: firstId! })(store.dispatch, store.getState)).toBe(true);

    expect(selectSelection(store.getState())).toBeNull();
  });

  it('deleting a different note leaves the selection alone', () => {
    const store = openedStore();
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    addNoteCmd({ startTick: NOTE_GRID, durationTicks: NOTE_GRID, midi: 62, velocity: 90 })(store.dispatch, store.getState);
    const [firstId, secondId] = store.getState().projectHistory.present!.melody.notes.map((n) => n.id);
    selectNoteCmd(secondId!)(store.dispatch);
    expect(selectSelection(store.getState())).toEqual({ kind: 'note', id: secondId });
    deleteNoteCmd({ id: firstId! })(store.dispatch, store.getState);

    expect(selectSelection(store.getState())).toEqual({ kind: 'note', id: secondId });
  });

  it('deleting the selected chord clears the selection', () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'min' } })(store.dispatch, store.getState);
    const chords = store.getState().projectHistory.present!.harmony.chords;
    selectChordCmd(chords[0]!.id)(store.dispatch);

    expect(deleteChordCmd({ id: chords[0]!.id })(store.dispatch, store.getState)).toBe(true);

    expect(selectSelection(store.getState())).toBeNull();
  });

  it("deleting a chord clears ONLY a matching chord selection: a different chord's selection and a cross-lane note selection survive", () => {
    const store = openedStore();
    addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState);
    addChordRangeCmd({ startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'min' } })(store.dispatch, store.getState);
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 })(store.dispatch, store.getState);
    const [firstId, secondId] = store.getState().projectHistory.present!.harmony.chords.map((c) => c.id);
    const [noteId] = store.getState().projectHistory.present!.melody.notes.map((n) => n.id);

    // Same lane: another chord's selection survives the delete.
    selectChordCmd(secondId!)(store.dispatch);
    expect(selectSelection(store.getState())).toEqual({ kind: 'chord', id: secondId });
    expect(deleteChordCmd({ id: firstId! })(store.dispatch, store.getState)).toBe(true);
    expect(selectSelection(store.getState())).toEqual({ kind: 'chord', id: secondId });

    // Cross-kind guard: a NOTE selection survives a successful CHORD delete.
    selectNoteCmd(noteId!)(store.dispatch);
    expect(deleteChordCmd({ id: secondId! })(store.dispatch, store.getState)).toBe(true);
    expect(selectSelection(store.getState())).toEqual({ kind: 'note', id: noteId });
  });
});

describe('openProjectByIdCmd staleness (§3.18)', () => {
  afterEach(() => {
    setDependenciesForTesting(null);
  });

  function stubDeps(open: AppDependencies['projects']['open']): AppDependencies {
    return {
      projects: {
        list: async () => [],
        create: async () => undefined,
        open,
        scheduleSave: () => undefined,
        retrySave: () => undefined,
        duplicate: async () => {
          throw new Error('unreachable');
        },
        delete: async () => undefined,
        flushBeforeUnload: async () => true,
        flushOnProjectSwitch: async () => true,
        subscribe: () => () => undefined,
      },
      transport: getProjectTransport(),
      downloadBackup: () => undefined,
      downloadMidi: async () => ({ ok: true, filename: 'stub.mid' }),
    };
  }

  it('a stale resolution commits nothing: no REPLACED_FROM_LOAD, no session reset', async () => {
    // Slow-open A gated in flight; B opens and completes first.
    let releaseA!: (result: { kind: 'ok'; document: ProjectDocumentV1 }) => void;
    const gateA = new Promise<{ kind: 'ok'; document: ProjectDocumentV1 }>((resolve) => {
      releaseA = resolve;
    });
    const docB = createProjectDocument({ title: 'Проект B', tonic: C, mode: 'ionian' });
    setDependenciesForTesting(
      stubDeps(async (id) =>
        id === 'slow-a' ? await gateA : { kind: 'ok', document: docB },
      ),
    );

    // A late REPLACED_FROM_LOAD or session reset would be observable here:
    // the document title flips back and activeProjectId leaves docB.
    const store = makeStore();

    const slowPromise = openProjectByIdCmd('slow-a')(store.dispatch);
    const fastResult = await openProjectByIdCmd('fast-b')(store.dispatch);
    expect(fastResult.kind).toBe('ok');
    // B committed exactly once.
    expect(store.getState().projectHistory.present?.title).toBe('Проект B');
    expect(store.getState().session.activeProjectId).toBe(docB.id);

    // A resolves AFTER B started — it must not replace B's document under
    // /project/B (edits would autosave onto the wrong id).
    releaseA({ kind: 'ok', document: freshDoc() });
    const slowResult = await slowPromise;
    expect(slowResult.kind).toBe('stale');

    expect(store.getState().projectHistory.present?.title).toBe('Проект B');
    expect(store.getState().session.activeProjectId).toBe(docB.id);
    expect(selectHasProject(store.getState())).toBe(true);
  });

  it('the current open still commits its document as before', async () => {
    const doc = createProjectDocument({ title: 'Актуальный', tonic: C, mode: 'ionian' });
    setDependenciesForTesting(stubDeps(async () => ({ kind: 'ok', document: doc })));

    const store = makeStore();
    const result = await openProjectByIdCmd('doc')(store.dispatch);
    expect(result.kind).toBe('ok');
    expect(store.getState().projectHistory.present?.title).toBe('Актуальный');
    expect(selectHasProject(store.getState())).toBe(true);
  });
});
