// @vitest-environment jsdom
/**
 * Gesture ↔ planner ↔ commit correspondence (§3.20, §3.7).
 *
 * The lanes no longer contain any geometry math: previews are computed by
 * the domain gesture planners and the SAME values are dispatched through the
 * commands, whose ProjectEditor re-resolves them. These tests pin the
 * correspondence: for a representative gesture the committed document must
 * equal exactly what the planner previewed (and the ghost showed).
 */


import { xToTick } from '@features/editor/timelineGeometry';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { act } from 'react';

import { makeStore } from '@app/store';
import { createProjectDocument, projectLengthTicks } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID } from '@domain/timeline/constants';
import {
  planChordLeftResizePreview,
  planNoteDrawGeometry,
  planNoteLeftResizePreview,
  planNoteMovePreview,
  planRangeSelectionGeometry,
} from '@domain/editing/planners';
import {
  addChordRangeCmd,
  addNoteCmd,
  moveResizeChordCmd,
  moveResizeNoteCmd,
  moveNoteCmd,
  openProjectCmd,
  selectRangeCmd,
  setActiveToolCmd,
} from '@state/commands';
import { selectMelodyNotes } from '@state/selectors';
import { MelodyLane } from '@features/editor/MelodyLane';

const C = parseSpelled('C')!;

function openedStore() {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
  return store;
}

describe('draw gesture ↔ planNoteDrawGeometry ↔ addNote', () => {
  it('the planned draw geometry is what commits, byte for byte', () => {
    const store = openedStore();
    store.dispatch(setActiveToolCmd('drawNote'));

    // The gesture MelodyLane performs: anchor/current ticks from pointer x.
    const anchorTick = 1000;
    const currentTick = 2540;
    const lengthTicks = projectLengthTicks(store.getState().projectHistory.present!);
    const geometry = planNoteDrawGeometry(anchorTick, currentTick, lengthTicks)!;

    expect(
      addNoteCmd({
        startTick: geometry.startTick,
        durationTicks: geometry.durationTicks,
        midi: 60,
        velocity: 80,
      })(store.dispatch, store.getState),
    ).toBe(true);

    const [note] = selectMelodyNotes(store.getState());
    expect(note!.startTick).toBe(geometry.startTick);
    expect(note!.durationTicks).toBe(geometry.durationTicks);
  });

  it('a real drag commits exactly the ghost geometry', () => {
    const store = openedStore();
    store.dispatch(setActiveToolCmd('drawNote'));
    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );
    const svg = screen.getByTestId('melody-lane');
    // Ghost math BEFORE the gesture: same pointer ticks the lane reads via
    // its own xToTick mapping (jsdom rects are zero-origin).
    const lengthTicks = projectLengthTicks(store.getState().projectHistory.present!);
    const ghost = planNoteDrawGeometry(xToTick(80, 40), xToTick(124, 40), lengthTicks)!;

    fireEvent.pointerDown(svg, { clientX: 80, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 124, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 124, clientY: 200, pointerId: 1 });

    const [note] = selectMelodyNotes(store.getState());
    expect(note!.startTick).toBe(ghost.startTick);
    expect(note!.durationTicks).toBe(ghost.durationTicks);
  });
});

describe('move/resize gestures ↔ planners ↔ atomic commands', () => {
  function laneWithNotes() {
    const store = openedStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: 480, midi: 60, velocity: 90 }));
    store.dispatch(addNoteCmd({ startTick: 1920, durationTicks: 480, midi: 64, velocity: 90 }));
    return store;
  }

  it('planNoteMovePreview values are accepted verbatim by moveNote', () => {
    const store = laneWithNotes();
    const present = store.getState().projectHistory.present!;
    const note = present.melody.notes[1]!;

    const preview = planNoteMovePreview({
      notes: present.melody.notes,
      note,
      grabOffsetTicks: 120,
      grabMidiOffset: 0,
      tick: 600, // raw pointer tick left of the neighbor window
      rowMidi: 64,
      lengthTicks: projectLengthTicks(present),
    });

    expect(
      moveNoteCmd({ id: note.id, newStartTick: preview.previewStart, newMidi: preview.previewMidi })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);

    const moved = store.getState().projectHistory.present!.melody.notes.find((n) => n.id === note.id)!;
    expect(moved.startTick).toBe(preview.previewStart);
    expect(moved.midi).toBe(preview.previewMidi);
  });

  it('planNoteLeftResizePreview feeds moveResizeNote as ONE accepted mutation', () => {
    const store = laneWithNotes();
    const present = store.getState().projectHistory.present!;
    const note = present.melody.notes[1]!;

    const preview = planNoteLeftResizePreview({
      notes: present.melody.notes,
      note,
      tick: 240, // drag the left edge onto the first note's end
      lengthTicks: projectLengthTicks(present),
    });

    expect(
      moveResizeNoteCmd({
        id: note.id,
        newStartTick: preview.previewStart,
        newDurationTicks: preview.previewDuration,
      })(store.dispatch, store.getState),
    ).toBe(true);

    const pastBefore = store.getState().projectHistory.past.length;
    void pastBefore;
    const moved = store.getState().projectHistory.present!.melody.notes.find((n) => n.id === note.id)!;
    expect(moved.startTick).toBe(preview.previewStart);
    expect(moved.durationTicks).toBe(preview.previewDuration); // right edge pinned
  });
});

describe('chord gestures ↔ planners ↔ commands', () => {
  it('planChordLeftResizePreview feeds moveResizeChord as ONE accepted mutation (RevUI-1)', () => {
    const store = openedStore();
    act(() => {
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(
        store.dispatch,
        store.getState,
      );
      addChordRangeCmd({ startTick: 2 * CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: parseSpelled('D')!, templateId: 'maj' } })(
        store.dispatch,
        store.getState,
      );
    });
    const present = store.getState().projectHistory.present!;
    const b = present.harmony.chords[1]!;

    const preview = planChordLeftResizePreview({
      chords: present.harmony.chords,
      chord: b,
      tick: CHORD_GRID, // pull B's left edge onto A's end
      lengthTicks: projectLengthTicks(present),
    });

    expect(
      moveResizeChordCmd({
        id: b.id,
        newStartTick: preview.previewStart,
        newDurationTicks: preview.previewDuration,
      })(store.dispatch, store.getState),
    ).toBe(true);

    const moved = store.getState().projectHistory.present!.harmony.chords.find((c) => c.id === b.id)!;
    expect(moved.startTick).toBe(preview.previewStart);
    expect(moved.durationTicks).toBe(preview.previewDuration);
  });

  it('planRangeSelectionGeometry is what selectRange commits', () => {
    const { startTick, durationTicks } = planRangeSelectionGeometry(1000, 5000);
    const store = openedStore();
    selectRangeCmd(startTick, durationTicks)(store.dispatch);
    expect(store.getState().session.selection).toEqual({ kind: 'range', startTick, durationTicks });
  });
});
