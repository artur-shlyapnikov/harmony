/**
 * Chord identity and template catalog (§3.5 Chord identity).
 *
 * The MVP uses a fixed canonical catalog — no free-form chord grammar.
 */

import { type SpelledPitchClass, spelledName } from './pitch';

export type ChordTemplateId =
  // Triads
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  // Sixths and sevenths
  | '6'
  | 'min6'
  | '7'
  | 'maj7'
  | 'min7'
  | 'minMaj7'
  | 'halfDim7'
  | 'dim7'
  // Added and extended
  | 'add9'
  | 'minAdd9'
  | '6add9'
  | 'min6add9'
  | '9'
  | 'maj9'
  | 'min9'
  | '11'
  | 'min11'
  | '13'
  | 'maj13'
  | 'min13'
  // Altered dominants
  | '7b9'
  | '7sharp9'
  | '7sharp11'
  | '7b13';

export type ChordToneRole =
  | 'root'
  | 'third'
  | 'suspension'
  | 'fifth'
  | 'seventh'
  | 'extension';

export type VoicingPriority = 'required' | 'preferred' | 'optional';

export type ToneDegree = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9 | 11 | 13;

export type ChordToneDefinition = {
  semitonesFromRoot: number;
  degree: ToneDegree;
  role: ChordToneRole;
  voicingPriority: VoicingPriority;
};

export type RecommendationComplexity =
  | 'basic'
  | 'seventh'
  | 'extended'
  | 'altered';

export type ChordTemplate = {
  id: ChordTemplateId;
  displaySuffix: string;
  tones: readonly ChordToneDefinition[];
  recommendationComplexity: RecommendationComplexity;
};

export type ChordSpec = {
  root: SpelledPitchClass;
  templateId: ChordTemplateId;
};

/** "F#m7" style chord symbol: root name + display suffix. */
export function chordSymbol(spec: ChordSpec): string {
  return spelledName(spec.root) + TEMPLATE_BY_ID[spec.templateId].displaySuffix;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function tone(
  degree: ToneDegree,
  semitonesFromRoot: number,
  role: ChordToneRole,
  voicingPriority: VoicingPriority,
): ChordToneDefinition {
  return { degree, semitonesFromRoot, role, voicingPriority };
}

const ROOT: ChordToneDefinition = tone(1, 0, 'root', 'required');
const FIFTH_REQ: ChordToneDefinition = tone(5, 7, 'fifth', 'required');
const FIFTH_OPT: ChordToneDefinition = tone(5, 7, 'fifth', 'optional');
const MAJOR_THIRD: ChordToneDefinition = tone(3, 4, 'third', 'required');
const MINOR_THIRD: ChordToneDefinition = tone(3, 3, 'third', 'required');
const FLAT_SEVENTH: ChordToneDefinition = tone(7, 10, 'seventh', 'required');
const MAJOR_SEVENTH: ChordToneDefinition = tone(7, 11, 'seventh', 'required');
const SIXTH: ChordToneDefinition = tone(6, 9, 'extension', 'preferred');
const NINTH: ChordToneDefinition = tone(9, 14, 'extension', 'required');
const ELEVENTH: ChordToneDefinition = tone(11, 17, 'extension', 'required');
const THIRTEENTH: ChordToneDefinition = tone(13, 21, 'extension', 'required');

export const CHORD_TEMPLATES: readonly ChordTemplate[] = Object.freeze([
  {
    id: 'maj',
    displaySuffix: '',
    tones: [ROOT, MAJOR_THIRD, FIFTH_REQ],
    recommendationComplexity: 'basic',
  },
  {
    id: 'min',
    displaySuffix: 'm',
    tones: [ROOT, MINOR_THIRD, FIFTH_REQ],
    recommendationComplexity: 'basic',
  },
  {
    id: 'dim',
    displaySuffix: 'dim',
    tones: [ROOT, MINOR_THIRD, tone(5, 6, 'fifth', 'required')],
    recommendationComplexity: 'basic',
  },
  {
    id: 'aug',
    displaySuffix: 'aug',
    tones: [ROOT, MAJOR_THIRD, tone(5, 8, 'fifth', 'required')],
    recommendationComplexity: 'basic',
  },
  {
    id: 'sus2',
    displaySuffix: 'sus2',
    tones: [ROOT, tone(2, 2, 'suspension', 'required'), FIFTH_REQ],
    recommendationComplexity: 'basic',
  },
  {
    id: 'sus4',
    displaySuffix: 'sus4',
    tones: [ROOT, tone(4, 5, 'suspension', 'required'), FIFTH_REQ],
    recommendationComplexity: 'basic',
  },
  {
    id: '6',
    displaySuffix: '6',
    tones: [ROOT, MAJOR_THIRD, FIFTH_REQ, SIXTH],
    recommendationComplexity: 'basic',
  },
  {
    id: 'min6',
    displaySuffix: 'm6',
    tones: [ROOT, MINOR_THIRD, FIFTH_REQ, SIXTH],
    recommendationComplexity: 'basic',
  },
  {
    id: '7',
    displaySuffix: '7',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, FLAT_SEVENTH],
    recommendationComplexity: 'seventh',
  },
  {
    id: 'maj7',
    displaySuffix: 'maj7',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, MAJOR_SEVENTH],
    recommendationComplexity: 'seventh',
  },
  {
    id: 'min7',
    displaySuffix: 'm7',
    tones: [ROOT, MINOR_THIRD, FIFTH_OPT, FLAT_SEVENTH],
    recommendationComplexity: 'seventh',
  },
  {
    id: 'minMaj7',
    displaySuffix: 'mMaj7',
    tones: [ROOT, MINOR_THIRD, FIFTH_OPT, MAJOR_SEVENTH],
    recommendationComplexity: 'seventh',
  },
  {
    id: 'halfDim7',
    displaySuffix: 'm7b5',
    tones: [ROOT, MINOR_THIRD, tone(5, 6, 'fifth', 'optional'), FLAT_SEVENTH],
    recommendationComplexity: 'seventh',
  },
  {
    id: 'dim7',
    displaySuffix: 'dim7',
    tones: [
      ROOT,
      MINOR_THIRD,
      tone(5, 6, 'fifth', 'optional'),
      tone(7, 9, 'seventh', 'required'),
    ],
    recommendationComplexity: 'seventh',
  },
  {
    id: 'add9',
    displaySuffix: 'add9',
    tones: [ROOT, MAJOR_THIRD, FIFTH_REQ, tone(9, 14, 'extension', 'preferred')],
    recommendationComplexity: 'extended',
  },
  {
    id: 'minAdd9',
    displaySuffix: 'm(add9)',
    tones: [ROOT, MINOR_THIRD, FIFTH_REQ, tone(9, 14, 'extension', 'preferred')],
    recommendationComplexity: 'extended',
  },
  {
    id: '6add9',
    displaySuffix: '6add9',
    tones: [ROOT, MAJOR_THIRD, FIFTH_REQ, SIXTH, tone(9, 14, 'extension', 'preferred')],
    recommendationComplexity: 'extended',
  },
  {
    id: 'min6add9',
    displaySuffix: 'm6add9',
    tones: [ROOT, MINOR_THIRD, FIFTH_REQ, SIXTH, tone(9, 14, 'extension', 'preferred')],
    recommendationComplexity: 'extended',
  },
  {
    id: '9',
    displaySuffix: '9',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, NINTH],
    recommendationComplexity: 'extended',
  },
  {
    id: 'maj9',
    displaySuffix: 'maj9',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, MAJOR_SEVENTH, NINTH],
    recommendationComplexity: 'extended',
  },
  {
    id: 'min9',
    displaySuffix: 'm9',
    tones: [ROOT, MINOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, NINTH],
    recommendationComplexity: 'extended',
  },
  {
    id: '11',
    displaySuffix: '11',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, tone(9, 14, 'extension', 'optional'), ELEVENTH],
    recommendationComplexity: 'extended',
  },
  {
    id: 'min11',
    displaySuffix: 'm11',
    tones: [ROOT, MINOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, tone(9, 14, 'extension', 'optional'), ELEVENTH],
    recommendationComplexity: 'extended',
  },
  {
    id: '13',
    displaySuffix: '13',
    tones: [
      ROOT,
      MAJOR_THIRD,
      FIFTH_OPT,
      FLAT_SEVENTH,
      tone(9, 14, 'extension', 'optional'),
      tone(11, 17, 'extension', 'optional'),
      THIRTEENTH,
    ],
    recommendationComplexity: 'extended',
  },
  {
    id: 'maj13',
    displaySuffix: 'maj13',
    tones: [
      ROOT,
      MAJOR_THIRD,
      FIFTH_OPT,
      MAJOR_SEVENTH,
      tone(9, 14, 'extension', 'optional'),
      tone(11, 17, 'extension', 'optional'),
      THIRTEENTH,
    ],
    recommendationComplexity: 'extended',
  },
  {
    id: 'min13',
    displaySuffix: 'm13',
    tones: [
      ROOT,
      MINOR_THIRD,
      FIFTH_OPT,
      FLAT_SEVENTH,
      tone(9, 14, 'extension', 'optional'),
      tone(11, 17, 'extension', 'optional'),
      THIRTEENTH,
    ],
    recommendationComplexity: 'extended',
  },
  {
    id: '7b9',
    displaySuffix: '7b9',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, tone(9, 13, 'extension', 'required')],
    recommendationComplexity: 'altered',
  },
  {
    id: '7sharp9',
    displaySuffix: '7#9',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, tone(9, 15, 'extension', 'required')],
    recommendationComplexity: 'altered',
  },
  {
    id: '7sharp11',
    displaySuffix: '7#11',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, tone(11, 18, 'extension', 'required')],
    recommendationComplexity: 'altered',
  },
  {
    id: '7b13',
    displaySuffix: '7b13',
    tones: [ROOT, MAJOR_THIRD, FIFTH_OPT, FLAT_SEVENTH, tone(13, 20, 'extension', 'required')],
    recommendationComplexity: 'altered',
  },
]);

export const TEMPLATE_BY_ID: Readonly<
  Record<ChordTemplateId, ChordTemplate>
> = Object.fromEntries(
  CHORD_TEMPLATES.map((template) => [template.id, template]),
) as Record<ChordTemplateId, ChordTemplate>;
