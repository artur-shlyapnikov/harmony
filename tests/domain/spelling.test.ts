import { describe, expect, it } from 'vitest';

import { parseSpelled, pitchClassOf, spelledName } from '@domain/model/pitch';
import type { HarmonyContext } from '@domain/model/project';
import {
  formatNoteNameWithOctave,
  keyAccidentalBias,
  modeScaleDegrees,
  spellMelodyMidi,
  spellPitchClassInContext,
} from '@domain/theory/spelling';

const C_IONIAN: HarmonyContext = {
  tonic: { letter: 'C', accidental: 0 },
  mode: 'ionian',
};
const F_IONIAN: HarmonyContext = {
  tonic: { letter: 'F', accidental: 0 },
  mode: 'ionian',
};
const EB_IONIAN: HarmonyContext = {
  tonic: { letter: 'E', accidental: -1 },
  mode: 'ionian',
};
const D_IONIAN: HarmonyContext = {
  tonic: { letter: 'D', accidental: 0 },
  mode: 'ionian',
};

function name(pc: number, context: HarmonyContext): string {
  return spelledName(spellPitchClassInContext(pc, context));
}

describe('spellPitchClassInContext — diatonic degrees', () => {
  it('C ionian pc 5 -> F', () => {
    expect(name(5, C_IONIAN)).toBe('F');
  });

  it('D ionian pc 6 -> F# (diatonic degree wins)', () => {
    expect(name(6, D_IONIAN)).toBe('F#');
  });

  it('Eb ionian pc 3 -> Eb', () => {
    expect(name(3, EB_IONIAN)).toBe('Eb');
  });
});

describe('spellPitchClassInContext — chromatic bias', () => {
  it('C ionian (neutral) defaults to sharp bias: pc 6 -> F#, pc 8 -> G#, pc 10 -> A#', () => {
    expect(keyAccidentalBias(C_IONIAN)).toBe('sharp');
    expect(name(6, C_IONIAN)).toBe('F#');
    // Deterministic pick per rule; asserted so any change is deliberate.
    expect(name(8, C_IONIAN)).toBe('G#');
    expect(name(10, C_IONIAN)).toBe('A#');
  });

  it('F major is flat-biased and prefers Bb side', () => {
    expect(keyAccidentalBias(F_IONIAN)).toBe('flat');
    expect(name(10, F_IONIAN)).toBe('Bb');
  });

  it('Eb major is flat-biased', () => {
    expect(keyAccidentalBias(EB_IONIAN)).toBe('flat');
    expect(name(8, EB_IONIAN)).toBe('Ab');
  });

  it('natural spellings always beat altered ones regardless of bias', () => {
    // pc 0 in F major: C natural beats B#.
    expect(name(0, F_IONIAN)).toBe('C');
  });

  it('is deterministic across repeated calls', () => {
    const first = name(6, C_IONIAN);
    for (let i = 0; i < 5; i++) {
      expect(name(6, C_IONIAN)).toBe(first);
    }
  });
});

describe('modeScaleDegrees', () => {
  it('spells the seven diatonic degrees with correct letters and pcs', () => {
    const degrees = modeScaleDegrees(D_IONIAN).map((d) => spelledName(d));
    expect(degrees).toEqual(['D', 'E', 'F#', 'G', 'A', 'B', 'C#']);
  });
});

describe('spellMelodyMidi / formatNoteNameWithOctave', () => {
  it('is octave-independent for spelling', () => {
    expect(spelledName(spellMelodyMidi(66, D_IONIAN))).toBe('F#');
    expect(spelledName(spellMelodyMidi(54, D_IONIAN))).toBe('F#');
  });

  it('formats note name with octave (octave = floor(midi/12) - 1)', () => {
    expect(formatNoteNameWithOctave(66, D_IONIAN)).toBe('F#4');
    expect(formatNoteNameWithOctave(78, D_IONIAN)).toBe('F#5');
    expect(formatNoteNameWithOctave(60, C_IONIAN)).toBe('C4');
  });
});

describe('round-trip parse/format', () => {
  const names = ['C', 'F#', 'Bb', 'G##', 'Abb', 'E'];
  for (const n of names) {
    it(`round-trips ${n}`, () => {
      const parsed = parseSpelled(n);
      expect(parsed).not.toBeNull();
      expect(spelledName(parsed!)).toBe(n);
    });
  }
});

describe('accidental range normalization (±2 cap, §3.5 hardening)', () => {
  const B_SHARP_IONIAN: HarmonyContext = {
    tonic: { letter: 'B', accidental: 1 },
    mode: 'ionian',
  };
  const F_FLAT_IONIAN: HarmonyContext = {
    tonic: { letter: 'F', accidental: -1 },
    mode: 'ionian',
  };
  const PATHOLOGICAL_IONIAN: HarmonyContext[] = [
    B_SHARP_IONIAN,
    F_FLAT_IONIAN,
    { tonic: { letter: 'C', accidental: -1 }, mode: 'ionian' }, // Cb
    { tonic: { letter: 'G', accidental: 1 }, mode: 'ionian' }, // G#
    { tonic: { letter: 'D', accidental: 1 }, mode: 'ionian' }, // D#
    { tonic: { letter: 'E', accidental: 1 }, mode: 'lydian' },
    { tonic: { letter: 'F', accidental: -1 }, mode: 'locrian' },
    { tonic: { letter: 'B', accidental: 1 }, mode: 'phrygian' },
  ];

  it('B# ionian degrees all stay within ±2; leading tone is A##', () => {
    const degrees = modeScaleDegrees(B_SHARP_IONIAN);
    for (const degree of degrees) {
      expect(Math.abs(degree.accidental)).toBeLessThanOrEqual(2);
    }
    expect(spelledName(degrees[degrees.length - 1]!)).toBe('A##');
  });

  it('Fb ionian submediant uses the conventional Db spelling', () => {
    const degrees = modeScaleDegrees(F_FLAT_IONIAN);
    expect(spelledName(degrees[5]!)).toBe('Db');
  });

  it('respelled enharmonic ties honor a sharp key bias (G## ionian)', () => {
    // G## ionian: with the corrected non-negative modulo fold its third
    // degree stays diatonic as B## (raw = -10 used to wrap out-of-range);
    // the remaining respelled tie at pc 8 honors the SHARP side (G#, not Ab).
    const G_DOUBLE_SHARP_IONIAN: HarmonyContext = {
      tonic: { letter: 'G', accidental: 2 },
      mode: 'ionian',
    };
    const degrees = modeScaleDegrees(G_DOUBLE_SHARP_IONIAN).map((d) => spelledName(d));
    expect(degrees).toEqual(['G##', 'A##', 'B##', 'C##', 'D##', 'E##', 'G#']);
  });

  it('respelled enharmonic ties honor a flat key bias (Fbb ionian)', () => {
    // Fbb ionian: in-range degrees are all flatted; its respelled degree at
    // pc 8 keeps the flat side of the tie (Ab, not G#).
    const F_DOUBLE_FLAT_IONIAN: HarmonyContext = {
      tonic: { letter: 'F', accidental: -2 },
      mode: 'ionian',
    };
    const degrees = modeScaleDegrees(F_DOUBLE_FLAT_IONIAN).map((d) => spelledName(d));
    expect(degrees).toEqual(['Fbb', 'Gbb', 'Abb', 'Ab', 'Cbb', 'Dbb', 'Ebb']);
  });

  it('pathological tonics: every degree round-trips its pitch class', () => {
    for (const context of PATHOLOGICAL_IONIAN) {
      const tonicPc = pitchClassOf(context.tonic);
      for (const degree of modeScaleDegrees(context)) {
        expect(Math.abs(degree.accidental)).toBeLessThanOrEqual(2);
        expect(pitchClassOf(degree)).toBe(degree.pc);
      }
      expect(modeScaleDegrees(context)[0]?.pc).toBe(tonicPc);
    }
  });

  it('every pitch class spells within ±2 and preserves identity in pathological contexts', () => {
    for (const context of PATHOLOGICAL_IONIAN) {
      for (let pc = 0; pc < 12; pc++) {
        const spelled = spellPitchClassInContext(pc, context);
        expect(Math.abs(spelled.accidental)).toBeLessThanOrEqual(2);
        expect(pitchClassOf(spelled)).toBe(pc);
      }
    }
  });
});
