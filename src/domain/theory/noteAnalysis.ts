/**
 * Melody note harmonic analysis spans (§3.10).
 *
 * One melodic note may cross several chords, so analysis is performed over
 * time spans: the note interval is segmented at every chord boundary that
 * falls strictly inside it, and each segment is classified against the chord
 * overlapping it (chords are non-overlapping by invariant) or against the
 * mode scale alone when no chord sounds.
 *
 * `chromatic` is NOT an error state; UI consumers must not block insertion.
 */

import { type ChordTemplateId, type ToneDegree, TEMPLATE_BY_ID } from '@domain/model/chord';
import {
  type HarmonyContext,
  type ChordEvent,
  type MelodyNoteEvent,
  type Tick,
} from '@domain/model/project';
import { pitchClassOf } from '@domain/model/pitch';
import { degreeLabel, formulaPcSet } from './chordFormula';
import { modePitchClasses } from './tonalAdapter';

export type NoteClassification =
  | 'chordTone'
  | 'availableTension'
  | 'scaleTone'
  | 'chromatic'
  | 'unscored';

export type NoteHarmonySpan = {
  fromTick: Tick;
  toTick: Tick;

  classification:
    | 'chordTone'
    | 'availableTension'
    | 'scaleTone'
    | 'chromatic'
    | 'unscored';

  chordDegree?: ToneDegree;
  label?: string; // "3rd", "9th", "#11"
  /** Which chord event this span was analyzed against; absent for no-chord spans. */
  chordEventId?: string;
};

export const TENSION_DEGREES_BY_FAMILY: Record<string, readonly ToneDegree[]> = Object.freeze({
  // Major-quality
  maj: [9, 13],
  maj7: [9, 13],
  maj9: [9, 13],
  maj13: [9, 13],
  6: [9, 13],
  '6add9': [9, 13],
  add9: [9, 13],
  // Minor-quality
  min: [9, 11],
  min7: [9, 11],
  min9: [9, 11],
  min6: [9, 11],
  min6add9: [9, 11],
  minAdd9: [9, 11],
  min11: [9, 11],
  min13: [9, 11],
  minMaj7: [9, 11],
  // Dominant
  // §3.10 step 4: the natural 11 is the canonical avoid note — a semitone
  // above the major third (F over C7) — so plain and altered dominant rows
  // alike admit only the non-clashing naturals 9 and 13.
  7: [9, 13],
  9: [9, 13],
  11: [9, 13],
  13: [9, 13],
  // Altered rows drop the natural degree the alteration replaces: a natural
  // tone a semitone away from the chord's altered extension clashes with it.
  '7b9': [13],
  '7sharp9': [13],
  '7sharp11': [9, 13],
  '7b13': [9],
  // Suspended
  sus2: [9, 13],
  sus4: [9, 13],
  // Diminished / augmented
  // §3.10 step 4: fully-diminished sevenths (dim7) get no row — every natural
  // degree lies a semitone from a chord tone and clashes with it (same rule
  // as the altered-dominant rows above), so its absence is deliberate.
  // The dim triad shares that geometry: its natural 9 sits a semitone below
  // the b3 and its natural 11 a semitone below the b5, so it admits nothing.
  // halfDim7 follows the same rule: its natural 11 sits a semitone below the
  // b5 (F over Cm7b5), so it admits no tensions either — the row is empty.
  dim: [],
  halfDim7: [],
  aug: [9],
});

const COMPOUND_DEGREE_BY_INTERVAL: Record<number, ToneDegree> = Object.freeze({
  0: 1,
  2: 9,
  3: 3,
  4: 3,
  5: 11,
  7: 5,
  9: 13,
  10: 7,
  11: 7,
});

/**
 * Maps a pitch class interval above the root to its compound degree
 * (1/3/5/7/9/11/13); null when the interval matches no degree.
 */
export function pcToCompoundDegree(rootPc: number, pc: number): ToneDegree | null {
  const interval = (((pc - rootPc) % 12) + 12) % 12;
  return COMPOUND_DEGREE_BY_INTERVAL[interval] ?? null;
}

/** The template tone whose sounding pitch class equals `pc`, if any. */
function toneAtPc(
  templateId: ChordTemplateId,
  rootPc: number,
  pc: number,
): { degree: ToneDegree } | null {
  const tone = TEMPLATE_BY_ID[templateId].tones.find(
    (candidate) =>
      (((rootPc + candidate.semitonesFromRoot) % 12) + 12) % 12 === pc,
  );
  return tone ? { degree: tone.degree } : null;
}

function chordOverlapping(
  chords: readonly ChordEvent[],
  fromTick: Tick,
  toTick: Tick,
): ChordEvent | null {
  for (const chord of chords) {
    if (chord.startTick < toTick && chord.startTick + chord.durationTicks > fromTick) {
      return chord;
    }
  }
  return null;
}

/**
 * Classifies one note pitch class against a single harmonic context:
 * chord tone > available tension (per chord family tension table)
 * > scale tone > chromatic.
 */
function classifySegment(
  notePc: number,
  chord: ChordEvent | null,
  modePcs: readonly number[],
): Pick<NoteHarmonySpan, 'classification' | 'chordDegree' | 'label' | 'chordEventId'> {
  if (!chord) {
    return modePcs.includes(notePc)
      ? { classification: 'scaleTone' }
      : { classification: 'chromatic' };
  }

  const spec = chord.chord;
  const rootPc = pitchClassOf(spec.root);

  if (formulaPcSet(spec).has(notePc)) {
    // Matched degree comes from the template tone itself (not pcToCompoundDegree):
    // e.g. sus2's second is degree 2, not compound degree 9.
    const tone = toneAtPc(spec.templateId, rootPc, notePc);
    if (tone) {
      return {
        classification: 'chordTone',
        chordDegree: tone.degree,
        label: degreeLabel(tone.degree, spec),
        chordEventId: chord.id,
      };
    }
  }

  // Tension degrees (9/11/13) are unaltered in this catalog, so a plain
  // ordinal renders them ("9th"); degreeLabel would throw — templates do not
  // carry tension tones.
  const tensionDegree = pcToCompoundDegree(rootPc, notePc);
  const allowed = TENSION_DEGREES_BY_FAMILY[spec.templateId];
  if (tensionDegree !== null && allowed?.includes(tensionDegree)) {
    return {
      classification: 'availableTension',
      chordDegree: tensionDegree,
      label: `${tensionDegree}th`,
      chordEventId: chord.id,
    };
  }

  if (modePcs.includes(notePc)) {
    return { classification: 'scaleTone', chordEventId: chord.id };
  }
  return { classification: 'chromatic', chordEventId: chord.id };
}

/**
 * Segments the note interval at every chord boundary strictly inside it and
 * classifies each segment per §3.10. Spans cover the note contiguously with
 * zero gaps; zero-length segments are never emitted.
 */
export function analyzeNoteSpans(
  note: MelodyNoteEvent,
  chords: readonly ChordEvent[],
  context: HarmonyContext,
): NoteHarmonySpan[] {
  const from = note.startTick;
  const to = note.startTick + note.durationTicks;
  // spellingOverride is irrelevant for classification: use the midi pitch class.
  const notePc = (((note.midi % 12) + 12) % 12);
  const modePcs = modePitchClasses(context);

  // All chord starts and ends falling strictly inside the note, sorted, unique.
  const boundaries = [...new Set(
    chords.flatMap((chord) => {
      const start = chord.startTick;
      const end = chord.startTick + chord.durationTicks;
      const inside: Tick[] = [];
      if (start > from && start < to) inside.push(start);
      if (end > from && end < to) inside.push(end);
      return inside;
    }),
  )].sort((a, b) => a - b);

  const edges = [from, ...boundaries, to];
  const spans: NoteHarmonySpan[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const segmentFrom = edges[i]!;
    const segmentTo = edges[i + 1]!;
    if (segmentTo <= segmentFrom) continue; // zero-length segments never emitted

    const chord = chordOverlapping(chords, segmentFrom, segmentTo);
    spans.push({
      fromTick: segmentFrom,
      toTick: segmentTo,
      ...classifySegment(notePc, chord, modePcs),
    });
  }
  return spans;
}

/**
 * Worst-case summary of a note's spans for compact UI. Precedence:
 * chromatic > availableTension > scaleTone > chordTone. Empty input yields
 * 'unscored'. 'unscored' stays in the type but `analyzeNoteSpans` never
 * produces it: it is reserved for future contexts without harmony
 * interpretation (every span here always has a chord or a mode to test).
 */
export function classifyNoteOverall(spans: readonly NoteHarmonySpan[]): NoteClassification {
  const precedence: NoteClassification[] = [
    'chromatic',
    'availableTension',
    'scaleTone',
    'chordTone',
  ];
  for (const classification of precedence) {
    if (spans.some((span) => span.classification === classification)) {
      return classification;
    }
  }
  return 'unscored';
}
