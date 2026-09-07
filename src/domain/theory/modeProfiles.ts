/**
 * Mode profiles (§3.9 Mode profiles).
 *
 * Ionian and Aeolian carry functional harmony profiles (classical
 * tonic/predominant/dominant roles and functional transition weights).
 *
 * Dorian, Phrygian, Lydian, Mixolydian and Locrian deliberately do NOT pretend
 * to be functional: their degrees are 'modal' except the tonic, and their
 * transition weights are flat (~0.25) with a single modal->tonic
 * "tonic-return" bonus of 0.4 (§3.9 lists tonic-return bonus explicitly).
 */

import type { ModeId } from '../model/pitch';

export type ScaleDegree = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type HarmonicFunction = 'tonic' | 'predominant' | 'dominant' | 'modal';

export type ModeProfile = {
  id: ModeId;
  /** Semitone intervals from the tonic, 7 ascending entries. */
  intervals: readonly number[];
  /** Scale degrees (1-based) that distinguish this mode; [] for the reference modes. */
  characteristicDegrees: readonly number[];
  chordFunctions: Record<ScaleDegree, HarmonicFunction>;
  transitionWeights: Record<HarmonicFunction, Partial<Record<HarmonicFunction, number>>>;
};

/**
 * Functional transition weights (Ionian). Chosen once, deterministically:
 *   dominant -> tonic 1.0     (the defining cadence)
 *   predominant -> dominant 0.8
 *   tonic -> predominant 0.6
 *   tonic -> dominant 0.5
 *   modal -> tonic 0.4       (tonic-return bonus, applies whenever modal chords exist)
 *   everything else 0.2–0.3  (weak but nonzero so chains never dead-end)
 */
const IONIAN_WEIGHTS: ModeProfile['transitionWeights'] = Object.freeze({
  tonic: { tonic: 0.2, predominant: 0.6, dominant: 0.5, modal: 0.3 },
  predominant: { tonic: 0.4, predominant: 0.2, dominant: 0.8, modal: 0.3 },
  dominant: { tonic: 1.0, predominant: 0.2, dominant: 0.1, modal: 0.3 },
  modal: { tonic: 0.4, predominant: 0.3, dominant: 0.3, modal: 0.2 },
});

/**
 * Aeolian keeps the same shape but weakens the dominant (the natural minor v
 * is not a true dominant): dominant -> tonic drops to 0.6 and the modal rows
 * gain weight because VII/modal motion is idiomatic in minor.
 */
const AEOLIAN_WEIGHTS: ModeProfile['transitionWeights'] = Object.freeze({
  tonic: { tonic: 0.2, predominant: 0.6, dominant: 0.4, modal: 0.35 },
  predominant: { tonic: 0.4, predominant: 0.2, dominant: 0.6, modal: 0.35 },
  dominant: { tonic: 0.6, predominant: 0.2, dominant: 0.1, modal: 0.35 },
  modal: { tonic: 0.4, predominant: 0.3, dominant: 0.3, modal: 0.25 },
});

/**
 * Flat modal weights: every transition ≈ 0.25 (no functional hierarchy),
 * with the single documented exception modal -> tonic = 0.4 (tonic-return).
 */
function flatModalWeights(): ModeProfile['transitionWeights'] {
  const all: HarmonicFunction[] = ['tonic', 'predominant', 'dominant', 'modal'];
  const weights: ModeProfile['transitionWeights']['modal'] = {};
  for (const target of all) {
    weights[target] = target === 'tonic' ? 0.4 : 0.25;
  }
  return Object.freeze({
    tonic: { tonic: 0.25, predominant: 0.25, dominant: 0.25, modal: 0.25 },
    predominant: { tonic: 0.25, predominant: 0.25, dominant: 0.25, modal: 0.25 },
    dominant: { tonic: 0.25, predominant: 0.25, dominant: 0.25, modal: 0.25 },
    modal: Object.freeze(weights),
  });
}

const MODAL_FUNCTIONS: Record<ScaleDegree, HarmonicFunction> = Object.freeze({
  1: 'tonic',
  2: 'modal',
  3: 'modal',
  4: 'modal',
  5: 'modal',
  6: 'modal',
  7: 'modal',
});

const IONIAN_FUNCTIONS: Record<ScaleDegree, HarmonicFunction> = Object.freeze({
  1: 'tonic',
  2: 'predominant',
  3: 'tonic',
  4: 'predominant',
  5: 'dominant',
  6: 'tonic',
  7: 'dominant',
});

/** Aeolian per batch contract: v is 'modal' (minor v is not a true dominant). */
const AEOLIAN_FUNCTIONS: Record<ScaleDegree, HarmonicFunction> = Object.freeze({
  1: 'tonic',
  2: 'predominant',
  3: 'tonic',
  4: 'predominant',
  5: 'modal',
  6: 'tonic',
  7: 'modal',
});

export const MODE_PROFILES: Record<ModeId, ModeProfile> = Object.freeze({
  ionian: {
    id: 'ionian',
    intervals: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
    characteristicDegrees: Object.freeze([]),
    chordFunctions: IONIAN_FUNCTIONS,
    transitionWeights: IONIAN_WEIGHTS,
  },
  dorian: {
    id: 'dorian',
    intervals: Object.freeze([0, 2, 3, 5, 7, 9, 10]),
    characteristicDegrees: Object.freeze([6]),
    chordFunctions: MODAL_FUNCTIONS,
    transitionWeights: flatModalWeights(),
  },
  phrygian: {
    id: 'phrygian',
    intervals: Object.freeze([0, 1, 3, 5, 7, 8, 10]),
    characteristicDegrees: Object.freeze([2]),
    chordFunctions: MODAL_FUNCTIONS,
    transitionWeights: flatModalWeights(),
  },
  lydian: {
    id: 'lydian',
    intervals: Object.freeze([0, 2, 4, 6, 7, 9, 11]),
    characteristicDegrees: Object.freeze([4]),
    chordFunctions: MODAL_FUNCTIONS,
    transitionWeights: flatModalWeights(),
  },
  mixolydian: {
    id: 'mixolydian',
    intervals: Object.freeze([0, 2, 4, 5, 7, 9, 10]),
    characteristicDegrees: Object.freeze([7]),
    chordFunctions: MODAL_FUNCTIONS,
    transitionWeights: flatModalWeights(),
  },
  aeolian: {
    id: 'aeolian',
    intervals: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
    characteristicDegrees: Object.freeze([]),
    chordFunctions: AEOLIAN_FUNCTIONS,
    transitionWeights: AEOLIAN_WEIGHTS,
  },
  locrian: {
    id: 'locrian',
    intervals: Object.freeze([0, 1, 3, 5, 6, 8, 10]),
    characteristicDegrees: Object.freeze([2, 5]),
    chordFunctions: MODAL_FUNCTIONS,
    transitionWeights: flatModalWeights(),
  },
});

export function getModeProfile(mode: ModeId): ModeProfile {
  const profile = MODE_PROFILES[mode];
  if (!profile) {
    throw new Error(`Unknown mode: ${String(mode)}`);
  }
  return profile;
}
