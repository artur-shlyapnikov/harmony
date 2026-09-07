import { describe, expect, it } from 'vitest';

import { type SpelledPitchClass, parseSpelled } from '@domain/model/pitch';
import {
  type ProjectDocumentV1,
  createProjectDocument,
} from '@domain/model/project';
import { type ChordTemplateId } from '@domain/model/chord';
import {
  semitoneDistance,
  transposeProjectToTonic,
} from '@domain/transpose/transposeProject';

const C = parseSpelled('C')!;
const D = parseSpelled('D')!;
const FS = parseSpelled('F#')!;
const GB = parseSpelled('Gb')!;

function projectWith(
  overrides: Partial<{
    tonic?: SpelledPitchClass;
    mode: 'ionian' | 'dorian';
    notes: Array<{
      id: string;
      midi: number;
      spellingOverride?: { letter: string; accidental: number };
    }>;
    chords: Array<{ id: string; root: string; templateId: ChordTemplateId }>;
  }>,
): ProjectDocumentV1 {
  const doc = createProjectDocument({
    title: 'test',
    tonic: overrides.tonic ?? C,
    mode: overrides.mode ?? 'ionian',
  });

  if (overrides.notes) {
    doc.melody.notes = overrides.notes.map((note) => ({
      id: note.id,
      startTick: 0,
      durationTicks: 960,
      midi: note.midi,
      velocity: 100,
      ...(note.spellingOverride !== undefined
        ? { spellingOverride: note.spellingOverride as never }
        : {}),
    }));
  }

  if (overrides.chords) {
    doc.harmony.chords = overrides.chords.map((chord) => ({
      id: chord.id,
      startTick: 0,
      durationTicks: 3840,
      chord: { root: parseSpelled(chord.root)!, templateId: chord.templateId },
    }));
  }

  return doc;
}

describe('semitoneDistance', () => {
  it('computes the signed shortest distance', () => {
    expect(semitoneDistance(C, D)).toBe(2);
    expect(semitoneDistance(D, C)).toBe(-2);
    expect(semitoneDistance(parseSpelled('E')!, C)).toBe(-4);
  });

  it('resolves the tritone tie upward: +6 both ways', () => {
    expect(semitoneDistance(C, FS)).toBe(6);
    expect(semitoneDistance(C, GB)).toBe(6);
    expect(semitoneDistance(FS, C)).toBe(6);
  });
});

describe('transposeProjectToTonic', () => {
  it('C ionian -> D: melody shifts +2, Cmaj7 respells to Dmaj7 (not Ebb)', () => {
    const doc = projectWith({
      notes: [{ id: 'n1', midi: 60 }],
      chords: [{ id: 'c1', root: 'C', templateId: 'maj7' }],
    });

    const result = transposeProjectToTonic(doc, D);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = result.project;
    expect(next.harmonyContext.tonic).toEqual(D);
    expect(next.melody.notes[0]!.midi).toBe(62);

    const root = next.harmony.chords[0]!.chord.root;
    expect(root).toEqual({ letter: 'D', accidental: 0 });
  });

  it('respells a note WITH spellingOverride key-aware: F# override -> G# in D ionian', () => {
    const doc = projectWith({
      notes: [
        { id: 'n1', midi: 66, spellingOverride: { letter: 'F', accidental: 1 } },
      ],
    });

    const result = transposeProjectToTonic(doc, D);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // F# + M2 -> G# (Tonal letter motion), pc 8 is not diatonic in D ionian.
    expect(result.project.melody.notes[0]!.spellingOverride).toEqual({
      letter: 'G',
      accidental: 1,
    });
  });

  it('round-trip C -> D -> C deep-equals the original document', () => {
    const doc = projectWith({
      notes: [
        { id: 'n1', midi: 60 },
        { id: 'n2', midi: 66, spellingOverride: { letter: 'F', accidental: 1 } },
        { id: 'n3', midi: 72 },
      ],
      chords: [
        { id: 'c1', root: 'C', templateId: 'maj' },
        { id: 'c2', root: 'G', templateId: '7' },
      ],
    });

    const up = transposeProjectToTonic(doc, D);
    expect(up.ok).toBe(true);
    if (!up.ok) return;

    const down = transposeProjectToTonic(up.project, C);
    expect(down.ok).toBe(true);
    if (!down.ok) return;

    expect(JSON.stringify(down.project)).toBe(JSON.stringify(doc));
  });

  it('rejects atomically when any note leaves 36..96; input untouched', () => {
    const doc = projectWith({
      notes: [
        { id: 'safe', midi: 60 },
        { id: 'edge', midi: 95 },
      ],
      chords: [{ id: 'c1', root: 'C', templateId: 'maj' }],
    });
    const snapshot = JSON.stringify(doc);

    const result = transposeProjectToTonic(doc, D);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('out_of_range');
    if (result.error.kind !== 'out_of_range') return;
    expect(result.error.offendingNoteIds).toContain('edge');
    expect(result.error.offendingNoteIds).not.toContain('safe');

    // Immutability: the original document object is unchanged.
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('reports same_tonic for an equal pitch class regardless of spelling', () => {
    const doc = projectWith({});
    expect(transposeProjectToTonic(doc, C)).toEqual({
      ok: false,
      error: { kind: 'same_tonic' },
    });
    // Same pc, different spelling.
    expect(transposeProjectToTonic(doc, parseSpelled('Dbb')!)).toEqual({
      ok: false,
      error: { kind: 'same_tonic' },
    });
  });

  it('preserves mode: dorian stays dorian', () => {
    const doc = projectWith({ mode: 'dorian', notes: [{ id: 'n1', midi: 62 }] });

    const result = transposeProjectToTonic(doc, D);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.harmonyContext.mode).toBe('dorian');
    expect(result.project.harmonyContext.tonic).toEqual(D);
  });

  it('preserves patternOverride on chords', () => {
    const doc = projectWith({ chords: [{ id: 'c1', root: 'C', templateId: 'maj' }] });
    const pattern = { name: 'block', steps: [1, 0, 0, 0] } as never;
    doc.harmony.chords[0]!.patternOverride = pattern;

    const result = transposeProjectToTonic(doc, D);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.harmony.chords[0]!.patternOverride).toEqual(pattern);
  });

  it('transposes an empty project without changes to timing or ids', () => {
    const doc = projectWith({});

    const result = transposeProjectToTonic(doc, D);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = result.project;
    expect(next.melody.notes).toHaveLength(0);
    expect(next.harmony.chords).toHaveLength(0);
    expect(next.timing).toEqual(doc.timing);
    expect(next.id).toBe(doc.id);
    // updatedAt is owned by the state layer — not modified here.
    expect(next.updatedAt).toBe(doc.updatedAt);
  });

  it('does not mutate the input and returns a fresh object', () => {
    const doc = projectWith({
      notes: [{ id: 'n1', midi: 60 }],
      chords: [{ id: 'c1', root: 'C', templateId: 'maj7' }],
    });
    const snapshot = JSON.stringify(doc);

    const result = transposeProjectToTonic(doc, D);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.project).not.toBe(doc);
    expect(result.project.melody.notes[0]).not.toBe(doc.melody.notes[0]);
  });
  it('rejects atomically at the exact top edge: note at 96 with +1 shift; note at 95 lands on 96 (§3.14)', () => {
    const rejected = projectWith({
      notes: [{ id: 'top', midi: 96 }],
      chords: [{ id: 'c1', root: 'C', templateId: 'maj' }],
    });
    const snapshot = JSON.stringify(rejected);
    const db = parseSpelled('Db')!; // signed distance from C is exactly +1

    const result = transposeProjectToTonic(rejected, db);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('out_of_range');
    if (result.error.kind !== 'out_of_range') return;
    expect(result.error.offendingNoteIds).toContain('top');
    // Atomic: input byte-equal untouched.
    expect(JSON.stringify(rejected)).toBe(snapshot);

    // One semitone below the ceiling the same shift succeeds and lands on 96.
    const accepted = projectWith({
      notes: [{ id: 'near-top', midi: 95 }],
      chords: [{ id: 'c1', root: 'C', templateId: 'maj' }],
    });
    const okResult = transposeProjectToTonic(accepted, db);
    expect(okResult.ok).toBe(true);
    if (!okResult.ok) return;
    expect(okResult.project.melody.notes[0]!.midi).toBe(96);
    expect(okResult.project.melody.notes[0]!.id).toBe('near-top');
  });

  it('rejects atomically at the exact bottom edge: note at 36 with −1 shift; note at 37 lands on 36 (§3.14)', () => {
    const rejected = projectWith({
      notes: [{ id: 'bottom', midi: 36 }],
      chords: [{ id: 'c1', root: 'C', templateId: 'maj' }],
    });
    const snapshot = JSON.stringify(rejected);
    const b = parseSpelled('B')!; // signed distance from C is exactly −1

    const result = transposeProjectToTonic(rejected, b);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('out_of_range');
    if (result.error.kind !== 'out_of_range') return;
    expect(result.error.offendingNoteIds).toContain('bottom');
    expect(JSON.stringify(rejected)).toBe(snapshot);

    const accepted = projectWith({
      notes: [{ id: 'near-bottom', midi: 37 }],
      chords: [{ id: 'c1', root: 'C', templateId: 'maj' }],
    });
    const okResult = transposeProjectToTonic(accepted, b);
    expect(okResult.ok).toBe(true);
    if (!okResult.ok) return;
    expect(okResult.project.melody.notes[0]!.midi).toBe(36);
    expect(okResult.project.melody.notes[0]!.id).toBe('near-bottom');
  });
});
