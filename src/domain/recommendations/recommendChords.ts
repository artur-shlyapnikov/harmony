/**
 * Chord recommendation pipeline (§3.12 Recommendation engine).
 *
 * Pipeline: candidate pool → per-candidate component scoring (transition,
 * melody compatibility, voice leading, key fit, next chord, repetition
 * penalty) → deterministic total sort → unique category cards
 * (safe / smooth / strong / color; strong is limited to functional/cadential
 * profiles and color omitted when nothing qualifies).
 *
 * Reasons are derived from the two most significant weighted components via
 * fixed Russian strings (§3.12 Объяснения); at most two reasons, never empty.
 *
 * Pure, synchronous, deterministic.
 */

import { type ChordSpec } from '@domain/model/chord';
import {
  pitchClassOf,
  spelledName,
} from '@domain/model/pitch';
import { spellPitchClassInContext } from '@domain/theory/spelling';
import {
  DEFAULT_VOICING_PROFILE,
  type HarmonyContext,
} from '@domain/model/project';
import { MODE_PROFILES } from '@domain/theory/modeProfiles';
import {
  analyzeChordInContext,
  type RomanNumeralAnalysis,
} from '@domain/theory/romanNumerals';
import { type ResolvedVoicing } from '@domain/voicing/resolveProgression';
import { buildCandidatePool } from './candidatePool';
import {
  melodySpanGroupsForCandidate,
  scoreMelodyCompatibility,
} from './melodyScore';
import {
  computeRepetitionPenalty,
  computeTotal,
  diatonicScaleDegree,
  harmonicFunctionOf,
  scoreKeyFit,
  scoreNextChord,
  scoreTransitionFrom,
  scoreVoiceLeading,
  stackedDiatonicDegrees,
  WEIGHTS,
  type ChordRecommendation,
  type RecommendationRequest,
  type ScoreBreakdown,
} from './scoring';

// Public contract surface of the recommendation pipeline (§3.12): state and
// features import these types ONLY from this module.
export type {
  ChordRecommendation,
  RecommendationRequest,
  ScoreBreakdown,
} from './scoring';

// ---------------------------------------------------------------------------
// Reason strings (§3.12 Объяснения)
// ---------------------------------------------------------------------------

const REASON_COMMON_TONES = 'Общие ноты с предыдущим аккордом';
const REASON_TONIC_START = 'Тоника — уверенная гармоническая опора в начале';
const REASON_SMOOTH_TRANSITION = 'Плавный функциональный переход от предыдущего аккорда';
const REASON_STRONG_RESOLUTION = 'Сильное разрешение в следующий аккорд';
const REASON_FALLBACK = 'Гармонично дополняет текущий контекст';

/** Russian instrumental case of the interval label for melody reasons. */
const DEGREE_LABEL_RU: Record<string, string> = Object.freeze({
  '3rd': 'терцией',
  '5th': 'квинтой',
  '7th': 'септимой',
  '9th': 'ноной',
});

const ROMAN_UPPER: readonly string[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const MODE_ADJECTIVE_RU: Record<string, string> = Object.freeze({
  dorian: 'дорийскую',
  phrygian: 'фригийскую',
  lydian: 'лидийскую',
  mixolydian: 'миксолидийскую',
  locrian: 'локрийскую',
});

/** Cased roman numeral ("V", "vi") for a diatonic scale degree in context. */
function casedNumeral(context: HarmonyContext, degree: number): string {
  const intervals = MODE_PROFILES[context.mode].intervals;
  const base = degree - 1;
  const at = (k: number): number =>
    intervals[(base + k) % 7]! + 12 * Math.floor((base + k) / 7);
  const minorThird = ((at(2) - at(0) + 120) % 12) === 3;
  const numeral = ROMAN_UPPER[degree - 1] ?? '?';
  return minorThird ? numeral.toLowerCase() : numeral;
}

// ---------------------------------------------------------------------------
// Internal scored entry
// ---------------------------------------------------------------------------

type ScoredCandidate = {
  chord: ChordSpec;
  analysis: RomanNumeralAnalysis;
  breakdown: ScoreBreakdown;
  total: number;
  rootDegree: number | null;
};

/**
 * The chord-tone hit backing the §3.12 melody reason: the earliest
 * chord-tone span within the target range together with its OWN source
 * note, so the reason's note name always matches the span's interval
 * label. Deterministic: earliest span start wins; equal starts keep
 * melody-note order (spans are visited in request.melodyNotes order).
 */
function firstChordToneHit(
  chord: ChordSpec,
  request: RecommendationRequest,
): { label: string; noteMidi: number } | null {
  const startTick = request.targetRange.startTick;
  const endTick = startTick + request.targetRange.durationTicks;
  let best: { label: string; noteMidi: number; fromTick: number } | null = null;
  for (const group of melodySpanGroupsForCandidate(chord, request)) {
    for (const span of group.spans) {
      if (
        span.classification !== 'chordTone' ||
        span.label === undefined ||
        span.toTick <= startTick ||
        span.fromTick >= endTick
      ) {
        continue;
      }
      if (best === null || span.fromTick < best.fromTick) {
        best = {
          label: span.label,
          noteMidi: group.note.midi,
          fromTick: span.fromTick,
        };
      }
    }
  }
  return best === null ? null : { label: best.label, noteMidi: best.noteMidi };
}

/** keyFit-driven reason: secondary dominant or modal characteristic degree. */
function keyFitReason(
  entry: ScoredCandidate,
  request: RecommendationRequest,
): string | null {
  if (entry.analysis.relation === 'secondaryDominant') {
    const targetRootPc = (pitchClassOf(entry.chord.root) + 5) % 12;
    const stack = stackedDiatonicDegrees(request.context).find(
      (candidate) => candidate.rootPc === targetRootPc,
    );
    return stack !== undefined
      ? `Вторичная доминанта к ${casedNumeral(request.context, stack.degree)}`
      : null;
  }

  const modeAdjective = MODE_ADJECTIVE_RU[request.context.mode];
  if (
    modeAdjective !== undefined &&
    entry.rootDegree !== null &&
    MODE_PROFILES[request.context.mode].characteristicDegrees.includes(
      entry.rootDegree,
    )
  ) {
    return `Подчеркивает ${modeAdjective} ${ROMAN_UPPER[entry.rootDegree - 1] ?? '?'} ступень`;
  }

  return null;
}

/**
 * Builds the reason list: walks the components by descending |weighted
 * contribution| and maps each to its fixed Russian string until two distinct
 * reasons are collected; falls back to the generic sentence when none map.
 */
function buildReasons(
  entry: ScoredCandidate,
  request: RecommendationRequest,
): string[] {
  const b = entry.breakdown;
  const contributions: Array<[keyof typeof WEIGHTS, number]> = [
    ['melody', WEIGHTS.melody * Math.abs(b.melody)],
    ['transition', WEIGHTS.transition * Math.abs(b.transition)],
    ['voiceLeading', WEIGHTS.voiceLeading * Math.abs(b.voiceLeading)],
    ['keyFit', WEIGHTS.keyFit * Math.abs(b.keyFit)],
    ['nextChord', WEIGHTS.nextChord * Math.abs(b.nextChord)],
  ];
  contributions.sort((a, z) => z[1] - a[1]);

  const reasons: string[] = [];
  const pushReason = (reason: string | null): void => {
    if (reason !== null && !reasons.includes(reason) && reasons.length < 2) {
      reasons.push(reason);
    }
  };

      for (const [component] of contributions) {
        if (reasons.length >= 2) break;
        switch (component) {
          case 'voiceLeading':
            if (b.voiceLeading >= 0.5) pushReason(REASON_COMMON_TONES);
            break;
          case 'melody': {
            if (b.melody < 0.3) break;
            const hit = firstChordToneHit(entry.chord, request);
            if (hit === null) break;
            const ru = DEGREE_LABEL_RU[hit.label];
            if (ru === undefined) break;
            const namePc = ((hit.noteMidi % 12) + 12) % 12;
            const name = spelledName(spellPitchClassInContext(namePc, request.context));
            pushReason(`Мелодическая нота ${name} является ${ru}`);
            break;
          }
          case 'transition': {
            // §3.12: the transition component is the top contributor whenever
            // functional motion dominates (tonic-anchored start, cadence
            // arcs); give it a dedicated string instead of the fallback.
            if (b.transition < 0.7) break;
            pushReason(
              request.previousChord === undefined
                ? REASON_TONIC_START
                : REASON_SMOOTH_TRANSITION,
            );
            break;
          }
          case 'nextChord':
            if (b.nextChord >= 0.6) pushReason(REASON_STRONG_RESOLUTION);
            break;
          case 'keyFit':
            pushReason(keyFitReason(entry, request));
            break;
          default:
            break; // remaining components have no dedicated §3.12 string
        }
      }

  if (reasons.length === 0) reasons.push(REASON_FALLBACK);
  return reasons;
}

/** True when previous is dominant-function and candidate tonic-function. */
function isCadenceArc(
  previous: ChordSpec | undefined,
  candidate: ChordSpec,
  context: HarmonyContext,
): boolean {
  if (previous === undefined) return false;
  return (
    harmonicFunctionOf(previous, context) === 'dominant' &&
    harmonicFunctionOf(candidate, context) === 'tonic'
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Full recommendation run: ≤4 unique category cards ordered safe, smooth,
 * strong, color; categories never share a chord; strong is restricted to
 * functional/cadential candidates and color to borrowed/secondary ones
 * above the total threshold 0.05 — either category is omitted when no
 * candidate qualifies.
 */
export function recommendChords(
  request: RecommendationRequest,
  resolvedPrevious?: ResolvedVoicing,
): ChordRecommendation[] {
  const pool = buildCandidatePool(request);
  const profile = DEFAULT_VOICING_PROFILE;

  // Score every candidate once.
  const ranked: ScoredCandidate[] = pool.map((chord) => {
    const analysis = analyzeChordInContext(chord, request.context);
    const rootDegree = diatonicScaleDegree(chord, request.context);
    const penalty = computeRepetitionPenalty(chord, request.recentChords);
    const breakdown: ScoreBreakdown = {
      transition: scoreTransitionFrom(request.previousChord, chord, request.context),
      melody: scoreMelodyCompatibility(chord, request),
      voiceLeading: scoreVoiceLeading(resolvedPrevious, chord, profile),
      keyFit: scoreKeyFit(analysis, request.context.mode, rootDegree),
      nextChord: scoreNextChord(chord, request.nextChord, request.context),
      repetition: -penalty,
    };
    return {
      chord,
      analysis,
      breakdown,
      total: computeTotal(breakdown),
      rootDegree,
    };
  });

  // Deterministic order: total desc → roman numeral asc → template id asc.
  ranked.sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total;
    if (a.analysis.label !== b.analysis.label) {
      return a.analysis.label < b.analysis.label ? -1 : 1;
    }
    if (a.chord.templateId !== b.chord.templateId) {
      return a.chord.templateId < b.chord.templateId ? -1 : 1;
    }
    return 0;
  });

  const used = new Set<ScoredCandidate>();
  const cards: ChordRecommendation[] = [];
  const take = (
    entry: ScoredCandidate | undefined,
    category: ChordRecommendation['category'],
  ): void => {
    if (entry === undefined || used.has(entry)) return;
    used.add(entry);
    cards.push({
      chord: entry.chord,
      score: entry.total,
      category,
      romanNumeral: entry.analysis.label,
      reasons: buildReasons(entry, request),
      scoreBreakdown: entry.breakdown,
    });
  };
  const unusedIn = (entries: readonly ScoredCandidate[]): ScoredCandidate[] =>
    entries.filter((entry) => !used.has(entry));

  // Safe — best-scoring diatonic without strong melody conflict.
  take(
    ranked.find(
      (entry) =>
        entry.analysis.relation === 'diatonic' && entry.breakdown.melody > -0.3,
    ),
    'safe',
  );

  // Smooth — best voice-leading among the top half of the ranked list.
  const topHalfCount = Math.max(1, Math.ceil(ranked.length / 2));
  let smoothBest: ScoredCandidate | undefined;
  for (const entry of unusedIn(ranked.slice(0, topHalfCount))) {
    if (
      smoothBest === undefined ||
      entry.breakdown.voiceLeading > smoothBest.breakdown.voiceLeading
    ) {
      smoothBest = entry;
    }
  }
  take(smoothBest, 'smooth');

  // Strong — best functional/cadential transition (§3.12). Only candidates
  // carrying a functional profile qualify: a dominant or predominant
  // harmonic function (secondary dominants map to 'dominant' via the
  // relation fallback), or a transition component meaningfully above the
  // neutral 0.5 (cadential dominant→tonic resolutions). Omitted entirely
  // when no unused candidate qualifies — the spec forbids filling the
  // category with non-functional options.
  let strongBest: ScoredCandidate | undefined;
  for (const entry of unusedIn(ranked)) {
    const fn = harmonicFunctionOf(entry.chord, request.context);
    if (
      fn !== 'dominant' &&
      fn !== 'predominant' &&
      entry.breakdown.transition <= 0.5
    ) {
      continue;
    }
    const arc = isCadenceArc(request.previousChord, entry.chord, request.context);
    if (strongBest === undefined) {
      strongBest = entry;
      continue;
    }
    const bestArc = isCadenceArc(
      request.previousChord,
      strongBest.chord,
      request.context,
    );
    if (arc !== bestArc) {
      if (arc) strongBest = entry;
      continue;
    }
    if (entry.breakdown.transition > strongBest.breakdown.transition) {
      strongBest = entry;
    }
  }
  take(strongBest, 'strong');
  // Color — best borrowed or secondary-dominant above threshold; omitted
  // when none qualifies. Scoped to the modes whose pools actually carry
  // the borrowed/secondary-dominant catalogs (Ionian/Aeolian): parallel-mode
  // matches in modal contexts are ordinary modal colours, not §3.12 catalog
  // borrowings (keeps modal contexts free of forced Color cards).
  const colorCatalogMode =
    request.context.mode === 'ionian' || request.context.mode === 'aeolian';
  let colorBest: ScoredCandidate | undefined;
  for (const entry of unusedIn(ranked)) {
    if (entry.total <= 0.05) continue;
    if (!colorCatalogMode) break;
    const relation = entry.analysis.relation;
    if (
      relation !== 'borrowed' &&
      relation !== 'secondaryDominant'
    ) {
      continue;
    }
    if (colorBest === undefined || entry.total > colorBest.total) {
      colorBest = entry;
    }
  }
  take(colorBest, 'color');

  return cards;
}
