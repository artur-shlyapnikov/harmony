/**
 * Tonal adapter (§3.9 Tonal adapter).
 *
 * The ONLY module in the domain allowed to import the 'tonal' package.
 * No Tonal types or string formats leak: all public signatures use domain
 * types from model/pitch and model/project. Tonal is used internally for
 * interval/note math when transposing spelled pitch classes.
 */

import { Note } from 'tonal';

import {
  type SpelledPitchClass,
  parseSpelled,
  pitchClassOf,
  spelledName,
} from '../model/pitch';
import type { HarmonyContext } from '../model/project';
import { getModeProfile } from './modeProfiles';
import {
  keyAccidentalBias,
  modeScaleDegrees,
  spellPitchClassInContext,
} from './spelling';

/** TheoryPrimitives surface per §3.9; concrete functions below implement it. */
export interface TheoryPrimitives {
  pitchClassOfSpelled(note: SpelledPitchClass): number;
  transposeSpelledPitchClass(
    note: SpelledPitchClass,
    semitones: number,
    context: HarmonyContext,
  ): SpelledPitchClass;
  modePitchClasses(context: HarmonyContext): number[];
}

/** Interval shorthand for a semitone distance (sharp-side at the tritone). */
const INTERVAL_BY_SEMITONES: readonly string[] = Object.freeze([
  '1P',
  'm2',
  'M2',
  'm3',
  'M3',
  'P4',
  'A4',
  'P5',
  'm6',
  'M6',
  'm7',
  'M7',
]);

/** Numeric pitch class of a spelled note (delegates to the model). */
export function pitchClassOfSpelled(note: SpelledPitchClass): number {
  return pitchClassOf(note);
}

/**
 * Key-aware spelled transposition:
 *  1. If the target pc is diatonic in the context, its diatonic spelling wins
 *     (§3.14 step 5: spelling is rewritten for the new key).
 *  2. Otherwise Tonal interval spelling keeps letter motion natural
 *     (e.g. B + m2 -> C, F# + M2 -> G#) rather than blindly applying bias.
 *  3. If that result leaves the double-accidental range, fall back to the
 *     contextual accidental-bias spelling.
 */
export function transposeSpelledPitchClass(
  note: SpelledPitchClass,
  semitones: number,
  context: HarmonyContext,
): SpelledPitchClass {
  const targetPc = (((pitchClassOf(note) + semitones) % 12) + 12) % 12;
  for (const degree of modeScaleDegrees(context)) {
    if (degree.pc === targetPc) {
      return { letter: degree.letter, accidental: degree.accidental };
    }
  }
  const interval = INTERVAL_BY_SEMITONES[((semitones % 12) + 12) % 12] ?? '1P';
  const transposed = Note.transpose(spelledName(note), interval);
  const parsed = parseSpelled(transposed);
  if (
    parsed &&
    Math.abs(parsed.accidental) <= 2 &&
    pitchClassOf(parsed) === targetPc
  ) {
    return parsed;
  }
  return spellPitchClassInContext(targetPc, context);
}

/** The seven ascending pitch classes of the context mode, starting at the tonic. */
export function modePitchClasses(context: HarmonyContext): number[] {
  const intervals = getModeProfile(context.mode).intervals;
  const tonicPc = pitchClassOf(context.tonic);
  return intervals.map((interval) => (tonicPc + interval) % 12);
}

/** Spelled diatonic degrees of the context mode, tonic first. */
export function modeScaleLetters(context: HarmonyContext): SpelledPitchClass[] {
  return modeScaleDegrees(context).map(({ letter, accidental }) => ({
    letter,
    accidental,
  }));
}

/** Re-exported for convenience so callers need no second import path. */
export { keyAccidentalBias };
