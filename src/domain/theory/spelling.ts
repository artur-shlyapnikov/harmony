/**
 * Pitch spelling in a harmonic context (§3.5 Pitch spelling, §3.14 step 5).
 *
 * Core engine used by the tonal adapter and by melody formatting. No 'tonal'
 * import here — this module is pure domain math.
 *
 * Deterministic tie-breaks (documented per contract):
 *  1. If the pitch class is a diatonic degree of the context mode, its
 *     diatonic spelling wins (e.g. F# in D ionian, Eb in Eb major).
 *  2. Otherwise candidates with the smallest |accidental| win
 *     (a natural spelling always beats an altered one).
 *  3. Remaining ties (e.g. F#/Gb) are resolved by the KEY BIAS: a key whose
 *     diatonic set needs more sharps than flats is sharp-biased, more flats
 *     than sharps is flat-biased, and a fully neutral diatonic set (C major,
 *     D dorian, ...) defaults to SHARP bias.
 */

import {
  type Accidental,
  type NoteLetter,
  type SpelledPitchClass,
  LETTER_SEMITONES,
  pitchClassOf,
  spelledName,
} from '../model/pitch';
import type { HarmonyContext } from '../model/project';
import { getModeProfile } from './modeProfiles';

const NOTE_LETTERS: readonly NoteLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

export type DiatonicDegree = SpelledPitchClass & { pc: number };

/** Deterministic enharmonic respelling rule (§3.5 hardening):
 * among all letter/accidental spellings of a pitch class with
 * |accidental| ≤ 2, pick the one minimizing |accidental|; true ties resolve
 * by `preferSharps` (the key bias, per §3.5 rule 3).
 * Every pitch class has such a spelling, so this never fails. */
function respellWithinRange(pc: number, preferSharps: boolean): SpelledPitchClass {
  let best: SpelledPitchClass | null = null;
  for (let acc = -2; acc <= 2; acc++) {
    for (const letter of NOTE_LETTERS) {
      const candidatePc = (((LETTER_SEMITONES[letter] + acc) % 12) + 12) % 12;
      if (candidatePc !== pc) continue;
      if (
        best === null ||
        Math.abs(acc) < Math.abs(best.accidental) ||
        (Math.abs(acc) === Math.abs(best.accidental) &&
          (preferSharps ? acc > best.accidental : acc < best.accidental))
      ) {
        best = { letter, accidental: acc as Accidental };
      }
    }
  }
  if (best === null) throw new Error(`No in-range spelling for pitch class ${pc}`);
  return best;
}

 /** The seven spelled diatonic degrees of the context mode, tonic first. */
 export function modeScaleDegrees(context: HarmonyContext): DiatonicDegree[] {
   const intervals = getModeProfile(context.mode).intervals;
   const tonicPc = pitchClassOf(context.tonic);
   const tonicLetterIndex = NOTE_LETTERS.indexOf(context.tonic.letter);
   // First pass: wrap each degree's required alteration into [-6, 5]; sane
   // keys land in [-2, 2].
   type Draft = { letter: NoteLetter; pc: number; accidental: Accidental };
   const drafts: Draft[] = [];
   for (let i = 0; i < 7; i++) {
     const letter = NOTE_LETTERS[(tonicLetterIndex + i) % 7];
     if (!letter) throw new Error(`Bad letter index ${tonicLetterIndex}`);
     const pc = (tonicPc + (intervals[i] ?? 0)) % 12;
    const raw = pc - LETTER_SEMITONES[letter];
    // Non-negative remainder first: JS `%` keeps the dividend's sign, so a
    // plain `(raw + 6) % 12` misclassifies raw < -6 (e.g. the B# degree of
    // E# major, raw = -11) as out-of-range and respells it.
    const mod = (((raw % 12) + 12) % 12);
    const wrapped = (mod > 6 ? mod - 12 : mod) as Accidental;
     drafts.push({ letter, pc, accidental: wrapped });
   }
   const inRange = (degree: Draft) => degree.accidental >= -2 && degree.accidental <= 2;
   if (drafts.every(inRange)) {
     return drafts.map(({ letter, pc, accidental }) => ({ letter, accidental, pc }));
   }
   // §3.5 invariant: never emit more than double accidentals — extreme tonics
   // (B#, Fb, …) respell to the simplest equivalent within range. Enharmonic
   // ties honor the key bias, counted from the in-range degrees (neutral
   // defaults to sharp, matching keyAccidentalBias).
   let sharps = 0;
   let flats = 0;
   for (const degree of drafts) {
     if (!inRange(degree)) continue;
     if (degree.accidental > 0) sharps++;
     if (degree.accidental < 0) flats++;
   }
   const preferSharps = flats <= sharps;
   return drafts.map((degree) =>
     inRange(degree)
       ? { letter: degree.letter, accidental: degree.accidental, pc: degree.pc }
       : { ...respellWithinRange(degree.pc, preferSharps), pc: degree.pc },
   );
 }

export type AccidentalBias = 'sharp' | 'flat';

/**
 * Key bias from the diatonic set: count degrees needing sharps vs flats.
 * Neutral sets (equal counts, e.g. C major) default to 'sharp'.
 */
export function keyAccidentalBias(context: HarmonyContext): AccidentalBias {
  let sharps = 0;
  let flats = 0;
  for (const degree of modeScaleDegrees(context)) {
    if (degree.accidental > 0) sharps++;
    if (degree.accidental < 0) flats++;
  }
  return flats > sharps ? 'flat' : 'sharp';
}

function candidatesFor(pc: number): SpelledPitchClass[] {
  const result: SpelledPitchClass[] = [];
  for (const letter of NOTE_LETTERS) {
    for (let acc = -2; acc <= 2; acc++) {
      if (((LETTER_SEMITONES[letter] + acc) % 12 + 12) % 12 === pc) {
        result.push({ letter, accidental: acc as Accidental });
      }
    }
  }
  return result;
}

/**
 * Spells a pitch class in the context: diatonic spelling if possible, else
 * minimal-accidental candidate matching the key's sharp/flat bias.
 */
export function spellPitchClassInContext(
  pc: number,
  context: HarmonyContext,
): SpelledPitchClass {
  const normalized = ((pc % 12) + 12) % 12;
  for (const degree of modeScaleDegrees(context)) {
    if (degree.pc === normalized) {
      return { letter: degree.letter, accidental: degree.accidental };
    }
  }
  const bias = keyAccidentalBias(context);
  let best: SpelledPitchClass | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidatesFor(normalized)) {
    const biasPenalty =
      candidate.accidental === 0
        ? 0
        : (bias === 'sharp' && candidate.accidental > 0) ||
            (bias === 'flat' && candidate.accidental < 0)
          ? 0
          : 1;
    const score = Math.abs(candidate.accidental) * 10 + biasPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best) {
    throw new Error(`No spelling found for pitch class ${pc}`);
  }
  return best;
}

/** Octave-independent spelling of a melody MIDI note. */
export function spellMelodyMidi(
  midi: number,
  context: HarmonyContext,
): SpelledPitchClass {
  return spellPitchClassInContext(midi % 12, context);
}

/** "F#5" style rendering; octave = Math.floor(midi / 12) - 1. */
export function formatNoteNameWithOctave(
  midi: number,
  context: HarmonyContext,
): string {
  return spelledName(spellMelodyMidi(midi, context)) + (Math.floor(midi / 12) - 1);
}
