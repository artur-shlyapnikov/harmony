/**
 * Spelled pitch classes (§3.5 Pitch spelling).
 *
 * Spelling is preserved separately from the numeric pitch class so that,
 * e.g., F# and Gb remain distinct entities in the document model.
 */

export type NoteLetter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

/** Semitone offset from natural spelling: -2 = bb/double flat … 2 = ##/double sharp. */
export type Accidental = -2 | -1 | 0 | 1 | 2;

export type SpelledPitchClass = {
  letter: NoteLetter;
  accidental: Accidental;
};

export type ModeId =
  | 'ionian'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'aeolian'
  | 'locrian';

/** Runtime table mirroring the ModeId union — for validating untrusted input (stored payloads). */
export const MODE_IDS: readonly ModeId[] = Object.freeze([
  'ionian',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'aeolian',
  'locrian',
]);

export const LETTER_SEMITONES: Readonly<Record<NoteLetter, number>> = Object.freeze({
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
});

const NOTE_LETTERS: readonly NoteLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** Numeric pitch class 0..11 (C-based). */
export function pitchClassOf(note: SpelledPitchClass): number {
  return (LETTER_SEMITONES[note.letter] + note.accidental + 120) % 12;
}

/** Canonical short name, e.g. "F#", "Bb", "C". */
export function spelledName(note: SpelledPitchClass): string {
  if (note.accidental === 0) return note.letter;
  if (note.accidental > 0) return note.letter + '#'.repeat(note.accidental);
  return note.letter + 'b'.repeat(-note.accidental);
}

/** Parses canonical short names ("F#", "Bb", "G"); returns null on failure. */
export function parseSpelled(name: string): SpelledPitchClass | null {
  const match = /^([A-Ga-g])(#{1,2}|b{1,2})?$/.exec(name.trim());
  if (!match) return null;

  const rawLetter = match[1];
  if (rawLetter === undefined) return null;
  const upper = rawLetter.toUpperCase();
  // Typed lookup keeps the compiler in the loop: no casts anywhere.
  const letter = NOTE_LETTERS.find((candidate) => candidate === upper);
  if (letter === undefined) return null;

  let accidental: Accidental = 0;
  switch (match[2]) {
    case '#':
      accidental = 1;
      break;
    case '##':
      accidental = 2;
      break;
    case 'b':
      accidental = -1;
      break;
    case 'bb':
      accidental = -2;
      break;
    case undefined:
      break;
  }
  return { letter, accidental };
}

export const MIDI_MIN = 36;
export const MIDI_MAX = 96;
