/**
 * Span-cache identity contract (§3.10): selectNoteAnalysisMap reuses span
 * ARRAYS by reference for notes whose harmonic context did not change.
 * NoteBlock's memo compares the spans prop, so this identity is what makes a
 * single chord edit re-render only the blocks it can actually recolor
 * instead of the whole lane.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { makeStore } from '@app/store';
import type { ChordSpec } from '@domain/model/chord';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { TICKS_PER_BAR } from '@domain/timeline/constants';
import {
  addChordRangeCmd,
  addNoteCmd,
  openProjectCmd,
  setChordSpecCmd,
} from '@state/commands';
import { selectNoteAnalysisMap } from '@state/selectors';

const C = parseSpelled('C')!;

function seededStore() {
  const store = makeStore();
  store.dispatch(
    openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })),
  );
  // Four distinct bars (identical neighbors would merge) and eight notes per
  // bar, one per pitch row so nothing collides on a row.
  const specs: ChordSpec[] = [
    { root: parseSpelled('C')!, templateId: 'maj' },
    { root: parseSpelled('D')!, templateId: 'min' },
    { root: parseSpelled('E')!, templateId: 'min' },
    { root: parseSpelled('F')!, templateId: 'maj' },
  ];
  for (let bar = 0; bar < 4; bar += 1) {
    store.dispatch(
      addChordRangeCmd({
        startTick: bar * TICKS_PER_BAR,
        durationTicks: TICKS_PER_BAR,
        chord: specs[bar]!,
      }),
    );
  }
  for (let i = 0; i < 32; i += 1) {
    const bar = i % 4;
    const slot = Math.floor(i / 4) % 8;
    store.dispatch(
      addNoteCmd({
        startTick: bar * TICKS_PER_BAR + slot * 480,
        durationTicks: 480,
        midi: 60 + slot,
        velocity: 90,
      }),
    );
  }
  return store;
}

describe('selectNoteAnalysisMap span identity', () => {
  it('reanalyzes only notes overlapping an edited chord; others keep span identity', () => {
    const store = seededStore();
    const before = selectNoteAnalysisMap(store.getState());
    expect(before.size).toBe(32);

    const target = store.getState().projectHistory.present!.harmony.chords[1]!;
    store.dispatch(
      setChordSpecCmd({ id: target.id, chord: { root: target.chord.root, templateId: 'maj' } }),
    );

    const after = selectNoteAnalysisMap(store.getState());
    let changedOutsideBar1 = 0;
    let changedInBar1 = 0;
    for (const [id, spans] of before) {
      if (after.get(id) !== spans) {
        const note = store
          .getState()
          .projectHistory.present!.melody.notes.find((n) => n.id === id)!;
        if (Math.floor(note.startTick / TICKS_PER_BAR) === 1) changedInBar1 += 1;
        else changedOutsideBar1 += 1;
      }
    }
    // Only the edited chord's bar reanalyzes; every other note keeps the
    // exact array instance (NoteBlock memo stays effective).
    expect(changedInBar1).toBe(8);
    expect(changedOutsideBar1).toBe(0);
  });

  it('keeps all span identities across a note-only commit', () => {
    const store = seededStore();
    const before = selectNoteAnalysisMap(store.getState());
    store.dispatch(
      // Bar 4 sits beyond the chord content: nothing is replaced, so every
      // existing note keeps its object reference (monophonic replaceRange
      // would otherwise swap a same-slot note and legitimately reanalyze it).
      addNoteCmd({ startTick: 4 * TICKS_PER_BAR, durationTicks: 480, midi: 84, velocity: 90 }),
    );
    const after = selectNoteAnalysisMap(store.getState());
    let changed = 0;
    for (const [id, spans] of before) {
      if (after.get(id) !== spans) changed += 1;
    }
    expect(changed).toBe(0);
    // …and the new note is analyzed.
    expect(after.size).toBe(33);
  });
});
