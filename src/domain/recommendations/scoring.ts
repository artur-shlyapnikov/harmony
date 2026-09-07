/**
 * Recommendation scoring components and totals (§3.12).
 *
 * Single home of the recommendation contract types
 * (`RecommendationRequest`, `ChordRecommendation`) and every scoring
 * component:
 *
 *   total =
 *       0.28 × transition
 *     + 0.30 × melody
 *     + 0.20 × voiceLeading
 *     + 0.12 × keyFit
 *     + 0.10 × nextChord
 *     − repetitionPenalty
 *
 * `scoreBreakdown.repetition` stores the NEGATIVE penalty value so that
 * `total` equals the weighted sum including the repetition field.
 *
 * Every component score is normalized to [-1, 1] via `clampScore`.
 *
 * Transition scoring maps chords to scale-degree functions via local
 * stacked-diatonic matching (same stacking rule as romanNumerals: thirds
 * stacked over each scale degree, full seven-tone pc set per stack so
 * extensions still match). Chords that match no diatonic stack fall back to
 * relation-based mapping: secondary dominants act as 'dominant', everything
 * else as 'modal'.
 */

import {
  MODE_PROFILES,
  type HarmonicFunction,
  type ScaleDegree,
} from '@domain/theory/modeProfiles';

import { TEMPLATE_BY_ID, type ChordSpec } from '@domain/model/chord';
import { pitchClassOf, type ModeId } from '@domain/model/pitch';
import {
  type HarmonyContext,
  type MelodyNoteEvent,
  type Tick,
  type VoicingConstraints,
} from '@domain/model/project';
import type { RomanNumeralAnalysis } from '@domain/theory/romanNumerals';
import { analyzeChordInContext } from '@domain/theory/romanNumerals';
import { generateCandidates } from '@domain/voicing/generateCandidates';
import { type ResolvedVoicing } from '@domain/voicing/resolveProgression';
import { scoreTransition } from '@domain/voicing/scoreVoicing';
import { selectChordTones } from '@domain/voicing/selectChordTones';

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type RecommendationRequest = {
  context: HarmonyContext;
  targetRange: {
    startTick: Tick;
    durationTicks: Tick;
  };
  previousChord?: ChordSpec;
  nextChord?: ChordSpec;
  recentChords: ChordSpec[];
  melodyNotes: MelodyNoteEvent[];
  complexity: 'basic' | 'rich';
};

export type ScoreBreakdown = {
  transition: number;
  melody: number;
  voiceLeading: number;
  keyFit: number;
  nextChord: number;
  /** NEGATIVE penalty amount (−penalty) for field-name symmetry. */
  repetition: number;
};

export type ChordRecommendation = {
  chord: ChordSpec;
  score: number;
  category: 'safe' | 'smooth' | 'strong' | 'color';
  romanNumeral: string;
  reasons: string[];
  scoreBreakdown: ScoreBreakdown;
};

// ---------------------------------------------------------------------------
// Fixed total weights (§3.12 Total score)
// ---------------------------------------------------------------------------

export const WEIGHTS = Object.freeze({
  transition: 0.28,
  melody: 0.3,
  voiceLeading: 0.2,
  keyFit: 0.12,
  nextChord: 0.1,
});

/** Clamps a value into the normalized [-1, 1] range. */
export function clampScore(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/** Formula pcs of a spec as pitch classes 0..11 (used by sibling modules). */
export function specPitchClasses(spec: ChordSpec): number[] {
  const rootPc = pitchClassOf(spec.root);
  return TEMPLATE_BY_ID[spec.templateId].tones.map(
    (tone) => (((rootPc + tone.semitonesFromRoot) % 12) + 12) % 12,
  );
}

// ---------------------------------------------------------------------------
// Stacked-diatonic function mapping (transition component basis)
// ---------------------------------------------------------------------------

/** Cumulative third-step offsets; index k wraps across the octave boundary. */
const STACK_OFFSETS: readonly number[] = [0, 2, 4, 6, 8, 10, 12];

export type StackedDegree = {
  degree: ScaleDegree;
  rootPc: number;
  /** All seven stacked pcs (root..13th) of the degree. */
  pcs: readonly number[];
};

/**
 * The seven stacked diatonic degrees of the context: root pitch class plus
 * the full stacked pc set per degree (mirrors romanNumerals' buildStacks).
 */
export function stackedDiatonicDegrees(context: HarmonyContext): StackedDegree[] {
  const intervals = MODE_PROFILES[context.mode].intervals;
  const tonicPc = pitchClassOf(context.tonic);
  const stacks: StackedDegree[] = [];
  for (let d = 1; d <= 7; d += 1) {
    const base = d - 1;
    const pcs = STACK_OFFSETS.map((offset) => {
      const index = base + offset;
      return (
        (tonicPc + (intervals[index % 7] ?? 0) + 12 * Math.floor(index / 7)) % 12
      );
    });
    stacks.push({ degree: d as ScaleDegree, rootPc: pcs[0]!, pcs });
  }
  return stacks;
}

/**
 * Scale degree whose stacked pcs contain the candidate's formula pcs with a
 * matching root; null when the chord is not diatonically explainable.
 */
export function diatonicScaleDegree(
  spec: ChordSpec,
  context: HarmonyContext,
): ScaleDegree | null {
  const rootPc = pitchClassOf(spec.root);
  const specPcs = specPitchClasses(spec);
  for (const stack of stackedDiatonicDegrees(context)) {
    if (stack.rootPc !== rootPc) continue;
    if (specPcs.every((pc) => stack.pcs.includes(pc))) return stack.degree;
  }
  return null;
}

/**
 * Harmonic function of a chord in context: profile function of its diatonic
 * degree when one matches; relation-based fallback otherwise (secondary
 * dominants → 'dominant', borrowed/chromatic → 'modal').
 */
export function harmonicFunctionOf(
  spec: ChordSpec,
  context: HarmonyContext,
): HarmonicFunction {
  const degree = diatonicScaleDegree(spec, context);
  if (degree !== null) return MODE_PROFILES[context.mode].chordFunctions[degree];
  const analysis = analyzeChordInContext(spec, context);
  return analysis.relation === 'secondaryDominant' ? 'dominant' : 'modal';
}

/** Profile transition weight prevFn → candFn with the documented default. */
export function transitionWeightBetween(
  mode: HarmonyContext['mode'],
  fromFunction: HarmonicFunction,
  toFunction: HarmonicFunction,
): number {
  return MODE_PROFILES[mode].transitionWeights[fromFunction]?.[toFunction] ?? 0.2;
}

/**
 * Transition score previousChord → candidate in [-1, 1]:
 *   no previous chord → tonic-anchored start freedom over the neutral 0.5
 *     (+0.2 for tonic function, +0.15 more when the root matches the mode
 *     tonic; 0.5–0.85 total);
 *   otherwise the mode-profile weight prevFn → candFn (default 0.2) with a
 *   ×1.2 boost on dominant→tonic cadences.
 */
export function scoreTransitionFrom(
  previousChord: ChordSpec | undefined,
  candidate: ChordSpec,
  context: HarmonyContext,
): number {
  if (!previousChord) {
    let anchored = 0.5;
    if (harmonicFunctionOf(candidate, context) === 'tonic') {
      anchored += 0.2;
      if (pitchClassOf(candidate.root) === pitchClassOf(context.tonic)) {
        anchored += 0.15;
      }
    }
    return clampScore(anchored);
  }
  const prevFunction = harmonicFunctionOf(previousChord, context);
  const candFunction = harmonicFunctionOf(candidate, context);
  let weight = transitionWeightBetween(context.mode, prevFunction, candFunction);
  if (candFunction === 'tonic' && prevFunction === 'dominant') weight *= 1.2;
  return clampScore(weight);
}

// ---------------------------------------------------------------------------
// Voice-leading component
// ---------------------------------------------------------------------------

/** Strict MIDI-lexicographic ordering for deterministic tie-breaks. */
function lexLess(a: readonly number[], b: readonly number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

/**
 * Nearest-voicing transition quality of `candidate` relative to
 * `previousResolved`. Builds the candidate's voicings, picks the minimal-cost
 * one via `scoreTransition` (deterministic MIDI-lexicographic tie-break) and
 * maps cost to score in [-1, 1] via clampScore. No previous voicing → 0.
 */
export function scoreVoiceLeading(
  previousResolved: ResolvedVoicing | undefined,
  candidate: ChordSpec,
  profile: VoicingConstraints,
): number {
  if (!previousResolved) return 0;

  const tones = selectChordTones(candidate, profile.maxVoices);
  const candidates = generateCandidates(tones, profile);
  if (candidates.length === 0) return -1;

  let best = candidates[0]!;
  let bestCost = scoreTransition(best, previousResolved.midiNotes, profile);
  for (let i = 1; i < candidates.length; i += 1) {
    const voicing = candidates[i]!;
    const cost = scoreTransition(voicing, previousResolved.midiNotes, profile);
    if (
      cost < bestCost ||
      (cost === bestCost && lexLess(voicing.midiNotes, best.midiNotes))
    ) {
      bestCost = cost;
      best = voicing;
    }
  }
  return clampScore(1 - bestCost / 8);
}

// ---------------------------------------------------------------------------
// Key-fit component
// ---------------------------------------------------------------------------

/**
 * Diatonic belonging of the analyzed chord, plus modal characteristic-degree
 * and tonic-return bonuses for non-functional modes:
 *   diatonic 1.0 · secondaryDominant 0.6 · borrowed 0.2 · chromatic −0.2
 *   modal mode: +0.3 root on a characteristicDegree, +0.2 tonic-function.
 */
export function scoreKeyFit(
  analysis: RomanNumeralAnalysis,
  mode: ModeId,
  candidateRootDegree: number | null,
): number {
  const profile = MODE_PROFILES[mode];
  let score: number;
  switch (analysis.relation) {
    case 'diatonic':
      score = 1.0;
      break;
    case 'secondaryDominant':
      score = 0.6;
      break;
    case 'borrowed':
      score = 0.2;
      break;
    default:
      score = -0.2;
      break;
  }

  const modal = mode !== 'ionian' && mode !== 'aeolian';
  if (modal) {
    if (
      candidateRootDegree !== null &&
      profile.characteristicDegrees.includes(candidateRootDegree)
    ) {
      score += 0.3;
    }
    const scaleDegree = analysis.scaleDegree;
    if (
      scaleDegree !== undefined &&
      profile.chordFunctions[scaleDegree as ScaleDegree] === 'tonic'
    ) {
      score += 0.2;
    }
  }
  return clampScore(score);
}

// ---------------------------------------------------------------------------
// Next-chord component (symmetric transition)
// ---------------------------------------------------------------------------

/**
 * Transition quality candidate → nextChord using the mode's functional
 * weights, boosted ×1.2 on dominant→tonic arcs. No next chord → 0.
 */
export function scoreNextChord(
  candidate: ChordSpec,
  nextChord: ChordSpec | undefined,
  context: HarmonyContext,
): number {
  if (!nextChord) return 0;
  const candFn = harmonicFunctionOf(candidate, context);
  const nextFn = harmonicFunctionOf(nextChord, context);
  let weight = transitionWeightBetween(context.mode, candFn, nextFn);
  if (nextFn === 'tonic' && candFn === 'dominant') weight *= 1.2;
  return clampScore(weight);
}

// ---------------------------------------------------------------------------
// Repetition penalty (positive amount, subtracted in the total)
// ---------------------------------------------------------------------------

/**
 * Positive penalty for harmonic stagnation:
 *   exact chord as previous (recentChords[0]) → 0.15;
 *   else same root within the last two chords → 0.08;
 *   else 0.
 */
export function computeRepetitionPenalty(
  candidate: ChordSpec,
  recentChords: readonly ChordSpec[],
): number {
  const candidateRootPc = pitchClassOf(candidate.root);
  const previous = recentChords[0];
  if (
    previous &&
    pitchClassOf(previous.root) === candidateRootPc &&
    previous.templateId === candidate.templateId
  ) {
    return 0.15;
  }
  const sameRoot = recentChords
    .slice(0, 2)
    .some((chord) => pitchClassOf(chord.root) === candidateRootPc);
  return sameRoot ? 0.08 : 0;
}

// ---------------------------------------------------------------------------
// Total
// ---------------------------------------------------------------------------

/** Exact §3.12 combination; `breakdown.repetition` already carries −penalty. */
export function computeTotal(breakdown: ScoreBreakdown): number {
  return (
    WEIGHTS.transition * breakdown.transition +
    WEIGHTS.melody * breakdown.melody +
    WEIGHTS.voiceLeading * breakdown.voiceLeading +
    WEIGHTS.keyFit * breakdown.keyFit +
    WEIGHTS.nextChord * breakdown.nextChord +
    breakdown.repetition
  );
}
