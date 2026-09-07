/**
 * Harmony-lane merge rules around deleteChord (§3.7): every accepted harmony
 * mutation runs the merge pass, so identical adjacent chords merge and gaps
 * between identical chords survive without a false merge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeStore } from '@app/store';
import { createProjectDocument, type ProjectDocumentV1 } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID } from '@domain/timeline/constants';
import { changeBpmCmd, deleteChordCmd, setChordPatternOverrideCmd } from '@state/commands';
import { selectToasts } from '@state/selectors';

const C = parseSpelled('C')!;
const D = parseSpelled('D')!;

function docWithChords(chords: ProjectDocumentV1['harmony']['chords']): ProjectDocumentV1 {
  const doc = createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian' });
  return { ...doc, harmony: { ...doc.harmony, chords } };
}

function seededStore(doc: ProjectDocumentV1) {
  const store = makeStore();
  store.dispatch({ type: 'document/replacedFromLoad', payload: { project: doc } });
  return store;
}

describe('harmony merge on delete (§3.7)', () => {
  it('deleteChord merges an unmerged identical adjacent pair via the §3.7 step 7 pass', () => {
    // Non-canonical loaded document: a/b are identical AND touching but not
    // merged. Any accepted harmony mutation must canonicalize them (§3.7:
    // "соседние одинаковые аккорды после изменения объединяются").
    const chord = { root: C, templateId: 'maj' } as const;
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord },
        { id: 'x', startTick: 2 * CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'maj' } },
      ]),
    );

    expect(deleteChordCmd({ id: 'x' })(store.dispatch, store.getState)).toBe(true);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords).toHaveLength(1);
    // Earlier id kept; the merged event spans both ranges with the same pattern.
    expect(chords[0]!.id).toBe('a');
    expect(chords[0]!.startTick).toBe(0);
    expect(chords[0]!.durationTicks).toBe(2 * CHORD_GRID);
    expect(chords[0]!.chord).toEqual(chord);
  });

  it('deleteChord never bridges the deleted range between identical chords', () => {
    const chord = { root: C, templateId: 'maj' } as const;
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord },
        { id: 'c', startTick: 2 * CHORD_GRID, durationTicks: CHORD_GRID, chord },
      ]),
    );

    expect(deleteChordCmd({ id: 'b' })(store.dispatch, store.getState)).toBe(true);

    // Deleting the middle chord leaves a time gap — a/c stay separate events
    // rather than one event bridging the hole.
    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords).toHaveLength(2);
    expect(chords.map((event) => event.id)).toEqual(['a', 'c']);
    expect(chords[0]!.durationTicks).toBe(CHORD_GRID);
    expect(chords[1]!.durationTicks).toBe(CHORD_GRID);
  });

  it('deleteChord never merges across a gap', () => {
    const chord = { root: C, templateId: 'maj' } as const;
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord },
        { id: 'x', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'maj' } },
        { id: 'c', startTick: 2 * CHORD_GRID, durationTicks: CHORD_GRID, chord },
      ]),
    );

    expect(deleteChordCmd({ id: 'x' })(store.dispatch, store.getState)).toBe(true);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords).toHaveLength(2);
    expect(chords.map((event) => event.id)).toEqual(['a', 'c']);
    expect(chords[0]!.durationTicks).toBe(CHORD_GRID);
    expect(chords[1]!.durationTicks).toBe(CHORD_GRID);
  });

  it('clearing a patternOverride merges the now-identical adjacent pair (§3.7)', () => {
    // a carries an override so it differs from identical neighbor b; removing
    // it must run the merge pass — same as any other harmony mutation.
    const chord = { root: C, templateId: 'maj' } as const;
    const pattern = {
      kind: 'up' as const,
      subdivisionTicks: 240 as const,
      gate: 0.8,
      octaveSpan: 1 as const,
      velocity: 80,
    };
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord, patternOverride: pattern },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord },
        { id: 'x', startTick: 2 * CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'maj' } },
      ]),
    );

    setChordPatternOverrideCmd({ id: 'a', pattern: null })(store.dispatch, store.getState);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords).toHaveLength(2);
    expect(chords[0]!.id).toBe('a');
    expect(chords[0]!.startTick).toBe(0);
    expect(chords[0]!.durationTicks).toBe(2 * CHORD_GRID);
    expect(chords[0]!.patternOverride).toBeUndefined();
    expect(chords[0]!.chord).toEqual(chord);
  });

});


describe('§3.7 step 8 invariant enforcement (via the ProjectEditor)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function storeWithOverlappingChords() {
    const chord = { root: C, templateId: 'maj' } as const;
    return seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: 2 * CHORD_GRID, chord },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord },
      ]),
    );
  }

  it('rejects a mutation whose result violates a NON load-tolerated invariant', () => {
    // A schema-valid load can carry only 'overlap'/'out_of_bounds'; any other
    // violation arrives through a bug and must stay rejected (no history
    // entry, error toast). Poison the lane with an off-grid chord start.
    const chord = { root: C, templateId: 'maj' } as const;
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: 2 * CHORD_GRID, chord },
        { id: 'bad', startTick: 1, durationTicks: CHORD_GRID, chord }, // off-grid
      ]),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = store.getState().projectHistory.present;

    expect(changeBpmCmd(100)(store.dispatch, store.getState)).toBe(false);

    // §3.4/§3.7 step 8: the violated document is discarded — the original
    // reference stays present and nothing is pushed onto the undo stack.
    expect(store.getState().projectHistory.present).toBe(before);
    expect(store.getState().projectHistory.past).toHaveLength(0);
    // DEV-only diagnostics name the gate and the fired invariant.
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('projectEditor');
    expect(JSON.stringify(error.mock.calls[0]![1])).toContain('grid_chord');
    // The rejection surfaces as user-facing copy through the command shell.
    const toasts = selectToasts(store.getState());
    expect(toasts.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('accepts mutations on a document whose lanes overlap from a legal load (BUG-1)', () => {
    const store = storeWithOverlappingChords();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(changeBpmCmd(100)(store.dispatch, store.getState)).toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(store.getState().projectHistory.present?.timing.bpm).toBe(100);
    // The tolerated overlap survives the mutation untouched.
    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('accepts mutations on a canonical document', () => {
    const store = seededStore(docWithChords([]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(changeBpmCmd(100)(store.dispatch, store.getState)).toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(store.getState().projectHistory.present?.timing.bpm).toBe(100);
  });
});
