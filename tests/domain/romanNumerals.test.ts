import { describe, expect, it } from 'vitest';

import type { ChordTemplateId } from '@domain/model/chord';
import type { ModeId, SpelledPitchClass } from '@domain/model/pitch';
import type { HarmonyContext } from '@domain/model/project';
import { analyzeChordInContext } from '@domain/theory/romanNumerals';

const C_IONIAN: HarmonyContext = {
  tonic: { letter: 'C', accidental: 0 },
  mode: 'ionian',
};
const D_DORIAN: HarmonyContext = {
  tonic: { letter: 'D', accidental: 0 },
  mode: 'dorian',
};

function spec(
  root: SpelledPitchClass,
  templateId: ChordTemplateId,
): { root: SpelledPitchClass; templateId: ChordTemplateId } {
  return { root, templateId };
}

describe('diatonic analysis in C ionian', () => {
  it('Cmaj7 -> Imaj7 (degree 1)', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'C', accidental: 0 }, 'maj7'),
      C_IONIAN,
    );
    expect(result).toEqual({
      label: 'Imaj7',
      scaleDegree: 1,
      isDiatonic: true,
      relation: 'diatonic',
    });
  });

  it('triad and seventh labels across all degrees', () => {
    const cases: Array<[SpelledPitchClass, ChordTemplateId, string, number]> = [
      [{ letter: 'D', accidental: 0 }, 'min7', 'ii7', 2],
      [{ letter: 'E', accidental: 0 }, 'min7', 'iii7', 3],
      [{ letter: 'F', accidental: 0 }, 'maj7', 'IVmaj7', 4],
      [{ letter: 'G', accidental: 0 }, '7', 'V7', 5],
      [{ letter: 'A', accidental: 0 }, 'min7', 'vi7', 6],
      [{ letter: 'B', accidental: 0 }, 'halfDim7', 'viiø7', 7],
    ];
    for (const [root, templateId, label, degree] of cases) {
      const result = analyzeChordInContext(spec(root, templateId), C_IONIAN);
      expect(result.label).toBe(label);
      expect(result.scaleDegree).toBe(degree);
      expect(result.isDiatonic).toBe(true);
      expect(result.relation).toBe('diatonic');
    }
  });

  it('plain triads match stacked sets too', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'G', accidental: 0 }, 'maj'),
      C_IONIAN,
    );
    expect(result.label).toBe('V');
    expect(result.relation).toBe('diatonic');
  });

  it('missing extensions are allowed by subset semantics', () => {
    // G13 without inner extensions spelled as full template still matches V stack.
    const result = analyzeChordInContext(
      spec({ letter: 'G', accidental: 0 }, '13'),
      C_IONIAN,
    );
    expect(result.label).toBe('V13');
    expect(result.relation).toBe('diatonic');
  });
});

describe('secondary dominants in C ionian', () => {
  it('A7 -> V/ii', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'A', accidental: 0 }, '7'),
      C_IONIAN,
    );
    expect(result).toEqual({
      label: 'V/ii',
      isDiatonic: false,
      relation: 'secondaryDominant',
    });
  });

  it('E7 -> V/vi', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'E', accidental: 0 }, '7'),
      C_IONIAN,
    );
    expect(result.label).toBe('V/vi');
    expect(result.relation).toBe('secondaryDominant');
  });
});

describe('borrowed chords in C ionian', () => {
  it('Bb maj -> bVII (vs aeolian stack)', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'B', accidental: -1 }, 'maj'),
      C_IONIAN,
    );
    expect(result).toEqual({
      label: 'bVII',
      isDiatonic: false,
      relation: 'borrowed',
    });
  });

  it('F min -> iv (no prefix, borrowed casing)', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'F', accidental: 0 }, 'min'),
      C_IONIAN,
    );
    expect(result.label).toBe('iv');
    expect(result.relation).toBe('borrowed');
  });
});

describe('chromatic fallback in C ionian', () => {
  it('Db aug -> bII+ with relation chromatic', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'D', accidental: -1 }, 'aug'),
      C_IONIAN,
    );
    expect(result.label).toBe('bII+');
    expect(result.isDiatonic).toBe(false);
    expect(result.relation).toBe('chromatic');
  });

  it('C aug -> chromatic fallback I+ (not a subset of any diatonic stack)', () => {
    // Corrected aug template is {C,E,G#} = [0,4,8]. It no longer subsets the
    // C-aeolian 13th stack, so it falls through to the chromatic branch.
    // Deterministic; pinned here.
    const result = analyzeChordInContext(
      spec({ letter: 'C', accidental: 0 }, 'aug'),
      C_IONIAN,
    );
    expect(result.relation).toBe('chromatic');
    expect(result.isDiatonic).toBe(false);
    expect(result.label).toBe('I+');
  });
});

describe('dominant on the tonic and leading-tone roots', () => {
  const AEOLIAN_A: HarmonyContext = {
    tonic: { letter: 'A', accidental: 0 },
    mode: 'aeolian',
  };

  it('E7-family chords in A aeolian fall back to the plain V labels, never V/i', () => {
    for (const [templateId, label] of [
      ['7', 'V7'],
      ['9', 'V9'],
      ['13', 'V13'],
      ['7b9', 'V7b9'],
    ] as const) {
      const result = analyzeChordInContext(
        spec({ letter: 'E', accidental: 0 }, templateId),
        AEOLIAN_A,
      );
      expect(result.label).toBe(label);
      expect(['borrowed', 'chromatic']).toContain(result.relation);
    }
  });

  it('G#7 in A aeolian renders the raised leading-tone dominant #V7', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'G', accidental: 1 }, '7'),
      AEOLIAN_A,
    );
    expect(result.label).toBe('#V7');
    expect(result.isDiatonic).toBe(false);
    expect(result.relation).toBe('chromatic');
  });

  it('sixth-chord suffixes are unambiguous against figured-bass inversion', () => {
    expect(
      analyzeChordInContext(spec({ letter: 'C', accidental: 0 }, '6'), C_IONIAN)
        .label,
    ).toBe('Iadd6');
    expect(
      analyzeChordInContext(spec({ letter: 'D', accidental: 0 }, 'min6'), C_IONIAN)
        .label,
    ).toBe('iiadd6');
  });
});
describe('modal analysis in D dorian', () => {
  it('Am7 -> v7 (diatonic modal degree)', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'A', accidental: 0 }, 'min7'),
      D_DORIAN,
    );
    expect(result).toEqual({
      label: 'v7',
      scaleDegree: 5,
      isDiatonic: true,
      relation: 'diatonic',
    });
  });

  it('Bdim -> vio (stacked dorian degree 6)', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'B', accidental: 0 }, 'dim'),
      D_DORIAN,
    );
    expect(result.label).toBe('vio');
    expect(result.relation).toBe('diatonic');
  });
});


describe('modal analysis in the remaining modes (§3.9)', () => {
  const ctxFor = (mode: ModeId): HarmonyContext => ({
    tonic: { letter: 'C', accidental: 0 },
    mode,
  });

  // Seven diatonic degree triads per mode: [root, triad quality, expected
  // label]. Roots follow each mode's scale spelling from the C tonic.
  const MODAL_CASES: Array<{
    mode: ModeId;
    degrees: Array<[SpelledPitchClass, ChordTemplateId, string]>;
    alteredRoot: SpelledPitchClass;
  }> = [
    {
      mode: 'phrygian',
      degrees: [
        [{ letter: 'C', accidental: 0 }, 'min', 'i'],
        [{ letter: 'D', accidental: -1 }, 'maj', 'II'],
        [{ letter: 'E', accidental: -1 }, 'maj', 'III'],
        [{ letter: 'F', accidental: 0 }, 'min', 'iv'],
        [{ letter: 'G', accidental: 0 }, 'dim', 'vo'],
        [{ letter: 'A', accidental: -1 }, 'maj', 'VI'],
        [{ letter: 'B', accidental: -1 }, 'min', 'vii'],
      ],
      alteredRoot: { letter: 'D', accidental: 0 },
    },
    {
      mode: 'lydian',
      degrees: [
        [{ letter: 'C', accidental: 0 }, 'maj', 'I'],
        [{ letter: 'D', accidental: 0 }, 'maj', 'II'],
        [{ letter: 'E', accidental: 0 }, 'min', 'iii'],
        [{ letter: 'F', accidental: 1 }, 'dim', 'ivo'],
        [{ letter: 'G', accidental: 0 }, 'maj', 'V'],
        [{ letter: 'A', accidental: 0 }, 'min', 'vi'],
        [{ letter: 'B', accidental: 0 }, 'min', 'vii'],
      ],
      alteredRoot: { letter: 'D', accidental: -1 },
    },
    {
      mode: 'mixolydian',
      degrees: [
        [{ letter: 'C', accidental: 0 }, 'maj', 'I'],
        [{ letter: 'D', accidental: 0 }, 'min', 'ii'],
        [{ letter: 'E', accidental: 0 }, 'dim', 'iiio'],
        [{ letter: 'F', accidental: 0 }, 'maj', 'IV'],
        [{ letter: 'G', accidental: 0 }, 'min', 'v'],
        [{ letter: 'A', accidental: 0 }, 'min', 'vi'],
        [{ letter: 'B', accidental: -1 }, 'maj', 'VII'],
      ],
      alteredRoot: { letter: 'F', accidental: 1 },
    },
    {
      mode: 'locrian',
      degrees: [
        [{ letter: 'C', accidental: 0 }, 'dim', 'io'],
        [{ letter: 'D', accidental: -1 }, 'maj', 'II'],
        [{ letter: 'E', accidental: -1 }, 'min', 'iii'],
        [{ letter: 'F', accidental: 0 }, 'min', 'iv'],
        [{ letter: 'G', accidental: -1 }, 'maj', 'V'],
        [{ letter: 'A', accidental: -1 }, 'maj', 'VI'],
        [{ letter: 'B', accidental: -1 }, 'min', 'vii'],
      ],
      alteredRoot: { letter: 'E', accidental: 0 },
    },
  ];

  it.each(MODAL_CASES.map((c) => [c.mode, c.degrees, c.alteredRoot] as const))(
    'in %s all seven diatonic degree triads analyze as diatonic and an out-of-scale root does not',
    (mode, degrees, alteredRoot) => {
      const context = ctxFor(mode);

      for (const [root, quality, label] of degrees) {
        const result = analyzeChordInContext(spec(root, quality), context);
        // The rot-proof structural property: every degree of the mode's own
        // scale is diatonic — including characteristic degrees like the
        // phrygian bII — without any accidental-prefix guessing.
        expect(result.relation).toBe('diatonic');
        expect(result.isDiatonic).toBe(true);
        expect(result.label).toBe(label);
      }

      // One chromatically altered root per mode stays outside the scale.
      const altered = analyzeChordInContext(spec(alteredRoot, 'maj'), context);
      expect(altered.relation).not.toBe('diatonic');
      expect(altered.isDiatonic).toBe(false);
    },
  );
});

describe('flat-key analysis in F ionian (§3.9 + §3.5 spelling separation)', () => {
  const F_IONIAN: HarmonyContext = {
    tonic: { letter: 'F', accidental: 0 },
    mode: 'ionian',
  };

  it('Bb maj is the unprefixed diatonic IV: Bb IS degree 4 of F ionian', () => {
    const result = analyzeChordInContext(
      spec({ letter: 'B', accidental: -1 }, 'maj'),
      F_IONIAN,
    );
    expect(result).toEqual({
      label: 'IV',
      scaleDegree: 4,
      isDiatonic: true,
      relation: 'diatonic',
    });
  });

  it('Eb maj spells bVII as a borrowed chord (vs the parallel F aeolian stack)', () => {
    // Verified against the implementation: the F-aeolian 13th stack on
    // degree 7 (Eb–F–G–Bb–C–Db–Eb) CONTAINS the Eb-major triad, so the
    // borrowed stage matches with prefix computed against the ionian
    // degree-7 root D (signed distance −1) → flat-prefixed bVII.
    const result = analyzeChordInContext(
      spec({ letter: 'E', accidental: -1 }, 'maj'),
      F_IONIAN,
    );
    expect(result.label).toBe('bVII');
    expect(result.isDiatonic).toBe(false);
    expect(result.relation).toBe('borrowed');
  });
});
