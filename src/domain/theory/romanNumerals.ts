/**
 * Roman numeral analysis (§3.9 Roman numeral analysis).
 *
 * Pure and deterministic. Pipeline:
 *  1. Diatonic: mode-stacked 13th-chord pitch sets for degrees 1–7; a spec
 *     matches when its pcs are a subset of the stacked set AND the roots
 *     agree (missing extensions allowed by subset semantics).
 *  2. Secondary dominant: dominant-flavored template whose root a perfect
 *     fifth up lands on a diatonic major/minor target.
 *  3. Borrowed: same matching against parallel ionian/aeolian stacks.
 *  4. Chromatic: best-effort '<accidental><numeral>' from the nearest
 *     diatonic degree root (signed shortest distance; ties resolve flat).
 */

import {
  type ChordSpec,
  type ChordTemplateId,
  TEMPLATE_BY_ID,
} from '../model/chord';
import type { ModeId, SpelledPitchClass } from '../model/pitch';
import { pitchClassOf } from '../model/pitch';
import type { HarmonyContext } from '../model/project';
import { DOMINANT_FLAVORED_TEMPLATES } from './chordFormula';
import { getModeProfile } from './modeProfiles';

export type RomanNumeralRelation =
  | 'diatonic'
  | 'secondaryDominant'
  | 'borrowed'
  | 'chromatic';

export type RomanNumeralAnalysis = {
  label: string;
  scaleDegree?: number;
  isDiatonic: boolean;
  relation: RomanNumeralRelation;
};

type StackedChord = {
  degree: number;
  rootPc: number;
  pcs: Set<number>;
  /** Semitones of the stacked third/fifth above the root (triad quality). */
  third: number | null;
  fifth: number | null;
};

/**
 * Cumulative third-step offsets: scale positions d-1, d+1, d+3, ... The raw
 * index (d-1+offset) keeps advancing across the octave boundary, so offset 8
 * wraps to scale position 1 one octave up (the 9th), 10 the 11th, 12 the 13th.
 */
const STACK_OFFSETS: readonly number[] = [0, 2, 4, 6, 8, 10, 12];

const ROMAN_BASE: readonly string[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/**
 * Numeral suffix per template id. The base roman numeral already encodes
 * triad case via casing; these suffixes carry extensions and quality marks
 * ('o' dim, '+' aug, 'ø7' half-diminished seventh). minMaj7 keeps an explicit
 * 'mMaj7' because a lowercase numeral alone would read as a plain minor seventh.
 */
const NUMERAL_SUFFIX: Record<ChordTemplateId, string> = Object.freeze({
  maj: '',
  min: '',
  dim: 'o',
  aug: '+',
  sus2: 'sus2',
  sus4: 'sus4',
  '6': 'add6',
  min6: 'add6',
  '7': '7',
  maj7: 'maj7',
  min7: '7',
  minMaj7: 'mMaj7',
  halfDim7: 'ø7',
  dim7: 'o7',
  add9: 'add9',
  minAdd9: 'add9',
  '6add9': '6add9',
  min6add9: '6add9',
  '9': '9',
  maj9: 'maj9',
  min9: '9',
  '11': '11',
  min11: '11',
  '13': '13',
  maj13: 'maj13',
  min13: '13',
  '7b9': '7b9',
  '7sharp9': '7#9',
  '7sharp11': '7#11',
  '7b13': '7b13',
});

function buildStacks(context: HarmonyContext, mode: ModeId): StackedChord[] {
  const intervals = getModeProfile(mode).intervals;
  const tonicPc = pitchClassOf(context.tonic);
  const stacks: StackedChord[] = [];
  for (let d = 1; d <= 7; d++) {
    const base = d - 1;
    const pcs = new Set<number>();
    let rootPc = 0;
    let third: number | null = null;
    let fifth: number | null = null;
    for (let k = 0; k < STACK_OFFSETS.length; k++) {
      const index = base + (STACK_OFFSETS[k] ?? 0);
      const pc =
        (tonicPc + (intervals[index % 7] ?? 0) + 12 * Math.floor(index / 7)) % 12;
      pcs.add(pc);
      if (k === 0) rootPc = pc;
      // Triad quality is stored RELATIVE to the root (semitones above it).
      if (k === 1) third = (pc - rootPc + 12) % 12;
      if (k === 2) fifth = (pc - rootPc + 12) % 12;
    }
    stacks.push({ degree: d, rootPc, pcs, third, fifth });
  }
  return stacks;
}

function formulaPcs(spec: ChordSpec): number[] {
  const rootPc = pitchClassOf(spec.root);
  return (TEMPLATE_BY_ID[spec.templateId]?.tones ?? []).map(
    (tone) => (rootPc + tone.semitonesFromRoot) % 12,
  );
}

/** First stack whose root matches and whose pc set contains all spec pcs. */
function matchStack(
  spec: ChordSpec,
  stacks: StackedChord[],
): StackedChord | null {
  const rootPc = pitchClassOf(spec.root);
  const specPcs = formulaPcs(spec);
  for (const stack of stacks) {
    if (stack.rootPc !== rootPc) continue;
    let subset = true;
    for (const pc of specPcs) {
      if (!stack.pcs.has(pc)) {
        subset = false;
        break;
      }
    }
    if (subset) return stack;
  }
  return null;
}

/** Casing from triad quality: minor thirds lowercase, everything else upper. */
function casedNumeral(degree: number, third: number | null): string {
  const base = ROMAN_BASE[degree - 1] ?? '?';
  return third === 3 ? base.toLowerCase() : base;
}

function numeralFor(stack: StackedChord): string {
  return casedNumeral(stack.degree, stack.third);
}

function signedDistance(from: number, to: number): number {
  return (((to - from + 18) % 12) - 6);
}

function isMajorTriad(stack: StackedChord): boolean {
  return stack.third === 4 && stack.fifth === 7;
}

function isMinorTriad(stack: StackedChord): boolean {
  return stack.third === 3 && stack.fifth === 7;
}

/**
 * Analyzes a chord in a harmonic context. See module docstring for the
 * four-step deterministic pipeline.
 */
export function analyzeChordInContext(
  spec: ChordSpec,
  context: HarmonyContext,
): RomanNumeralAnalysis {
  const contextStacks = buildStacks(context, context.mode);

  // 1. Diatonic.
  const diatonic = matchStack(spec, contextStacks);
  if (diatonic) {
    return {
      label:
        numeralFor(diatonic) + (NUMERAL_SUFFIX[spec.templateId] ?? ''),
      scaleDegree: diatonic.degree,
      isDiatonic: true,
      relation: 'diatonic',
    };
  }

  // 2. Secondary dominant: V/x with x a diatonic major or minor chord.
  // The tonic itself is never a target: V/i would be self-referential, so an
  // E7 in A aeolian falls through to the plain dominant label instead.
  if ((DOMINANT_FLAVORED_TEMPLATES as readonly string[]).includes(spec.templateId)) {
    // V/x has its ROOT a perfect fifth ABOVE the target x, so the target
    // root lies 5 semitones (a fourth) up from the chord root.
    const targetRootPc = (pitchClassOf(spec.root) + 5) % 12;
    const target = contextStacks.find((stack) => stack.rootPc === targetRootPc);
    if (
      target &&
      target.degree !== 1 &&
      (isMajorTriad(target) || isMinorTriad(target))
    ) {
      return {
        label: `V/${numeralFor(target)}`,
        isDiatonic: false,
        relation: 'secondaryDominant',
      };
    }
  }

  // 3. Borrowed: parallel ionian / aeolian stacks (regardless of context mode).
  const borrowedModes: ModeId[] =
    context.mode === 'ionian'
      ? ['aeolian']
      : context.mode === 'aeolian'
        ? ['ionian']
        : ['ionian', 'aeolian'];
  for (const mode of borrowedModes) {
    const match = matchStack(spec, buildStacks(context, mode));
    if (match) {
      const contextDegree = contextStacks[match.degree - 1];
      const diff = signedDistance(contextDegree?.rootPc ?? 0, match.rootPc);
      const prefix = diff === 0 ? '' : diff < 0 ? 'b' : '#';
      return {
        label:
          prefix +
          numeralFor(match) +
          (NUMERAL_SUFFIX[spec.templateId] ?? ''),
        isDiatonic: false,
        relation: 'borrowed',
      };
    }
  }

  // 4a. Raised leading-tone dominant: a dominant-flavored chord whose root is
  // a semitone below the tonic (G7 in Ab, G#7 in A minor) has no diatonic
  // degree to anchor to; labeling it against the nearest degree would produce
  // a nonsensical bI. Render it as the raised leading-tone dominant instead.
  const rootPc = pitchClassOf(spec.root);
  const tonicPc = pitchClassOf(context.tonic);
  if (
    (DOMINANT_FLAVORED_TEMPLATES as readonly string[]).includes(
      spec.templateId,
    ) &&
    rootPc === (tonicPc + 11) % 12
  ) {
    return {
      label: `#V${NUMERAL_SUFFIX[spec.templateId] ?? ''}`,
      isDiatonic: false,
      relation: 'chromatic',
    };
  }

  // 4b. Chromatic: nearest diatonic degree root, flat-side on ties.
  let bestDegree = 1;
  let bestAbs = Number.POSITIVE_INFINITY;
  let bestDiff = 0;
  for (const stack of contextStacks) {
    const diff = signedDistance(stack.rootPc, rootPc);
    if (
      Math.abs(diff) < bestAbs ||
      (Math.abs(diff) === bestAbs && diff < bestDiff)
    ) {
      bestAbs = Math.abs(diff);
      bestDiff = diff;
      bestDegree = stack.degree;
    }
  }
  const prefix = bestDiff === 0 ? '' : bestDiff < 0 ? 'b' : '#';
  const base = ROMAN_BASE[bestDegree - 1] ?? '?';
  const template = TEMPLATE_BY_ID[spec.templateId];
  const thirdTone = template?.tones.find((tone) => tone.role === 'third');
  // Minor-third templates render lowercase; everything else uppercase.
  const lowered = thirdTone?.semitonesFromRoot === 3;
  const body =
    (lowered ? base.toLowerCase() : base) +
    (NUMERAL_SUFFIX[spec.templateId] ?? '');
  return {
    label: prefix + body,
    isDiatonic: false,
    relation: 'chromatic',
  };
}

/** Convenience wrapper taking root + template id directly. */
export function analyzeSpelledRootInContext(
  root: SpelledPitchClass,
  templateId: ChordTemplateId,
  context: HarmonyContext,
): RomanNumeralAnalysis {
  return analyzeChordInContext({ root, templateId }, context);
}
