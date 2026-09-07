import { describe, expect, it } from 'vitest';

import type { ChordTemplateId } from '@domain/model/chord';
import {
  CHORD_FAMILY_GROUPS,
  CHORD_TEMPLATES,
  TEMPLATE_BY_ID,
  getTemplate,
} from '@domain/theory/chordCatalog';
import { chordTonePitchClasses } from '@domain/theory/chordFormula';
import { pitchClassOf, type SpelledPitchClass } from '@domain/model/pitch';

/**
 * Explicit semitone fixtures for every catalog template.
 * semitonesFromRoot stores TRUE intervals above the root including octaves
 * (9th = 14, 11th = 17, 13th = 21) — asserted here verbatim, not mod 12.
 */
const EXPECTED_SEMITONES: Record<ChordTemplateId, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '6': [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  minMaj7: [0, 3, 7, 11],
  halfDim7: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  add9: [0, 4, 7, 14],
  minAdd9: [0, 3, 7, 14],
  '6add9': [0, 4, 7, 9, 14],
  min6add9: [0, 3, 7, 9, 14],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  min11: [0, 3, 7, 10, 14, 17],
  '11': [0, 4, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 17, 21],
  maj13: [0, 4, 7, 11, 14, 17, 21],
  min13: [0, 3, 7, 10, 14, 17, 21],
  '7b9': [0, 4, 7, 10, 13],
  '7sharp9': [0, 4, 7, 10, 15],
  '7sharp11': [0, 4, 7, 10, 18],
  '7b13': [0, 4, 7, 10, 20],
};

const ALL_IDS = Object.keys(EXPECTED_SEMITONES) as ChordTemplateId[];

describe('CHORD_TEMPLATES data integrity', () => {
  it('contains exactly the 30 catalog ids', () => {
    expect(CHORD_TEMPLATES).toHaveLength(30);
    expect(new Set(CHORD_TEMPLATES.map((t) => t.id))).toEqual(
      new Set(ALL_IDS),
    );
  });

  for (const id of ALL_IDS) {
    it(`fixture: ${id} semitone formula`, () => {
      const template = TEMPLATE_BY_ID[id];
      expect(template.tones.map((tone) => tone.semitonesFromRoot)).toEqual(
        EXPECTED_SEMITONES[id],
      );
    });
  }

  it('stores true compound intervals (add9 keeps semitonesFromRoot=14)', () => {
    expect(TEMPLATE_BY_ID.add9.tones.find((t) => t.degree === 9)?.semitonesFromRoot).toBe(14);
    expect(TEMPLATE_BY_ID['11'].tones.find((t) => t.degree === 11)?.semitonesFromRoot).toBe(17);
    expect(TEMPLATE_BY_ID['13'].tones.find((t) => t.degree === 13)?.semitonesFromRoot).toBe(21);
  });

  it('every voicingPriority value is one of the allowed literals', () => {
    for (const template of CHORD_TEMPLATES) {
      for (const tone of template.tones) {
        expect(['required', 'preferred', 'optional']).toContain(
          tone.voicingPriority,
        );
      }
    }
  });

  it('every tone degree is a valid ToneDegree literal', () => {
    const valid = [1, 2, 3, 4, 5, 6, 7, 9, 11, 13];
    for (const template of CHORD_TEMPLATES) {
      for (const tone of template.tones) {
        expect(valid).toContain(tone.degree);
      }
    }
  });

  it('required tones for extensions match §3.5 (13 -> required 1, 3, b7, 13)', () => {
    const requiredDegrees = (id: ChordTemplateId) =>
      TEMPLATE_BY_ID[id].tones
        .filter((tone) => tone.voicingPriority === 'required')
        .map((tone) => tone.degree)
        .sort((a, b) => a - b);
    expect(requiredDegrees('13')).toEqual([1, 3, 7, 13]);
    expect(requiredDegrees('11')).toEqual([1, 3, 7, 11]);
    expect(requiredDegrees('9')).toEqual([1, 3, 7, 9]);
    expect(requiredDegrees('maj')).toEqual([1, 3, 5]);
  });

  it('recommendationComplexity mapping is correct', () => {
    const byComplexity = (complexity: string) =>
      CHORD_TEMPLATES.filter((t) => t.recommendationComplexity === complexity).map((t) => t.id);
    expect(byComplexity('basic').sort()).toEqual(
      ['maj', 'min', 'dim', 'aug', 'sus2', 'sus4', '6', 'min6'].sort(),
    );
    expect(byComplexity('seventh').sort()).toEqual(
      ['7', 'maj7', 'min7', 'minMaj7', 'halfDim7', 'dim7'].sort(),
    );
    expect(byComplexity('altered').sort()).toEqual(
      ['7b9', '7sharp9', '7sharp11', '7b13'].sort(),
    );
    expect(byComplexity('extended')).toHaveLength(12);
  });

  it('displaySuffixes are unique so chord symbols are unambiguous', () => {
    const suffixes = CHORD_TEMPLATES.map((t) => t.displaySuffix);
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });
});

describe('CHORD_FAMILY_GROUPS', () => {
  const PRIMARY_FAMILIES = ['basic', 'seventh', 'extended', 'color'] as const;

  it('primary families cover all 30 ids exactly once', () => {
    const seen: ChordTemplateId[] = [];
    for (const family of CHORD_FAMILY_GROUPS) {
      if ((PRIMARY_FAMILIES as readonly string[]).includes(family.family)) {
        seen.push(...family.templateIds);
      }
    }
    expect(seen.sort()).toEqual([...ALL_IDS].sort());
  });

  it('sus view repeats sus2/sus4 from basic by design', () => {
    const susGroup = CHORD_FAMILY_GROUPS.find((g) => g.family === 'sus');
    expect(susGroup?.templateIds).toEqual(['sus2', 'sus4']);
    const basicGroup = CHORD_FAMILY_GROUPS.find((g) => g.family === 'basic');
    for (const id of susGroup?.templateIds ?? []) {
      expect(basicGroup?.templateIds).toContain(id);
    }
  });

  it('every referenced templateId exists in the catalog', () => {
    for (const family of CHORD_FAMILY_GROUPS) {
      for (const id of family.templateIds) {
        expect(TEMPLATE_BY_ID[id]).toBeDefined();
      }
    }
  });
});

describe('getTemplate', () => {
  it('returns the template for known ids', () => {
    expect(getTemplate('maj7').displaySuffix).toBe('maj7');
  });

  it('throws on unknown ids', () => {
    expect(() => getTemplate('power5' as ChordTemplateId)).toThrow();
  });
});

describe('catalog consistency with chordTonePitchClasses', () => {
  it('folds compound intervals to pcs mod 12 without collisions', () => {
    // Only 13 vs 11-style folds could collide; verify none do across catalog.
    for (const template of CHORD_TEMPLATES) {
      const pcs = chordTonePitchClasses({
        root: { letter: 'C', accidental: 0 },
        templateId: template.id,
      }).map((tone) => tone.pc);
      expect(new Set(pcs).size).toBe(pcs.length);
    }
  });

  it('root tone always has pc equal to the root pitch class', () => {
    const root: SpelledPitchClass = { letter: 'F', accidental: 1 };
    for (const template of CHORD_TEMPLATES) {
      const tones = chordTonePitchClasses({ root, templateId: template.id });
      expect(tones[0]?.pc).toBe(pitchClassOf(root));
      expect(tones[0]?.role).toBe('root');
    }
  });
});
