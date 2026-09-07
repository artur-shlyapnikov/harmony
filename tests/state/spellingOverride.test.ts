/**
 * spellingOverride pins a letter+accidental to one sounding pitch class
 * (§3.5). After a move to a DIFFERENT pitch class the override is stale —
 * the inspector would keep showing the old spelled name over the new midi —
 * so both pitch-moving edits must strip it. Same-pc moves (octave shifts)
 * keep the override.
 *
 * Since the ProjectEditor owns edit semantics, this suite exercises
 * applyProjectEdit directly.
 */

import { describe, expect, it } from 'vitest';

import {
  applyProjectEdit,
  type EditResult,
} from '@domain/editing/projectEditor';
import {
  createProjectDocument,
  type ProjectDocumentV1,
} from '@domain/model/project';
import { parseSpelled, type SpelledPitchClass } from '@domain/model/pitch';
import { NOTE_GRID } from '@domain/timeline/constants';

const F_SHARP: SpelledPitchClass = parseSpelled('F#')!;

function freshDoc(): ProjectDocumentV1 {
  return createProjectDocument({ title: 'Test', tonic: parseSpelled('C')!, mode: 'ionian' });
}

function apply(doc: ProjectDocumentV1, edit: Parameters<typeof applyProjectEdit>[1]): ProjectDocumentV1 {
  const result: EditResult = applyProjectEdit(doc, edit);
  if (result.kind !== 'applied') throw new Error(`edit ${edit.kind} did not apply`);
  return result.project;
}

/** A note on F#4 (midi 66) carrying an F# spelling override. */
function noteWithOverride(): { doc: ProjectDocumentV1; id: string } {
  let doc = freshDoc();
  doc = apply(doc, {
    kind: 'addNote',
    id: 'added',
    startTick: 0,
    durationTicks: NOTE_GRID,
    midi: 66,
    velocity: 100,
  });
  doc = apply(doc, { kind: 'setNoteSpellingOverride', id: 'added', override: F_SHARP });
  return { doc, id: 'added' };
}

function noteById(doc: ProjectDocumentV1, id: string) {
  const note = doc.melody.notes.find((n) => n.id === id);
  expect(note).toBeDefined();
  return note!;
}

describe('stale spellingOverride after pitch moves', () => {
  it('moveNoteSemitones strips the override when the pitch class changes', () => {
    const { doc, id } = noteWithOverride();
    const moved = apply(doc, { kind: 'moveNoteSemitones', id, delta: 1 });
    expect(noteById(moved, id).midi).toBe(67);
    expect(noteById(moved, id).spellingOverride).toBeUndefined();
  });

  it('moveNoteSemitones keeps the override across an octave shift', () => {
    const { doc, id } = noteWithOverride();
    const moved = apply(doc, { kind: 'moveNoteSemitones', id, delta: 12 });
    expect(noteById(moved, id).midi).toBe(78);
    expect(noteById(moved, id).spellingOverride).toEqual(F_SHARP);
  });

  it('moveNote strips the override when the pitch class changes', () => {
    const { doc, id } = noteWithOverride();
    const moved = apply(doc, { kind: 'moveNote', id, newStartTick: NOTE_GRID, newMidi: 68 }); // F#4 -> G#4
    expect(noteById(moved, id).midi).toBe(68);
    expect(noteById(moved, id).startTick).toBe(NOTE_GRID);
    expect(noteById(moved, id).spellingOverride).toBeUndefined();
  });

  it('moveNote keeps the override for a same-pc octave move', () => {
    const { doc, id } = noteWithOverride();
    const moved = apply(doc, { kind: 'moveNote', id, newStartTick: NOTE_GRID, newMidi: 78 }); // F#4 -> F#5
    expect(noteById(moved, id).midi).toBe(78);
    expect(noteById(moved, id).spellingOverride).toEqual(F_SHARP);
  });

  it('notes without an override are unaffected by moves', () => {
    let doc = freshDoc();
    doc = apply(doc, {
      kind: 'addNote',
      id: 'plain',
      startTick: 0,
      durationTicks: NOTE_GRID,
      midi: 60,
      velocity: 100,
    });

    const semitone = apply(doc, { kind: 'moveNoteSemitones', id: 'plain', delta: 7 });
    expect(noteById(semitone, 'plain').midi).toBe(67);
    expect(noteById(semitone, 'plain').spellingOverride).toBeUndefined();
  });
});
