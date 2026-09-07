/**
 * BUG-1 NaN BPM rejection (§3.5) and BUG-2 §3.7-step-8 gate tolerance for
 * 'out_of_bounds' (§3.18 step 5 preserves beyond-length events on load).
 */

import { describe, expect, it } from 'vitest';

import { makeStore, type RootState } from '@app/store';
import { applyProjectEdit } from '@domain/editing/projectEditor';
import {
  createProjectDocument,
  projectLengthTicks,
  type ProjectDocumentV1,
} from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { NOTE_GRID } from '@domain/timeline/constants';
import { addNoteCmd, changeBpmCmd, moveNoteCmd, openProjectCmd } from '@state/commands';
import { selectPresentProject, selectToasts } from '@state/selectors';

const C = parseSpelled('C')!;

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

describe('BUG-1: non-finite BPM is rejected (§3.5)', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'changeBpmCmd(%p) fails with an error toast and leaves the doc untouched',
    (bpm) => {
      const store = openedStore();
      const before = store.getState().projectHistory.present;

      expect(changeBpmCmd(bpm)(store.dispatch, store.getState)).toBe(false);

      const after = store.getState().projectHistory.present;
      expect(after?.timing.bpm).toBe(before?.timing.bpm);
      expect(after).toBe(before); // no history entry, original reference
      expect(store.getState().projectHistory.past).toHaveLength(0);
      expect(lastToast(store)?.kind).toBe('error');
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'applyProjectEdit rejects %p bpm without crashing',
    (bpm) => {
      const doc = freshDoc();
      expect(applyProjectEdit(doc, { kind: 'setBpm', bpm })).toEqual({
        kind: 'rejected',
        reason: { kind: 'bpm_out_of_range' },
      });
    },
  );

  it('fractional BPM within 40..240 is still accepted end-to-end', () => {
    const store = openedStore();

    expect(changeBpmCmd(120.5)(store.dispatch, store.getState)).toBe(true);

    expect(selectPresentProject(store.getState())?.timing.bpm).toBe(120.5);
    expect(selectToasts(store.getState())).toHaveLength(0);
  });
});

/** Doc with a grid-legal event at/beyond lengthTicks, as §3.18 step 5 loads it. */
function beyondLengthDoc(): ProjectDocumentV1 {
  const doc = freshDoc();
  const lengthTicks = projectLengthTicks(doc);
  return {
    ...doc,
    melody: {
      ...doc.melody,
      notes: [
        { id: 'n1', startTick: 0, durationTicks: NOTE_GRID * 2, midi: 60, velocity: 100 },
        // At the project length: preserved byte-faithfully by load
        // normalization (ordering-only), per §3.18 step 5.
        { id: 'n3', startTick: lengthTicks, durationTicks: NOTE_GRID, midi: 67, velocity: 100 },
      ],
    },
  };
}

describe('BUG-2: gate tolerates out_of_bounds, still rejects other violations', () => {
  it('mutations are accepted on a doc containing a beyond-length event', () => {
    const store = openedStore(beyondLengthDoc());

    // addNote
    expect(
      addNoteCmd({ startTick: NOTE_GRID * 8, durationTicks: NOTE_GRID, midi: 64, velocity: 90 })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);
    let notes = selectPresentProject(store.getState())!.melody.notes;
    expect(notes.map((n) => n.id)).toEqual(['n1', expect.any(String), 'n3']);

    // moveNote
    expect(
      moveNoteCmd({ id: 'n1', newStartTick: NOTE_GRID * 4, newMidi: 62 })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(true);
    notes = selectPresentProject(store.getState())!.melody.notes;
    expect(notes.find((n) => n.id === 'n1')?.startTick).toBe(NOTE_GRID * 4);

    // setBpm
    expect(changeBpmCmd(96)(store.dispatch, store.getState)).toBe(true);
    expect(selectPresentProject(store.getState())?.timing.bpm).toBe(96);
  });

  it('a grid-violating result on the same kind of doc is still rejected', () => {
    const doc = freshDoc();
    const poisoned: ProjectDocumentV1 = {
      ...doc,
      melody: {
        ...doc.melody,
        notes: [
          { id: 'g1', startTick: 0, durationTicks: NOTE_GRID * 2, midi: 60, velocity: 100 },
          // Off-grid start: §3.4 grid_melody violation, NOT out_of_bounds.
          { id: 'bad', startTick: 505, durationTicks: NOTE_GRID, midi: 62, velocity: 100 },
          { id: 'far', startTick: projectLengthTicks(doc), durationTicks: NOTE_GRID, midi: 67, velocity: 100 },
        ],
      },
    };
    const store = openedStore(poisoned);
    const before = store.getState().projectHistory.present;

    // Any mutation must be rejected: the next document still carries the
    // grid_melody violation.
    expect(
      addNoteCmd({ startTick: NOTE_GRID * 8, durationTicks: NOTE_GRID, midi: 64, velocity: 90 })(
        store.dispatch,
        store.getState,
      ),
    ).toBe(false);
    expect(changeBpmCmd(96)(store.dispatch, store.getState)).toBe(false);

    const after = store.getState().projectHistory.present;
    expect(after).toBe(before); // both actions rejected, doc untouched
    expect(after?.melody.notes.map((n) => n.id)).toEqual(['g1', 'bad', 'far']);
    expect(after?.timing.bpm).not.toBe(96);
    expect(store.getState().projectHistory.past).toHaveLength(0);
  });
});
