import { describe, expect, it } from 'vitest';

import type { HarmonyContext } from '@domain/model/project';
import { modeScaleDegrees } from '@domain/theory/spelling';
import {
  diatonicRowOf,
  naturalMidiOfRow,
  soundingMidiForRow,
} from '@features/editor/timelineGeometry';

const E_SHARP_IONIAN: HarmonyContext = {
  tonic: { letter: 'E', accidental: 1 },
  mode: 'ionian',
};

describe('signed-modulo fold around the octave (E# ionian)', () => {
  it('modeScaleDegrees keeps B# as the diatonic degree spelling', () => {
    const degrees = modeScaleDegrees(E_SHARP_IONIAN);
    expect(degrees.map((d) => `${d.letter}${d.accidental}`)).toEqual([
      'E1', // E#
      'F2', // F##
      'G2', // G##
      'A1', // A#
      'B1', // B#  <- raw = -11, must not wrap to out-of-range
      'C2', // C##
      'D2', // D##
    ]);
  });

  it('soundingMidiForRow on the B5 natural row sounds B#5 = midi 84', () => {
    const naturalB5 = naturalMidiOfRow(diatonicRowOf('B', 5)); // 83
    expect(naturalB5).toBe(83);
    expect(soundingMidiForRow(naturalB5, E_SHARP_IONIAN)).toBe(84);
  });

  it('fold stays correct for negative spelled pitch classes (Cb path)', () => {
    // Cb major: degree F is Fb (spelledPc = (5 + -1) % 12 → -2 in JS before
    // normalization); the F4 row (midi 65) must sound Fb4 = 64.
    const C_FLAT_MAJOR: HarmonyContext = {
      tonic: { letter: 'C', accidental: -1 },
      mode: 'ionian',
    };
    const degrees = modeScaleDegrees(C_FLAT_MAJOR);
    expect(degrees.map((d) => `${d.letter}${d.accidental}`)).toEqual([
      'C-1', // Cb
      'D-1', // Db
      'E-1', // Eb
      'F-1', // Fb
      'G-1', // Gb
      'A-1', // Ab
      'B-1', // Bb
    ]);
    const naturalF4 = naturalMidiOfRow(diatonicRowOf('F', 4)); // 65
    expect(soundingMidiForRow(naturalF4, C_FLAT_MAJOR)).toBe(64);
  });
});
