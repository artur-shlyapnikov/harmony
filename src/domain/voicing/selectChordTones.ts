/**
 * Chord tone selection for voicing (§3.11 Tone selection).
 *
 * Turns a ChordSpec into the ordered list of pitch classes that a voicing
 * must realize, honoring the template's voicingPriority tiers:
 *
 *  1. required tones are always kept;
 *  2. preferred tones fill remaining slots in ascending degree order;
 *  3. optional tones are used only if slots remain;
 *  4. a simple triad yields exactly three tones (no automatic root doubling —
 *     each template tone is distinct, so nothing is ever doubled here);
 *  5. a seventh chord with four voices gets root, third/suspension, fifth
 *     (optional tier fills the fourth slot), seventh;
 *  6. 9/11/13 chords keep root, third/suspension, seventh and the highest
 *     extension — their four tones are all `required` in the catalog, so the
 *     optional fifth/ninth/eleventh never get a slot.
 *
 * Pure and deterministic.
 */

import {
  type ChordSpec,
  type ChordToneRole,
  type ToneDegree,
  type VoicingPriority,
  TEMPLATE_BY_ID,
} from '@domain/model/chord';
import { pitchClassOf } from '@domain/model/pitch';

export type SelectedTone = {
  pc: number;
  role: ChordToneRole;
  degree: ToneDegree;
};

export function selectChordTones(spec: ChordSpec, maxVoices = 4): SelectedTone[] {
  const template = TEMPLATE_BY_ID[spec.templateId];
  const rootPc = pitchClassOf(spec.root);

  const byTier: Record<VoicingPriority, SelectedTone[]> = {
    required: [],
    preferred: [],
    optional: [],
  };
  for (const tone of template.tones) {
    byTier[tone.voicingPriority].push({
      pc: (rootPc + tone.semitonesFromRoot) % 12,
      role: tone.role,
      degree: tone.degree,
    });
  }

  const selected = [...byTier.required];
  // §3.11 steps 2–3: preferred tones fill slots before optional ones; within
  // a tier, ascending degree order. Tier is the PRIMARY key, so an optional
  // tone can never displace a preferred one merely by having a lower degree.
  const byDegree = (a: SelectedTone, b: SelectedTone): number => a.degree - b.degree;
  const fillers = [...byTier.preferred].sort(byDegree).concat([...byTier.optional].sort(byDegree));
  for (const filler of fillers) {
    if (selected.length >= maxVoices) break;
    selected.push(filler);
  }

  return selected.sort((a, b) => a.degree - b.degree);
}
