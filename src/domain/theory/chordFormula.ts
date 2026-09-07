/**
 * Chord formula math (§3.10 step 2: "получить полную chord formula").
 *
 * Works on pitch classes derived from ChordSpec + the template catalog.
 * semitonesFromRoot stores the TRUE interval above the root including octaves
 * (9th = 14, 11th = 17, 13th = 21); pitch-class views fold mod 12.
 */

import {
  type ChordSpec,
  type ChordTemplateId,
  type ChordToneRole,
  type ToneDegree,
  TEMPLATE_BY_ID,
} from '../model/chord';
import { pitchClassOf } from '../model/pitch';

export type ChordTonePc = {
  pc: number;
  role: ChordToneRole;
  degree: ToneDegree;
};

/**
 * Root pc + (semitonesFromRoot mod 12) for every template tone, deduped by pc
 * (first occurrence wins; e.g. a flattened root-position tone never shadows
 * anything here because catalog tones never collide before extension folds).
 */
export function chordTonePitchClasses(spec: ChordSpec): ChordTonePc[] {
  const template = TEMPLATE_BY_ID[spec.templateId];
  const rootPc = pitchClassOf(spec.root);
  const seen = new Set<number>();
  const result: ChordTonePc[] = [];
  for (const tone of template.tones) {
    const pc = (rootPc + tone.semitonesFromRoot) % 12;
    if (seen.has(pc)) continue;
    seen.add(pc);
    result.push({ pc, role: tone.role, degree: tone.degree });
  }
  return result;
}

/** The full formula as a pitch-class set. */
export function formulaPcSet(spec: ChordSpec): Set<number> {
  return new Set(chordTonePitchClasses(spec).map((tone) => tone.pc));
}

/** Role of a pitch class in the chord, or null if it is not a chord tone. */
export function roleOfPc(spec: ChordSpec, pc: number): ChordToneRole | null {
  const normalized = ((pc % 12) + 12) % 12;
  const found = chordTonePitchClasses(spec).find((tone) => tone.pc === normalized);
  return found ? found.role : null;
}

// ---------------------------------------------------------------------------
// Degree labels ("3rd", "b7", "#11", "b9")
// ---------------------------------------------------------------------------

/** Natural (unaltered) interval above the root per degree, incl. octaves. */
const NATURAL_SEMITONES: Record<ToneDegree, number> = Object.freeze({
  1: 0,
  2: 2,
  3: 4,
  4: 5,
  5: 7,
  6: 9,
  7: 11,
  9: 14, // compound: 9 -> second octave
  11: 17, // 11 -> fourth octave
  13: 21, // 13 -> sixth octave
});

function ordinalSuffix(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

const ALTERATION_PREFIX: Record<number, string> = Object.freeze({
  [-2]: 'bb',
  [-1]: 'b',
  0: '',
  1: '#',
  2: '##',
});

/**
 * Label for a chord tone degree in the given spec.
 * Unaltered degrees render with ordinal suffix ("3rd", "9th"); altered ones
 * render as b/# prefix plus digit ("b7", "#11", "b9"). Throws when the
 * template has no such degree.
 */
export function degreeLabel(degree: ToneDegree, spec: ChordSpec): string {
  const template = TEMPLATE_BY_ID[spec.templateId];
  const tone = template.tones.find((candidate) => candidate.degree === degree);
  if (!tone) {
    throw new Error(
      `Template ${spec.templateId} has no degree ${String(degree)}`,
    );
  }
  const alteration = tone.semitonesFromRoot - NATURAL_SEMITONES[degree];
  if (alteration === 0) {
    return String(degree) + ordinalSuffix(degree);
  }
  return (ALTERATION_PREFIX[alteration] ?? '?') + String(degree);
}

/**
 * Template ids whose quality is dominant-flavored (major third + flat
 * seventh). Used by roman numeral analysis to detect secondary dominants.
 * maj7 is deliberately excluded (not dominant-flavored).
 */
export const DOMINANT_FLAVORED_TEMPLATES: readonly ChordTemplateId[] =
  Object.freeze(['7', '9', '11', '13', '7b9', '7sharp9', '7sharp11', '7b13']);
