/**
 * SEL-1 follow-up: the §3.7 merge pass keeps the EARLIER of two identical
 * adjacent chords, so editing the LATER one can remove its id from the
 * document — a successful setChordSpec/setChordPatternOverride must not leave
 * a dangling selection referencing the absorbed id.
 */
import { describe, expect, it } from 'vitest';

import { makeStore } from '@app/store';
import { createProjectDocument, type ProjectDocumentV1 } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID } from '@domain/timeline/constants';
import {
  selectChordCmd,
  setChordPatternOverrideCmd,
  setChordSpecCmd,
} from '@state/commands';

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

describe('selection cleanup after merge-inducing chord edits (SEL-1)', () => {
  it('setChordSpecCmd clears the selection when the edited chord merges into the earlier neighbor', () => {
    // a=Cmaj, b=Dmaj — distinct, so no merge yet. Editing b to Cmaj makes it
    // identical AND contiguous with a: the §3.7 pass keeps 'a' and removes
    // 'b'. The edit DID change b, so the command's no-op early-return does not
    // fire — but the selected id is gone afterwards.
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'maj' } },
      ]),
    );
    selectChordCmd('b')(store.dispatch);

    expect(setChordSpecCmd({ id: 'b', chord: { root: C, templateId: 'maj' } })(store.dispatch, store.getState)).toBe(true);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords.map((event) => event.id)).toEqual(['a']);
    expect(chords[0]!.durationTicks).toBe(2 * CHORD_GRID);
    expect(store.getState().session.selection).toBeNull();
  });

  it('setChordSpecCmd keeps the selection when no merge removes the edited chord', () => {
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: D, templateId: 'maj' } },
      ]),
    );
    selectChordCmd('b')(store.dispatch);

    expect(setChordSpecCmd({ id: 'b', chord: { root: D, templateId: 'min' } })(store.dispatch, store.getState)).toBe(true);

    expect(store.getState().projectHistory.present!.harmony.chords.map((event) => event.id)).toEqual(['a', 'b']);
    expect(store.getState().session.selection).toEqual({ kind: 'chord', id: 'b' });
  });

  it('setChordPatternOverrideCmd clears the selection when clearing the override merges the pair', () => {
    // a/b share the same spec but b carries an override, so they stay
    // separate events. Clearing b's override makes them identical → the merge
    // pass keeps 'a' and absorbs 'b'.
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
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord, patternOverride: pattern },
      ]),
    );
    selectChordCmd('b')(store.dispatch);

    expect(setChordPatternOverrideCmd({ id: 'b', pattern: null })(store.dispatch, store.getState)).toBe(true);

    const chords = store.getState().projectHistory.present!.harmony.chords;
    expect(chords.map((event) => event.id)).toEqual(['a']);
    expect(chords[0]!.patternOverride).toBeUndefined();
    expect(store.getState().session.selection).toBeNull();
  });
  it('setChordPatternOverrideCmd keeps the selection when the edited chord survives', () => {
    const chord = { root: C, templateId: 'maj' } as const;
    const makePattern = (kind: 'up' | 'down') => ({
      kind,
      subdivisionTicks: 240 as const,
      gate: 0.8,
      octaveSpan: 1 as const,
      velocity: 80,
    });
    const store = seededStore(
      docWithChords([
        { id: 'a', startTick: 0, durationTicks: CHORD_GRID, chord, patternOverride: makePattern('up') },
        { id: 'b', startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord },
      ]),
    );
    selectChordCmd('b')(store.dispatch);

    expect(setChordPatternOverrideCmd({ id: 'b', pattern: makePattern('down') })(store.dispatch, store.getState)).toBe(true);

    // Distinct overrides keep the events separate — no merge, selection intact.
    expect(store.getState().projectHistory.present!.harmony.chords.map((event) => event.id)).toEqual(['a', 'b']);
    expect(store.getState().session.selection).toEqual({ kind: 'chord', id: 'b' });
  });

});
