/**
 * Chord catalog view (§3.5 Chord identity).
 *
 * RE-EXPORTS the raw template data from model/chord.ts (the single source of
 * truth — no template data is duplicated or redefined here) and adds family
 * grouping and lookup helpers.
 */

import {
  type ChordTemplate,
  type ChordTemplateId,
  CHORD_TEMPLATES as RAW_CHORD_TEMPLATES,
  TEMPLATE_BY_ID as RAW_TEMPLATE_BY_ID,
} from '../model/chord';

export const CHORD_TEMPLATES: readonly ChordTemplate[] = RAW_CHORD_TEMPLATES;
export const TEMPLATE_BY_ID = RAW_TEMPLATE_BY_ID;
export type { ChordTemplate, ChordTemplateId };

/**
 * UI family views. Primary families (basic, seventh, extended, color) cover
 * all 30 catalog ids exactly once; sus2/sus4 intentionally appear in BOTH the
 * 'basic' and 'sus' views (the sus view is an alternate lens on basic triads).
 */
export const CHORD_FAMILY_GROUPS: readonly {
  family: 'basic' | 'seventh' | 'extended' | 'sus' | 'color';
  templateIds: ChordTemplateId[];
}[] = Object.freeze([
  {
    family: 'basic',
    templateIds: ['maj', 'min', 'dim', 'aug', 'sus2', 'sus4'],
  },
  {
    family: 'seventh',
    templateIds: [
      '6',
      'min6',
      '7',
      'maj7',
      'min7',
      'minMaj7',
      'halfDim7',
      'dim7',
    ],
  },
  {
    family: 'extended',
    templateIds: [
      'add9',
      'minAdd9',
      '6add9',
      'min6add9',
      '9',
      'maj9',
      'min9',
      '11',
      'min11',
      '13',
      'maj13',
      'min13',
    ],
  },
  // Alternate view: repeats sus2/sus4 from basic by design.
  {
    family: 'sus',
    templateIds: ['sus2', 'sus4'],
  },
  {
    family: 'color',
    templateIds: ['7b9', '7sharp9', '7sharp11', '7b13'],
  },
]);

/** Looks up a template by id; throws on unknown ids. */
export function getTemplate(id: ChordTemplateId): ChordTemplate {
  const template = TEMPLATE_BY_ID[id];
  if (!template) {
    throw new Error(`Unknown chord template: ${String(id)}`);
  }
  return template;
}
