import { describe, expect, it } from 'vitest';

import {
  analyzeNoteSpans,
  classifyNoteOverall,
  pcToCompoundDegree,
  TENSION_DEGREES_BY_FAMILY,
  type NoteClassification,
  type NoteHarmonySpan,
} from '@domain/theory/noteAnalysis';
import type { ChordEvent, HarmonyContext, MelodyNoteEvent } from '@domain/model/project';
import type { ChordSpec } from '@domain/model/chord';
import { parseSpelled } from '@domain/model/pitch';

// One bar = four quarter-note beats of 480 ticks (§3.10 fixture ticks).
const BEAT = 480;
const BAR = 4 * BEAT;

const IONIAN_C: HarmonyContext = {
  tonic: { letter: 'C', accidental: 0 },
  mode: 'ionian',
};

function spelled(name: string): ChordSpec['root'] {
  const parsed = parseSpelled(name);
  if (!parsed) throw new Error(`bad spelled pitch class: ${name}`);
  return parsed;
}

let idCounter = 0;
function chordEvent(
  rootName: string,
  templateId: ChordSpec['templateId'],
  startTick: number,
  durationTicks: number,
): ChordEvent {
  idCounter += 1;
  return {
    id: `chord-${idCounter}`,
    startTick,
    durationTicks,
    chord: { root: spelled(rootName), templateId },
  };
}

function melodyNote(midi: number, startTick: number, durationTicks: number): MelodyNoteEvent {
  idCounter += 1;
  return {
    id: `note-${idCounter}`,
    startTick,
    durationTicks,
    midi,
    velocity: 100,
  };
}

describe('pcToCompoundDegree', () => {
  it('maps intervals above the root to compound degrees', () => {
    expect(pcToCompoundDegree(0, 0)).toBe(1); // unison
    expect(pcToCompoundDegree(0, 4)).toBe(3); // major third
    expect(pcToCompoundDegree(0, 3)).toBe(3); // minor third
    expect(pcToCompoundDegree(0, 7)).toBe(5);
    expect(pcToCompoundDegree(0, 10)).toBe(7); // b7
    expect(pcToCompoundDegree(0, 11)).toBe(7); // maj7
    expect(pcToCompoundDegree(0, 2)).toBe(9);
    expect(pcToCompoundDegree(0, 5)).toBe(11);
    expect(pcToCompoundDegree(0, 9)).toBe(13);
  });

  it('wraps negative intervals and rejects non-degrees', () => {
    expect(pcToCompoundDegree(2, 0)).toBe(7); // a whole tone below the root reads as a major seventh
    expect(pcToCompoundDegree(0, 1)).toBeNull();
    expect(pcToCompoundDegree(0, 6)).toBeNull();
    expect(pcToCompoundDegree(0, 8)).toBeNull();
  });
});

describe('TENSION_DEGREES_BY_FAMILY', () => {
  it('keys allowed tensions by chord family', () => {
    expect(TENSION_DEGREES_BY_FAMILY.maj7).toEqual([9, 13]);
    expect(TENSION_DEGREES_BY_FAMILY.min7).toEqual([9, 11]);
    expect(TENSION_DEGREES_BY_FAMILY['7']).toEqual([9, 13]);
    expect(TENSION_DEGREES_BY_FAMILY.sus4).toEqual([9, 13]);
    expect(TENSION_DEGREES_BY_FAMILY['7b9']).toEqual([13]);
    expect(TENSION_DEGREES_BY_FAMILY['7sharp9']).toEqual([13]);
    expect(TENSION_DEGREES_BY_FAMILY['7sharp11']).toEqual([9, 13]);
    expect(TENSION_DEGREES_BY_FAMILY['7b13']).toEqual([9]);
    expect(TENSION_DEGREES_BY_FAMILY.add9).toEqual([9, 13]);
    expect(TENSION_DEGREES_BY_FAMILY.dim).toEqual([]);
    expect(TENSION_DEGREES_BY_FAMILY.dim7).toBeUndefined();
  });
});

describe('analyzeNoteSpans', () => {
  // §3.10 step 4 regression guards for the added add9 row.
  it('classifies D4 over Cadd9 as chordTone degree 9 (chord tone wins over the tension table)', () => {
    const cAdd9 = chordEvent('C', 'add9', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(62, 0, BAR), [cAdd9], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'chordTone',
      chordDegree: 9,
      label: '9th',
      chordEventId: cAdd9.id,
    });
  });

  it('classifies A4 over Cadd9 as availableTension degree 13', () => {
    const cAdd9 = chordEvent('C', 'add9', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(69, 0, BAR), [cAdd9], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'availableTension',
      chordDegree: 13,
      label: '13th',
      chordEventId: cAdd9.id,
    });
  });
  it('splits a long E4 across Cmaj7 -> Dm7 into chordTone then availableTension', () => {
    const cMaj7 = chordEvent('C', 'maj7', 0, BAR);
    const dMin7 = chordEvent('D', 'min7', BAR, BAR);
    const e4 = melodyNote(64, 0, 2 * BAR);

    const spans = analyzeNoteSpans(e4, [cMaj7, dMin7], IONIAN_C);

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      fromTick: 0,
      toTick: BAR,
      classification: 'chordTone',
      chordDegree: 3,
      label: '3rd',
      chordEventId: cMaj7.id,
    });
    expect(spans[1]).toMatchObject({
      fromTick: BAR,
      toTick: 2 * BAR,
      classification: 'availableTension',
      chordDegree: 9,
      label: '9th',
      chordEventId: dMin7.id,
    });
  });

  it('marks F#4 over Cmaj7 in C ionian as chromatic', () => {
    const cMaj7 = chordEvent('C', 'maj7', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(66, 0, BAR), [cMaj7], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.classification).toBe('chromatic');
    expect(spans[0]!.chordEventId).toBe(cMaj7.id);
  });

  it('marks A4 over G7 as availableTension "9th"', () => {
    const g7 = chordEvent('G', '7', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(69, 0, BAR), [g7], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'availableTension',
      chordDegree: 9,
      label: '9th',
      chordEventId: g7.id,
    });
  });

  it('marks F#4 over E7 in A aeolian as availableTension "9th" (non-diatonic)', () => {
    const aeolianA: HarmonyContext = {
      tonic: { letter: 'A', accidental: 0 },
      mode: 'aeolian',
    };
    const e7 = chordEvent('E', '7', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(66, 0, BAR), [e7], aeolianA);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'availableTension',
      chordDegree: 9,
      label: '9th',
      chordEventId: e7.id,
    });
  });

  it('prefers availableTension for D4 over Cmaj7 (9th AND diatonic)', () => {
    const cMaj7 = chordEvent('C', 'maj7', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(62, 0, BAR), [cMaj7], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'availableTension',
      chordDegree: 9,
      label: '9th',
    });
  });

  it('applies the no-chord rule: diatonic scaleTone, non-diatonic chromatic', () => {
    const d4 = analyzeNoteSpans(melodyNote(62, 0, BAR), [], IONIAN_C);
    expect(d4).toHaveLength(1);
    expect(d4[0]).toMatchObject({ fromTick: 0, toTick: BAR, classification: 'scaleTone' });

    const fSharp4 = analyzeNoteSpans(melodyNote(66, 0, BAR), [], IONIAN_C);
    expect(fSharp4).toHaveLength(1);
    expect(fSharp4[0]!.classification).toBe('chromatic');
  });

  it('emits exact span boundaries at chord boundary ticks', () => {
    // Note beats 2–6 crosses only Dm7's start at tick 1920.
    const cMaj7 = chordEvent('C', 'maj7', 0, BAR);
    const dMin7 = chordEvent('D', 'min7', BAR, BAR);
    const e4Long = melodyNote(64, BEAT, 5 * BEAT);

    const spans = analyzeNoteSpans(e4Long, [cMaj7, dMin7], IONIAN_C);

    expect(spans.map((s) => [s.fromTick, s.toTick])).toEqual([
      [BEAT, BAR],
      [BAR, BEAT * 6],
    ]);
    expect(spans[0]!.classification).toBe('chordTone'); // E over Cmaj7
    expect(spans[1]!.classification).toBe('availableTension'); // E over Dm7
  });

  it('keeps a note fully inside one chord as a single span', () => {
    const cMaj7 = chordEvent('C', 'maj7', 0, 2 * BAR);
    const spans = analyzeNoteSpans(melodyNote(64, BEAT, 2 * BEAT), [cMaj7], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ fromTick: BEAT, toTick: BEAT * 3, classification: 'chordTone' });
  });

  it('never emits zero-length segments when boundaries coincide with edges', () => {
    // Chord boundary exactly at note start must not split anything.
    const cMaj7 = chordEvent('C', 'maj7', 0, BAR);
    const dMin7 = chordEvent('D', 'min7', BAR, BAR);
    const e4 = melodyNote(64, BAR, BAR);

    const spans = analyzeNoteSpans(e4, [cMaj7, dMin7], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ fromTick: BAR, toTick: 2 * BAR });
  });

  it('classifies notes that overlap no chord by the no-chord rule', () => {
    const chords = [
      chordEvent('C', 'maj7', 0, 2 * BAR),
      chordEvent('G', '7', 2 * BAR, 2 * BAR),
    ];

    const d4Late = analyzeNoteSpans(melodyNote(62, 4 * BAR, BAR), chords, IONIAN_C);
    expect(d4Late).toHaveLength(1);
    expect(d4Late[0]!.classification).toBe('scaleTone');

    const fSharp4Late = analyzeNoteSpans(melodyNote(66, 4 * BAR, BAR), chords, IONIAN_C);
    expect(fSharp4Late).toHaveLength(1);
    expect(fSharp4Late[0]!.classification).toBe('chromatic');
  });

  it('covers the note contiguously with zero gaps across a 3-chord progression', () => {
    const progression = [
      chordEvent('C', 'maj7', 0, BAR),
      chordEvent('D', 'min7', BAR, BAR),
      chordEvent('G', '7', 2 * BAR, BAR),
    ];
    const c5 = melodyNote(72, 0, 3 * BAR);

    const spans = analyzeNoteSpans(c5, progression, IONIAN_C);

    expect(spans.length).toBeGreaterThanOrEqual(3);
    expect(spans[0]!.fromTick).toBe(c5.startTick);
    expect(spans[spans.length - 1]!.toTick).toBe(c5.startTick + c5.durationTicks);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.fromTick).toBe(spans[i - 1]!.toTick);
    }
    expect(spans.map((s) => s.classification)).toEqual([
      'chordTone', // C is root of Cmaj7
      'chordTone', // C is b7 of Dm7
      'scaleTone', // C over G7: the natural 11th is an avoid note (§3.10
      // step 4), so it falls through — C is diatonic in C ionian.
    ]);
  });

  it('ignores spellingOverride for classification and uses the midi pitch class', () => {
    const cMaj7 = chordEvent('C', 'maj7', 0, BAR);
    const note = { ...melodyNote(61, 0, BAR), spellingOverride: spelled('F#') };

    // 61 = C#/Db: not a chord tone, not diatonic in C ionian.
    const spans = analyzeNoteSpans(note, [cMaj7], IONIAN_C);
    expect(spans[0]!.classification).toBe('chromatic');
  });

  it('never offers the natural degree an alteration replaces (F natural over C7#11)', () => {
    // C lydian lacks F, so the unaltered 11th cannot fall back to scaleTone:
    // it clashes with the chord's #11 and must classify as chromatic.
    const lydianC: HarmonyContext = {
      tonic: { letter: 'C', accidental: 0 },
      mode: 'lydian',
    };
    const c7Sharp11 = chordEvent('C', '7sharp11', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(65, 0, BAR), [c7Sharp11], lydianC);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'chromatic',
      chordEventId: c7Sharp11.id,
    });
  });

  it('keeps the altered extension itself and untouched tensions over C7b9 usable', () => {
    const c7b9 = chordEvent('C', '7b9', 0, BAR);

    // Db is the template b9 tone: chordTone, not affected by the table.
    const db4 = analyzeNoteSpans(melodyNote(61, 0, BAR), [c7b9], IONIAN_C);
    expect(db4).toHaveLength(1);
    expect(db4[0]).toMatchObject({ classification: 'chordTone', label: 'b9' });

    // Natural 9 is replaced by b9: D falls through to scaleTone (diatonic
    // in C ionian), never availableTension.
    const d4 = analyzeNoteSpans(melodyNote(62, 0, BAR), [c7b9], IONIAN_C);
    expect(d4).toHaveLength(1);
    expect(d4[0]!.classification).toBe('scaleTone');

    // Untouched tensions stay available: A is the 13th of C7b9.
    const a4 = analyzeNoteSpans(melodyNote(69, 0, BAR), [c7b9], IONIAN_C);
    expect(a4).toHaveLength(1);
    expect(a4[0]).toMatchObject({
      classification: 'availableTension',
      chordDegree: 13,
      label: '13th',
    });

    // The natural 11th remains an avoid note on altered dominants too:
    // F is a semitone above the major third, so it falls to scaleTone.
    const f4 = analyzeNoteSpans(melodyNote(65, 0, BAR), [c7b9], IONIAN_C);
    expect(f4).toHaveLength(1);
    expect(f4[0]!.classification).toBe('scaleTone');
  });

  it('classifies F4 over C7 as scaleTone, never availableTension (§3.10 step 4)', () => {
    // The natural 11th is the canonical avoid note — a semitone above the
    // major third of any dominant chord. F is diatonic in C ionian.
    const c7 = chordEvent('C', '7', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(65, 0, BAR), [c7], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'scaleTone',
      chordEventId: c7.id,
    });
  });

  it('still admits the natural 9th over a dominant seventh', () => {
    // Dropping the 11th from the dominant rows must not over-remove:
    // D over C7 is a whole step from every chord tone.
    const c7 = chordEvent('C', '7', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(62, 0, BAR), [c7], IONIAN_C);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'availableTension',
      chordDegree: 9,
      label: '9th',
    });
  });

  it('never offers availableTension over a dim triad', () => {
    // The dim triad admits no tensions: its natural 9 sits a semitone below
    // the b3 and its natural 11 a semitone below the b5, so any pitch a
    // semitone above a chord tone falls through to scaleTone or chromatic.
    const cDim = chordEvent('C', 'dim', 0, BAR);

    const e4 = analyzeNoteSpans(melodyNote(64, 0, BAR), [cDim], IONIAN_C); // semitone above b3
    expect(e4).toHaveLength(1);
    expect(e4[0]!.classification).toBe('scaleTone');

    const db4 = analyzeNoteSpans(melodyNote(61, 0, BAR), [cDim], IONIAN_C); // semitone above root
    expect(db4).toHaveLength(1);
    expect(db4[0]!.classification).toBe('chromatic');
  });

  it('never offers availableTension over a half-diminished seventh', () => {
    // Same semitone-clash rule as dim/dim7: the natural 11 sits a semitone
    // below the b5 (F over Cm7b5), so it must fall through to scaleTone.
    const cHalfDim = chordEvent('C', 'halfDim7', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(65, 0, BAR), [cHalfDim], IONIAN_C);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.classification).toBe('scaleTone');
    expect(spans[0]!.chordEventId).toBe(cHalfDim.id);
  });

  it('never offers the natural degree an alteration replaces (D natural over C7#9)', () => {
    // C phrygian has b2 (pc 1), not D natural (pc 2), so the unaltered 9th
    // cannot fall back to scaleTone: it clashes with the chord's #9 and must
    // classify as chromatic.
    const phrygianC: HarmonyContext = {
      tonic: { letter: 'C', accidental: 0 },
      mode: 'phrygian',
    };
    const c7Sharp9 = chordEvent('C', '7sharp9', 0, BAR);
    const spans = analyzeNoteSpans(melodyNote(62, 0, BAR), [c7Sharp9], phrygianC);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      classification: 'chromatic',
      chordEventId: c7Sharp9.id,
    });
  });
});

describe('classifyNoteOverall', () => {
  it('returns unscored for empty spans', () => {
    expect(classifyNoteOverall([])).toBe('unscored');
  });

  it('applies worst-case precedence chromatic > availableTension > scaleTone > chordTone', () => {
    const span = (classification: NoteClassification): NoteHarmonySpan => ({
      fromTick: 0,
      toTick: BEAT,
      classification,
    });

    expect(classifyNoteOverall([span('chordTone'), span('chromatic')])).toBe('chromatic');
    expect(
      classifyNoteOverall([span('chordTone'), span('scaleTone'), span('availableTension')]),
    ).toBe('availableTension');
    expect(classifyNoteOverall([span('chordTone'), span('scaleTone')])).toBe('scaleTone');
    expect(classifyNoteOverall([span('chordTone')])).toBe('chordTone');
  });
});
