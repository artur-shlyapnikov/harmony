/**
 * ProjectEditor semantics matrix (§3.7, §3.8, §3.14, §3.20, §3.21).
 *
 * The accepted / rejected / no-op rules and the EXACT resulting documents
 * live here since the ProjectEditor is their single owner. Store-level
 * suites keep history/toast/reconciliation coverage only.
 */

import { describe, expect, it } from 'vitest';

import {
  applyProjectEdit,
  type EditResult,
  type ProjectEdit,
} from '@domain/editing/projectEditor';
import { createProjectDocument, projectLengthTicks, type ProjectDocumentV1 } from '@domain/model/project';
import { parseSpelled, MIDI_MAX, MIDI_MIN, type SpelledPitchClass } from '@domain/model/pitch';
import { CHORD_GRID, MAX_CHORD_EVENTS, MAX_MELODY_NOTES, NOTE_GRID, TICKS_PER_BAR } from '@domain/timeline/constants';

const C = parseSpelled('C')!;
const D = parseSpelled('D')!;
const E = parseSpelled('E')!;
const G = parseSpelled('G')!;
const F_SHARP = parseSpelled('F#')!;

function freshDoc(): ProjectDocumentV1 {
  return createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian' });
}

function docWith(
  patch: Partial<Pick<ProjectDocumentV1, 'melody' | 'harmony' | 'timing'>>,
): ProjectDocumentV1 {
  return { ...freshDoc(), ...patch };
}

type NoteFixture = ReturnType<typeof makeNote>;
function makeNote(
  id: string,
  startTick: number,
  durationTicks: number,
  midi: number,
  velocity: number,
) {
  return { id, startTick, durationTicks, midi, velocity };
}
const note = (
  id: string,
  startTick: number,
  durationTicks = NOTE_GRID,
  midi = 60,
  velocity = 90,
): NoteFixture => makeNote(id, startTick, durationTicks, midi, velocity);

const chord = (
  id: string,
  startTick: number,
  durationTicks: number,
  root: SpelledPitchClass = C,
  templateId: 'maj' | 'min' = 'maj',
) => ({ id, startTick, durationTicks, chord: { root, templateId } });

function run(doc: ProjectDocumentV1, edit: ProjectEdit): EditResult {
  return applyProjectEdit(doc, edit);
}

// ---------------------------------------------------------------------------
// Melody lane
// ---------------------------------------------------------------------------

describe('addNote', () => {
  it('inserts the payload id and replaces the intersected range in one mutation', () => {
    const doc = docWith({ melody: { notes: [note('a', 0, NOTE_GRID)] } });
    const result = run(doc, {
      kind: 'addNote',
      id: 'new',
      startTick: 0,
      durationTicks: 2 * NOTE_GRID,
      midi: 62,
      velocity: 100,
    });

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    // Full replacement: the old event is gone even though it overlapped only
    // partially — the new event covers [0..2*NOTE_GRID) entirely.
    expect(result.project.melody.notes).toEqual([
      { id: 'new', startTick: 0, durationTicks: 2 * NOTE_GRID, midi: 62, velocity: 100 },
    ]);
    expect(result.project.updatedAt).toBe(doc.updatedAt); // timestamping is the reducer's job
  });

  it('splits a straddling note into re-id fragments around the added range', () => {
    const doc = docWith({ melody: { notes: [note('a', 960, 2880)] } });
    const result = run(doc, {
      kind: 'addNote',
      id: 'new',
      startTick: 1920,
      durationTicks: NOTE_GRID,
      midi: 64,
      velocity: 90,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;

    const sorted = result.project.melody.notes;
    expect(sorted).toHaveLength(3);
    expect(sorted.map((n) => n.id)).not.toContain('a'); // original replaced
    expect(new Set(sorted.map((n) => n.id)).size).toBe(3); // fresh fragment ids
    expect([sorted[0]!.startTick, sorted[0]!.durationTicks]).toEqual([960, 960]);
    expect([sorted[1]!.startTick, sorted[1]!.durationTicks]).toEqual([1920, NOTE_GRID]);
    expect([sorted[2]!.startTick, sorted[2]!.durationTicks]).toEqual([2160, 1680]);
  });

  it('quantizes off-grid input and caps the duration at project length', () => {
    const doc = freshDoc();
    const length = projectLengthTicks(doc);
    const result = run(doc, {
      kind: 'addNote',
      id: 'n',
      startTick: 500,
      durationTicks: length * 2,
      midi: 63.6,
      velocity: 90,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    const added = result.project.melody.notes[0]!;
    expect(added.startTick).toBe(0); // clamped back because the request overruns the project
    expect(added.midi).toBe(64); // rounded
    expect(added.durationTicks).toBe(projectLengthTicks(doc)); // ends within project
  });

  it('rejects a projected lane beyond MAX_MELODY_NOTES (§3.21)', () => {
    const doc = docWith({
      timing: { ppq: 960, bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, bars: 128 },
      melody: {
        notes: Array.from({ length: MAX_MELODY_NOTES }, (_, i) =>
          note(`n${i}`, TICKS_PER_BAR + i * NOTE_GRID),
        ),
      },
    });
    const result = run(doc, {
      kind: 'addNote',
      id: 'new',
      startTick: 0,
      durationTicks: NOTE_GRID,
      midi: 60,
      velocity: 90,
    });
    expect(result).toEqual({ kind: 'rejected', reason: { kind: 'melody_limit' } });
  });

  it('rejects non-finite ingress that clamping cannot rescue', () => {
    const doc = freshDoc();
    expect(
      run(doc, { kind: 'addNote', id: 'n', startTick: 0, durationTicks: NOTE_GRID, midi: Number.NaN, velocity: 90 }),
    ).toEqual({ kind: 'rejected', reason: { kind: 'invalid_event' } });
    expect(
      run(doc, { kind: 'addNote', id: 'n', startTick: Number.NaN, durationTicks: NOTE_GRID, midi: 60, velocity: 90 }),
    ).toEqual({ kind: 'rejected', reason: { kind: 'invalid_event' } });
  });

  it('rejects negative and zero durations instead of quantizing them onto the grid', () => {
    const doc = freshDoc();
    expect(
      run(doc, { kind: 'addNote', id: 'n', startTick: 0, durationTicks: -NOTE_GRID, midi: 60, velocity: 90 }),
    ).toEqual({ kind: 'rejected', reason: { kind: 'invalid_event' } });
    expect(
      run(doc, { kind: 'addNote', id: 'n', startTick: 0, durationTicks: 0, midi: 60, velocity: 90 }),
    ).toEqual({ kind: 'rejected', reason: { kind: 'invalid_event' } });
  });
});

describe('moveNote', () => {
  function twoNotes() {
    return docWith({ melody: { notes: [note('a', 0, 480), note('b', 960, 480, 64)] } });
  }

  it('clamps against the previous neighbor without truncating it', () => {
    const doc = twoNotes();
    const result = run(doc, { kind: 'moveNote', id: 'b', newStartTick: 0, newMidi: 64 });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.melody.notes).toEqual([
      note('a', 0, 480),
      note('b', 480, 480, 64), // clamped flush to prevEnd
    ]);
  });

  it('keeps position when the neighbor window is too narrow, still moving pitch', () => {
    const doc = docWith({
      melody: { notes: [note('a', 0, 480), note('b', 480, 960, 64), note('c', 1440, 480, 67)] },
    });
    // b's window is exactly its own length: a horizontal move has no room,
    // but the pitch change must still land.
    const result = run(doc, { kind: 'moveNote', id: 'b', newStartTick: 240, newMidi: 65 });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.melody.notes[1]).toEqual(note('b', 480, 960, 65));
  });

  it('drops a stale spelling override on a pitch-class change, keeps it across octaves', () => {
    const base = docWith({
      melody: { notes: [{ ...note('a', 0, NOTE_GRID, 66), spellingOverride: F_SHARP }] },
    });

    const changed = run(base, { kind: 'moveNote', id: 'a', newStartTick: NOTE_GRID, newMidi: 68 });
    expect(changed.kind).toBe('applied');
    if (changed.kind === 'applied') {
      expect(changed.project.melody.notes[0]).toEqual({ ...note('a', NOTE_GRID, NOTE_GRID, 68) });
    }

    const kept = run(base, { kind: 'moveNote', id: 'a', newStartTick: NOTE_GRID, newMidi: 78 });
    expect(kept.kind).toBe('applied');
    if (kept.kind === 'applied') {
      expect(kept.project.melody.notes[0]).toEqual({
        ...note('a', NOTE_GRID, NOTE_GRID, 78),
        spellingOverride: F_SHARP,
      });
    }
  });

  it('reports unchanged for the same position+pitch and rejects unknown ids', () => {
    const doc = twoNotes();
    expect(run(doc, { kind: 'moveNote', id: 'b', newStartTick: 960, newMidi: 64 })).toEqual({
      kind: 'unchanged',
    });
    expect(run(doc, { kind: 'moveNote', id: 'x', newStartTick: 0, newMidi: 60 })).toEqual({
      kind: 'rejected',
      reason: { kind: 'not_found' },
    });
  });

  it('rejects non-finite midi', () => {
    const doc = twoNotes();
    expect(run(doc, { kind: 'moveNote', id: 'b', newStartTick: 960, newMidi: Number.NaN })).toEqual({
      kind: 'rejected',
      reason: { kind: 'invalid_event' },
    });
  });
});

describe('resizeNote', () => {
  it('caps growth at the next neighbor', () => {
    const doc = docWith({
      melody: { notes: [note('a', 0, NOTE_GRID), note('b', 960, NOTE_GRID, 64)] },
    });
    const result = run(doc, { kind: 'resizeNote', id: 'a', newDurationTicks: 3840 });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.melody.notes).toEqual([
      note('a', 0, 960),
      note('b', 960, NOTE_GRID, 64),
    ]);
  });

  it('leaves the note untouched when there is no room for one grid step', () => {
    // Overlapping seed: the neighbor starts INSIDE the note, so the growth
    // cap (nextStart - startTick) is below one grid step.
    const tight = docWith({
      melody: { notes: [note('a', 0, NOTE_GRID * 2), note('b', 100, NOTE_GRID, 64)] },
    });
    expect(run(tight, { kind: 'resizeNote', id: 'a', newDurationTicks: 720 })).toEqual({
      kind: 'unchanged',
    });
  });

  it('rejects unknown ids and reports unchanged for the same duration', () => {
    const doc = docWith({ melody: { notes: [note('a', 0, 480)] } });
    expect(run(doc, { kind: 'resizeNote', id: 'x', newDurationTicks: 480 })).toEqual({
      kind: 'rejected',
      reason: { kind: 'not_found' },
    });
    expect(run(doc, { kind: 'resizeNote', id: 'a', newDurationTicks: 480 })).toEqual({
      kind: 'unchanged',
    });
  });
});

describe('moveResizeNote', () => {
  it('resolves BOTH fields atomically inside the neighbor window', () => {
    const doc = docWith({
      melody: { notes: [note('a', 0, 480), note('b', 960, 480, 64), note('c', 1920, 480, 67)] },
    });
    const result = run(doc, {
      kind: 'moveResizeNote',
      id: 'b',
      newStartTick: 0,
      newDurationTicks: 3840,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.melody.notes[1]).toEqual(note('b', 480, 1440, 64)); // capped at c's start
    expect(result.project.melody.notes[2]).toEqual(note('c', 1920, 480, 67)); // untouched
  });

  it('reports unchanged when nothing would move', () => {
    const doc = docWith({ melody: { notes: [note('a', 480, 480)] } });
    expect(
      run(doc, { kind: 'moveResizeNote', id: 'a', newStartTick: 480, newDurationTicks: 480 }),
    ).toEqual({ kind: 'unchanged' });
  });
});

describe('deleteNote', () => {
  it('removes the note and reports unchanged for unknown ids', () => {
    const doc = docWith({ melody: { notes: [note('a', 0, 480), note('b', 960, 480, 64)] } });
    const result = run(doc, { kind: 'deleteNote', id: 'a' });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.melody.notes).toEqual([note('b', 960, 480, 64)]);
    }
    expect(run(doc, { kind: 'deleteNote', id: 'x' })).toEqual({ kind: 'unchanged' });
  });
});

describe('deleteEventsInRange', () => {
  function rangeDoc() {
    return docWith({
      melody: {
        notes: [
          note('keep-before', 0, NOTE_GRID),
          note('kill-inside', CHORD_GRID + NOTE_GRID, NOTE_GRID, 62),
          note('keep-at-end', 3 * CHORD_GRID, NOTE_GRID, 65),
        ],
      },
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('chord-before', 0, CHORD_GRID),
          { ...chord('chord-inside', CHORD_GRID, CHORD_GRID, C, 'min') },
          { ...chord('chord-after', 3 * CHORD_GRID, CHORD_GRID, C, '7' as never) },
        ],
      },
    });
  }

  it('removes every covered note AND chord as one mutation (half-open overlap)', () => {
    const result = run(rangeDoc(), {
      kind: 'deleteEventsInRange',
      startTick: CHORD_GRID,
      endTick: 3 * CHORD_GRID,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.melody.notes.map((n) => n.id)).toEqual(['keep-before', 'keep-at-end']);
    expect(result.project.harmony.chords.map((c) => c.id)).toEqual(['chord-before', 'chord-after']);
  });

  it('merges identical neighbors left contiguous by the deletion (§3.7 step 7)', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('left', 0, CHORD_GRID),
          chord('right', CHORD_GRID, CHORD_GRID),
          { ...chord('inside', 2 * CHORD_GRID, CHORD_GRID, C, 'min') },
        ],
      },
    });
    const result = run(doc, {
      kind: 'deleteEventsInRange',
      startTick: 2 * CHORD_GRID,
      endTick: 4 * CHORD_GRID,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.harmony.chords).toEqual([chord('left', 0, 2 * CHORD_GRID)]);
  });

  it('reports unchanged when the range covers nothing', () => {
    const doc = rangeDoc();
    expect(
      run(doc, { kind: 'deleteEventsInRange', startTick: 6 * CHORD_GRID, endTick: 8 * CHORD_GRID }),
    ).toEqual({ kind: 'unchanged' });
  });
});

describe('setNoteVelocity', () => {
  const doc = docWith({ melody: { notes: [note('a', 0, NOTE_GRID, 60, 90)] } });

  it('applies integer velocities in range and detects no-ops', () => {
    const result = run(doc, { kind: 'setNoteVelocity', id: 'a', velocity: 40 });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.melody.notes[0]).toEqual(note('a', 0, NOTE_GRID, 60, 40));
    }
    expect(run(doc, { kind: 'setNoteVelocity', id: 'a', velocity: 90 })).toEqual({
      kind: 'unchanged',
    });
  });

  it('rejects non-integer / out-of-range velocities before touching the lane', () => {
    for (const bad of [Number.NaN, 0, 128, 90.5]) {
      expect(run(doc, { kind: 'setNoteVelocity', id: 'a', velocity: bad })).toEqual({
        kind: 'rejected',
        reason: { kind: 'velocity_out_of_range' },
      });
    }
  });

  it('rejects unknown ids', () => {
    expect(run(doc, { kind: 'setNoteVelocity', id: 'x', velocity: 80 })).toEqual({
      kind: 'rejected',
      reason: { kind: 'not_found' },
    });
  });
});

describe('setNoteSpellingOverride', () => {
  it('sets, keeps value-equal input silent, and clears', () => {
    const doc = docWith({ melody: { notes: [note('a', 0, NOTE_GRID, 66)] } });

    const set = run(doc, { kind: 'setNoteSpellingOverride', id: 'a', override: F_SHARP });
    expect(set.kind).toBe('applied');
    const afterSet =
      set.kind === 'applied'
        ? set.project
        : undefined;
    expect(afterSet?.melody.notes[0]).toEqual({
      ...note('a', 0, NOTE_GRID, 66),
      spellingOverride: F_SHARP,
    });

    expect(
      run(afterSet!, { kind: 'setNoteSpellingOverride', id: 'a', override: parseSpelled('F#')! }),
    ).toEqual({ kind: 'unchanged' });

    const cleared = run(afterSet!, { kind: 'setNoteSpellingOverride', id: 'a', override: null });
    expect(cleared.kind).toBe('applied');
    if (cleared.kind === 'applied') {
      expect(cleared.project.melody.notes[0]).toEqual(note('a', 0, NOTE_GRID, 66));
    }
    // Clearing an absent override is also a no-op.
    expect(run(doc, { kind: 'setNoteSpellingOverride', id: 'a', override: null })).toEqual({
      kind: 'unchanged',
    });
  });

  it('rejects an override that contradicts the sounding pitch class', () => {
    const doc = docWith({ melody: { notes: [note('a', 0, NOTE_GRID, 60)] } }); // C-natural
    expect(run(doc, { kind: 'setNoteSpellingOverride', id: 'a', override: F_SHARP })).toEqual({
      kind: 'rejected',
      reason: { kind: 'invalid_spelling_override' },
    });
    // The lane is untouched — no partial application.
    expect(doc.melody.notes[0]).toEqual(note('a', 0, NOTE_GRID, 60));
  });

  it('still accepts an enharmonic RESPELLING of the sounding pitch class', () => {
    const db = parseSpelled('Db')!;
    const doc = docWith({ melody: { notes: [note('a', 0, NOTE_GRID, 61)] } }); // sounds C#/Db
    const result = run(doc, { kind: 'setNoteSpellingOverride', id: 'a', override: db });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.melody.notes[0]!.spellingOverride).toEqual(db);
    }
  });
});

describe('moveNoteSemitones', () => {
  it('shifts integral amounts, rounds fractional deltas, and preserves the lane order', () => {
    const doc = docWith({ melody: { notes: [note('a', 0, 480, 63)] } });
    const result = run(doc, { kind: 'moveNoteSemitones', id: 'a', delta: -2.4 });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.melody.notes).toEqual([note('a', 0, 480, 61)]);
    }
  });

  it('strips stale overrides on a pitch-class change', () => {
    const doc = docWith({
      melody: { notes: [{ ...note('a', 0, NOTE_GRID, 66), spellingOverride: F_SHARP }] },
    });
    const result = run(doc, { kind: 'moveNoteSemitones', id: 'a', delta: 1 });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.melody.notes[0]).toEqual(note('a', 0, NOTE_GRID, 67));
    }
  });

  it('rejects targets outside 36..96 carrying the computed target midi', () => {
    const top = docWith({ melody: { notes: [note('a', 0, NOTE_GRID, MIDI_MAX)] } });
    expect(run(top, { kind: 'moveNoteSemitones', id: 'a', delta: 1 })).toEqual({
      kind: 'rejected',
      reason: { kind: 'midi_out_of_range', midi: MIDI_MAX + 1 },
    });
    const bottom = docWith({ melody: { notes: [note('a', 0, NOTE_GRID, MIDI_MIN)] } });
    expect(run(bottom, { kind: 'moveNoteSemitones', id: 'a', delta: -12 })).toEqual({
      kind: 'rejected',
      reason: { kind: 'midi_out_of_range', midi: 24 },
    });
  });
});

// ---------------------------------------------------------------------------
// Harmony lane
// ---------------------------------------------------------------------------

describe('addChordRange', () => {
  it('replaces the range and merges adjacent identical chords keeping the EARLIER id', () => {
    const doc = freshDoc();
    const first = run(doc, {
      kind: 'addChordRange',
      id: 'first',
      startTick: 0,
      durationTicks: CHORD_GRID,
      chord: { root: C, templateId: 'maj' },
    });
    expect(first.kind).toBe('applied');

    const second = run(
      first.kind === 'applied' ? first.project : doc,
      {
        kind: 'addChordRange',
        id: 'second',
        startTick: CHORD_GRID,
        durationTicks: CHORD_GRID,
        chord: { root: C, templateId: 'maj' },
      },
    );
    expect(second.kind).toBe('applied');
    if (second.kind === 'applied') {
      // §3.7 step 7: the earlier chord survives and extends over both slots.
      expect(second.project.harmony.chords).toEqual([
        { id: 'first', startTick: 0, durationTicks: 2 * CHORD_GRID, chord: { root: C, templateId: 'maj' } },
      ]);
    }
  });

  it('caps duration at project length', () => {
    const doc = freshDoc();
    const length = projectLengthTicks(doc);
    const result = run(doc, {
      kind: 'addChordRange',
      id: 'c',
      startTick: 0,
      durationTicks: length * 2,
      chord: { root: C, templateId: 'maj' },
    });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords[0]!.durationTicks).toBe(length);
    }
  });

  it('rejects a projected lane beyond MAX_CHORD_EVENTS (§3.21)', () => {
    const doc = docWith({
      timing: { ppq: 960, bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, bars: 128 },
      harmony: {
        ...freshDoc().harmony,
        chords: Array.from({ length: MAX_CHORD_EVENTS }, (_, i) =>
          chord(`c${i}`, (i + 1) * CHORD_GRID, CHORD_GRID, i % 2 ? C : D),
        ),
      },
    });
    const result = run(doc, {
      kind: 'addChordRange',
      id: 'new',
      startTick: 0,
      durationTicks: CHORD_GRID,
      chord: { root: C, templateId: 'maj' },
    });
    expect(result).toEqual({ kind: 'rejected', reason: { kind: 'chord_limit' } });
  });

  it('accepts a replacing add that shrinks the lane AT the cap', () => {
    const doc = docWith({
      timing: { ppq: 960, bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, bars: 128 },
      harmony: {
        ...freshDoc().harmony,
        chords: Array.from({ length: MAX_CHORD_EVENTS }, (_, i) =>
          chord(`c${i}`, i * CHORD_GRID, CHORD_GRID, i % 2 ? C : D),
        ),
      },
    });
    const result = run(doc, {
      kind: 'addChordRange',
      id: 'new',
      startTick: (MAX_CHORD_EVENTS - 2) * CHORD_GRID,
      durationTicks: 2 * CHORD_GRID,
      chord: { root: D, templateId: 'maj' }, // distinct root → no extra merge
    });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords).toHaveLength(MAX_CHORD_EVENTS - 1);
    }
  });

  it('rejects negative and zero durations instead of quantizing them onto the grid', () => {
    const doc = freshDoc();
    expect(
      run(doc, { kind: 'addChordRange', id: 'c', startTick: 0, durationTicks: -CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
    ).toEqual({ kind: 'rejected', reason: { kind: 'invalid_event' } });
    expect(
      run(doc, { kind: 'addChordRange', id: 'c', startTick: 0, durationTicks: 0, chord: { root: C, templateId: 'maj' } }),
    ).toEqual({ kind: 'rejected', reason: { kind: 'invalid_event' } });
  });
});

describe('setChordSpec', () => {
  it('absorbs the edited LATER chord into the earlier identical neighbor', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('a', 0, CHORD_GRID, D),
          chord('b', CHORD_GRID, CHORD_GRID),
        ],
      },
    });
    const result = run(doc, { kind: 'setChordSpec', id: 'b', chord: { root: D, templateId: 'maj' } });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords).toEqual([chord('a', 0, 2 * CHORD_GRID, D)]);
    }
  });

  it('treats an identical spec as unchanged and rejects unknown ids', () => {
    const doc = docWith({ harmony: { ...freshDoc().harmony, chords: [chord('a', 0, CHORD_GRID)] } });
    expect(run(doc, { kind: 'setChordSpec', id: 'a', chord: { root: C, templateId: 'maj' } })).toEqual({
      kind: 'unchanged',
    });
    expect(run(doc, { kind: 'setChordSpec', id: 'x', chord: { root: C, templateId: 'min' } })).toEqual({
      kind: 'rejected',
      reason: { kind: 'not_found' },
    });
  });
});

describe('deleteChord', () => {
  it('canonicalizes an already-contiguous identical pair after any delete', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('a', 0, CHORD_GRID),
          chord('b', CHORD_GRID, CHORD_GRID),
          chord('x', 2 * CHORD_GRID, CHORD_GRID, D),
        ],
      },
    });
    const result = run(doc, { kind: 'deleteChord', id: 'x' });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords).toEqual([chord('a', 0, 2 * CHORD_GRID)]);
    }
  });

  it('never bridges the deleted range or a gap between identical chords', () => {
    const tripled = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('a', 0, CHORD_GRID),
          chord('b', CHORD_GRID, CHORD_GRID),
          chord('c', 2 * CHORD_GRID, CHORD_GRID),
        ],
      },
    });
    const result = run(tripled, { kind: 'deleteChord', id: 'b' });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords.map((c) => c.id)).toEqual(['a', 'c']);
    }

    const gapped = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('a', 0, CHORD_GRID),
          chord('x', CHORD_GRID, CHORD_GRID, D),
          chord('c', 2 * CHORD_GRID, CHORD_GRID),
        ],
      },
    });
    const gapResult = run(gapped, { kind: 'deleteChord', id: 'x' });
    expect(gapResult.kind).toBe('applied');
    if (gapResult.kind === 'applied') {
      expect(gapResult.project.harmony.chords.map((c) => c.id)).toEqual(['a', 'c']);
    }
  });
});

describe('moveChord / resizeChord / moveResizeChord', () => {
  it('quantizes an off-grid move and merges flush identical neighbors', () => {
    const doc = docWith({ harmony: { ...freshDoc().harmony, chords: [chord('a', 0, CHORD_GRID)] } });
    const moved = run(doc, { kind: 'moveChord', id: 'a', newStartTick: 1000 });
    expect(moved.kind).toBe('applied');
    if (moved.kind === 'applied') {
      expect(moved.project.harmony.chords[0]!.startTick).toBe(CHORD_GRID);
    }

    const pair = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [chord('a', 0, CHORD_GRID), chord('b', 3 * CHORD_GRID, CHORD_GRID)],
      },
    });
    const flushed = run(pair, { kind: 'moveChord', id: 'b', newStartTick: CHORD_GRID });
    expect(flushed.kind).toBe('applied');
    if (flushed.kind === 'applied') {
      expect(flushed.project.harmony.chords).toEqual([chord('a', 0, 2 * CHORD_GRID)]);
    }

    expect(run(doc, { kind: 'moveChord', id: 'a', newStartTick: 0 })).toEqual({ kind: 'unchanged' });
  });

  it('caps resize growth at the next neighbor and reports no-change states', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [chord('a', 0, CHORD_GRID), chord('b', 2 * CHORD_GRID, CHORD_GRID, D)],
      },
    });
    const result = run(doc, { kind: 'resizeChord', id: 'a', newDurationTicks: 8 * CHORD_GRID });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords[0]!.durationTicks).toBe(2 * CHORD_GRID);
      expect(result.project.harmony.chords[1]!.startTick).toBe(2 * CHORD_GRID);
    }
    expect(run(doc, { kind: 'resizeChord', id: 'a', newDurationTicks: CHORD_GRID })).toEqual({
      kind: 'unchanged',
    });
  });

  it('resolves atomic left-edge resizes inside the window (RevUI-1)', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('a', 0, CHORD_GRID),
          chord('b', 2 * CHORD_GRID, CHORD_GRID, D),
          chord('c', 3 * CHORD_GRID, CHORD_GRID, E),
        ],
      },
    });
    const result = run(doc, {
      kind: 'moveResizeChord',
      id: 'b',
      newStartTick: CHORD_GRID,
      newDurationTicks: 2 * CHORD_GRID,
    });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords.map((c) => c.id)).toEqual(['a', 'b', 'c']);
      expect(result.project.harmony.chords[1]).toEqual(
        chord('b', CHORD_GRID, 2 * CHORD_GRID, D),
      );
    }
  });
});

describe('setChordPatternOverride', () => {
  const pattern = {
    kind: 'up' as const,
    subdivisionTicks: 240 as const,
    gate: 0.8,
    octaveSpan: 1 as const,
    velocity: 80,
  };

  it('clearing an override can merge the now-identical pair (earlier id kept)', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [
          { ...chord('a', 0, CHORD_GRID), patternOverride: pattern },
          chord('b', CHORD_GRID, CHORD_GRID),
          chord('x', 2 * CHORD_GRID, CHORD_GRID, D),
        ],
      },
    });
    const result = run(doc, { kind: 'setChordPatternOverride', id: 'a', pattern: null });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords).toEqual([chord('a', 0, 2 * CHORD_GRID), chord('x', 2 * CHORD_GRID, CHORD_GRID, D)]);
    }
  });

  it('detects value-equal overrides and unknown ids', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [{ ...chord('a', 0, CHORD_GRID), patternOverride: pattern }],
      },
    });
    expect(
      run(doc, { kind: 'setChordPatternOverride', id: 'a', pattern: { ...pattern } }),
    ).toEqual({ kind: 'unchanged' });
    expect(
      run(doc, { kind: 'setChordPatternOverride', id: 'x', pattern: null }),
    ).toEqual({ kind: 'rejected', reason: { kind: 'not_found' } });
    // Setting when absent applies.
    const bare = docWith({ harmony: { ...freshDoc().harmony, chords: [chord('a', 0, CHORD_GRID)] } });
    const result = run(bare, { kind: 'setChordPatternOverride', id: 'a', pattern });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmony.chords[0]!.patternOverride).toEqual(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// Global document fields
// ---------------------------------------------------------------------------

describe('setTitle', () => {
  it('trims, clamps to 60 chars, rejects empties, and detects no-ops', () => {
    const doc = freshDoc();
    const result = run(doc, { kind: 'setTitle', title: '  Соната  ' });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.title).toBe('Соната');
    }
    expect(run(doc, { kind: 'setTitle', title: ' Test ' })).toEqual({ kind: 'unchanged' });
    expect(run(doc, { kind: 'setTitle', title: '   ' })).toEqual({
      kind: 'rejected',
      reason: { kind: 'title_empty' },
    });

    const long = run(doc, { kind: 'setTitle', title: 'Я'.repeat(100) });
    expect(long.kind).toBe('applied');
    if (long.kind === 'applied') {
      expect(long.project.title).toBe('Я'.repeat(60));
    }
  });
});

describe('setBpm', () => {
  it('accepts fractional tempos, rejects non-finite/out-of-range, detects no-ops', () => {
    const doc = freshDoc(); // bpm 120
    const result = run(doc, { kind: 'setBpm', bpm: 120.5 });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.timing.bpm).toBe(120.5);
    }
    expect(run(doc, { kind: 'setBpm', bpm: 120 })).toEqual({ kind: 'unchanged' });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 39.9, 240.1]) {
      expect(run(doc, { kind: 'setBpm', bpm: bad })).toEqual({
        kind: 'rejected',
        reason: { kind: 'bpm_out_of_range' },
      });
    }
  });
});

describe('setBars', () => {
  it('growing keeps every event byte-equal (same references survive)', () => {
    const doc = docWith({
      melody: { notes: [note('n', 0, NOTE_GRID)] },
      harmony: { ...freshDoc().harmony, chords: [chord('c', 0, CHORD_GRID)] },
    });
    const result = run(doc, { kind: 'setBars', bars: doc.timing.bars + 8 });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.timing.bars).toBe(doc.timing.bars + 8);
      expect(result.project.melody.notes[0]).toBe(doc.melody.notes[0]);
      expect(result.project.harmony.chords[0]).toBe(doc.harmony.chords[0]);
    }
  });

  it('shrinking drops beyond-boundary events and truncates straddlers, preserving ids', () => {
    const boundary = 2 * TICKS_PER_BAR;
    const doc = docWith({
      melody: {
        notes: [
          note('inside', 0, NOTE_GRID),
          { ...note('straddle', boundary - NOTE_GRID, NOTE_GRID * 3, 62) },
          note('outside', boundary + NOTE_GRID, NOTE_GRID, 64),
        ],
      },
      harmony: {
        ...freshDoc().harmony,
        chords: [
          chord('chord-straddle', boundary - CHORD_GRID, CHORD_GRID * 3),
          chord('chord-outside', boundary + CHORD_GRID, CHORD_GRID, D),
        ],
      },
    });
    const result = run(doc, { kind: 'setBars', bars: 2 });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.timing.bars).toBe(2);
    expect(result.project.melody.notes.map((n) => n.id)).toEqual(['inside', 'straddle']);
    expect(result.project.melody.notes[1]!.durationTicks).toBe(NOTE_GRID);
    expect(result.project.harmony.chords.map((c) => c.id)).toEqual(['chord-straddle']);
    expect(result.project.harmony.chords[0]!.durationTicks).toBe(CHORD_GRID);
  });

  it('keeps events ending EXACTLY at the boundary by reference (BARS-E1)', () => {
    const boundary = 2 * TICKS_PER_BAR;
    const doc = docWith({
      melody: { notes: [note('edge', boundary - NOTE_GRID, NOTE_GRID)] },
      harmony: { ...freshDoc().harmony, chords: [chord('cedge', boundary - CHORD_GRID, CHORD_GRID)] },
    });
    const result = run(doc, { kind: 'setBars', bars: 2 });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.melody.notes[0]).toBe(doc.melody.notes[0]);
      expect(result.project.harmony.chords[0]).toBe(doc.harmony.chords[0]);
    }
  });

  it('rejects non-finite/non-integer/out-of-range input outright', () => {
    const doc = freshDoc();
    for (const bad of [2.5, Number.NaN, Number.POSITIVE_INFINITY, 0, 129]) {
      expect(run(doc, { kind: 'setBars', bars: bad })).toEqual({
        kind: 'rejected',
        reason: { kind: 'bars_out_of_range' },
      });
    }
  });

  it('reports unchanged for the current bar count', () => {
    expect(run(freshDoc(), { kind: 'setBars', bars: freshDoc().timing.bars })).toEqual({
      kind: 'unchanged',
    });
  });
});

describe('setDefaultPattern / setMode', () => {
  it('default pattern: identical spec is unchanged; a new spec applies', () => {
    const doc = freshDoc();
    const current = doc.harmony.defaultPattern;
    expect(run(doc, { kind: 'setDefaultPattern', pattern: { ...current } })).toEqual({
      kind: 'unchanged',
    });
    const changed = run(doc, {
      kind: 'setDefaultPattern',
      pattern: { ...current, gate: 0.5 },
    });
    expect(changed.kind).toBe('applied');
    if (changed.kind === 'applied') {
      expect(changed.project.harmony.defaultPattern.gate).toBe(0.5);
    }
  });

  it('mode: applying and no-op detection', () => {
    const doc = freshDoc();
    const result = run(doc, { kind: 'setMode', mode: 'dorian' });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.project.harmonyContext.mode).toBe('dorian');
      expect(result.project.melody.notes).toEqual(doc.melody.notes); // midis untouched
    }
    expect(run(doc, { kind: 'setMode', mode: 'ionian' })).toEqual({ kind: 'unchanged' });
  });
});

describe('transposeToTonic', () => {
  it('transposes roots and melody, respelling into the new key (§3.14)', () => {
    const doc = docWith({
      melody: { notes: [note('n', 0, NOTE_GRID, 60)] },
      harmony: { ...freshDoc().harmony, chords: [chord('c', 0, CHORD_GRID)] },
    });
    const result = run(doc, { kind: 'transposeToTonic', targetTonic: D });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.harmonyContext.tonic).toEqual(D);
    expect(result.project.melody.notes[0]!.midi).toBe(62);
    expect(result.project.harmony.chords[0]!.chord.root).toEqual(D);
    expect(result.project.updatedAt).toBe(doc.updatedAt); // timestamps stay state-owned
  });

  it('rejects wholesale when ANY note would leave the midi range', () => {
    const doc = docWith({ melody: { notes: [note('n', 0, NOTE_GRID, MIDI_MAX)] } });
    const result = run(doc, { kind: 'transposeToTonic', targetTonic: D });
    expect(result).toEqual({
      kind: 'rejected',
      reason: { kind: 'transpose_out_of_range', offendingNoteIds: ['n'] },
    });
  });

  it('reports the same tonic (any spelling) without dispatching a change', () => {
    expect(run(freshDoc(), { kind: 'transposeToTonic', targetTonic: parseSpelled('Dbb')! })).toEqual({
      kind: 'rejected',
      reason: { kind: 'same_tonic' },
    });
  });

  it('transposes a loaded OVERLAPPING lane (overlap is load-tolerated, BUG-1)', () => {
    const doc = docWith({
      harmony: {
        ...freshDoc().harmony,
        chords: [chord('a', 0, 2 * CHORD_GRID), chord('b', CHORD_GRID, CHORD_GRID)],
      },
    });
    const result = run(doc, { kind: 'transposeToTonic', targetTonic: G });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.project.harmony.chords.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.project.harmony.chords.map((c) => c.chord.root)).toEqual([G, G]);
  });
});

describe('invariant gate (§3.7 step 8)', () => {
  it('rejects EVERY mutation while the present document carries a violation…', () => {
    // …except out_of_bounds, which load normalization may produce legally.
    const poisoned = docWith({
      melody: { notes: [{ ...note('bad', 505, NOTE_GRID, 62) }] }, // off-grid start
    });
    expect(run(poisoned, { kind: 'setBpm', bpm: 96 })).toEqual({
      kind: 'rejected',
      reason: { kind: 'invariant_violation' },
    });
    expect(run(poisoned, { kind: 'setMode', mode: 'dorian' })).toEqual({
      kind: 'rejected',
      reason: { kind: 'invariant_violation' },
    });
  });

  it('tolerates out_of_bounds events carried from a legal load (BUG-2)', () => {
    const length = projectLengthTicks(freshDoc());
    const doc = docWith({
      melody: {
        notes: [note('n1', 0, NOTE_GRID * 2), { ...note('n3', length, NOTE_GRID, 67) }],
      },
    });
    const result = run(doc, {
      kind: 'addNote',
      id: 'n2',
      startTick: NOTE_GRID * 8,
      durationTicks: NOTE_GRID,
      midi: 64,
      velocity: 90,
    });
    expect(result.kind).toBe('applied');
    expect(run(doc, { kind: 'setBpm', bpm: 96 }).kind).toBe('applied');
  });

  it('tolerates overlapping lanes carried from a legal load (BUG-1)', () => {
    const doc = docWith({
      melody: { notes: [note('a', 0, NOTE_GRID * 3), note('b', NOTE_GRID, NOTE_GRID, 64)] },
    });
    // A pure global mutation and a lane mutation both go through.
    expect(run(doc, { kind: 'setBpm', bpm: 96 }).kind).toBe('applied');
    const result = run(doc, {
      kind: 'addNote',
      id: 'n',
      startTick: NOTE_GRID * 8,
      durationTicks: NOTE_GRID,
      midi: 65,
      velocity: 90,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    // The tolerated overlap survives untouched outside the replaced range.
    expect(result.project.melody.notes.map((note_) => note_.id)).toEqual(['a', 'b', 'n']);
  });
});
