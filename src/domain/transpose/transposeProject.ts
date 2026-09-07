/**
 * Atomic project transposition (§3.14).
 *
 * Pure domain function: shifts every melody MIDI note and every chord root
 * by the signed shortest distance to the new tonic, respells everything in
 * the new key, and either commits the whole document or rejects it whole.
 * Durations, patterns, BPM, bars, ids and mode are untouched; timestamps are
 * owned by the state layer and are NOT modified here.
 */

import {
  type SpelledPitchClass,
  MIDI_MIN,
  MIDI_MAX,
  pitchClassOf,
} from '../model/pitch';
import type { ProjectDocumentV1 } from '../model/project';
import { spellPitchClassInContext } from '../theory/spelling';
import { transposeSpelledPitchClass } from '../theory/tonalAdapter';

export type TransposeError =
  | { kind: 'out_of_range'; offendingNoteIds: string[] }
  | { kind: 'same_tonic' };

export type TransposeResult =
  | { ok: true; project: ProjectDocumentV1 }
  | { ok: false; error: TransposeError };

/**
 * Signed shortest semitone distance between two pitch classes in [-6..6].
 * The tritone tie resolves upward: +6, never -6.
 */
export function semitoneDistance(
  from: SpelledPitchClass,
  to: SpelledPitchClass,
): number {
  const diff =
    (((pitchClassOf(to) - pitchClassOf(from)) % 12) + 12) % 12;
  return diff <= 6 ? diff : diff - 12;
}

/**
 * Transposes the whole project to `targetTonic` (§3.14):
 *
 * 1. Signed shortest distance old tonic -> new tonic (+6 on tritone tie).
 * 2. Same pitch class (any spelling, e.g. C vs Dbb) -> `same_tonic`.
 * 3. ALL melody midi values shift by the distance; if ANY note would leave
 *    36..96 the ENTIRE operation is rejected with every offending note id
 *    and the input document is left untouched.
 * 4. Chord roots shift mod 12 and are respelled via the new key's bias.
 * 5. Melody spelling overrides are transposed key-aware into the new context.
 * 6. Durations, patterns, BPM, bars, ids and mode stay exactly as they were.
 */
export function transposeProjectToTonic(
  project: ProjectDocumentV1,
  targetTonic: SpelledPitchClass,
): TransposeResult {
  const currentTonic = project.harmonyContext.tonic;

  if (pitchClassOf(currentTonic) === pitchClassOf(targetTonic)) {
    return { ok: false, error: { kind: 'same_tonic' } };
  }

  const distance = semitoneDistance(currentTonic, targetTonic);
  const newContext = {
    tonic: targetTonic,
    mode: project.harmonyContext.mode,
  };

  // Range check across ALL notes first — atomicity means nothing mutates
  // unless every note fits.
  const offendingNoteIds: string[] = [];
  for (const note of project.melody.notes) {
    const shifted = note.midi + distance;
    if (shifted < MIDI_MIN || shifted > MIDI_MAX) {
      offendingNoteIds.push(note.id);
    }
  }
  if (offendingNoteIds.length > 0) {
    return { ok: false, error: { kind: 'out_of_range', offendingNoteIds } };
  }

  const next = structuredClone(project);

  next.harmonyContext.tonic = { ...targetTonic };

  next.melody.notes = next.melody.notes.map((note) => ({
    ...note,
    midi: note.midi + distance,
    ...(note.spellingOverride !== undefined
      ? {
          spellingOverride: transposeSpelledPitchClass(
            note.spellingOverride,
            distance,
            newContext,
          ),
        }
      : {}),
  }));

  next.harmony.chords = next.harmony.chords.map((event) => {
    const newRootPc =
      (((pitchClassOf(event.chord.root) + distance) % 12) + 12) % 12;
    return {
      ...event,
      chord: {
        ...event.chord,
        root: spellPitchClassInContext(newRootPc, newContext),
      },
    };
  });

  return { ok: true, project: next };
}
