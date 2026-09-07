/**
 * Candidate chord pool builder (§3.12 Candidate pool).
 *
 * Insertion order (dedupe key: root pitch class + template id; hard cap
 * MAX_POOL_SIZE = 32, earlier insertions win):
 *
 *   basic: seven diatonic triads + seven diatonic sevenths stacked from the
 *     mode intervals over the tonic (quality derived from stacked thirds);
 *     Aeolian additionally a major dominant V7; Ionian/Aeolian secondary
 *     dominants V/x for x ∈ {ii, iii, IV, v, vi} (root = target root + 7
 *     semitones — the dominant sits a perfect fifth ABOVE its target,
 *     matching romanNumerals' analysis direction — template '7').
 *   rich: small borrowed catalog (Ionian: iv/bVI/bVII; Aeolian: IV/V/bII),
 *     then extensions on each diatonic major/minor root — major roots:
 *     add9/9/maj9/sus2/sus4; minor roots: minAdd9/min9/sus2/sus4.
 *
 * Deviation from the §3.12 listing order: borrowed chords are inserted
 * BEFORE the rich extensions. Otherwise the extension volume of Ionian/Aeolian
 * exhausts the 32-slot cap and no borrowed chord ever survives, which would
 * make the Color category unreachable in exactly the modes that define a
 * borrowed catalog.
 *
 * Pure and deterministic.
 */

import { type ChordSpec, type ChordTemplateId } from '@domain/model/chord';
import { pitchClassOf } from '@domain/model/pitch';
import type { HarmonyContext } from '@domain/model/project';
import { getModeProfile } from '@domain/theory/modeProfiles';
import { spellPitchClassInContext } from '@domain/theory/spelling';
import type { RecommendationRequest } from './scoring';

export const MAX_POOL_SIZE = 32;

/** Stacked third/fifth/seventh semitone offsets above a degree's root. */
type StackedQuality = {
  third: number | null;
  fifth: number | null;
  seventh: number | null;
};

function stackedQuality(intervals: readonly number[], base: number): StackedQuality {
  const at = (k: number): number =>
    intervals[(base + k) % 7]! + 12 * Math.floor((base + k) / 7);
  const root = at(0);
  return {
    third: (at(2) - root + 120) % 12,
    fifth: (at(4) - root + 120) % 12,
    seventh: (at(6) - root + 120) % 12,
  };
}

function triadTemplate(q: StackedQuality): ChordTemplateId | null {
  if (q.third === 4 && q.fifth === 7) return 'maj';
  if (q.third === 3 && q.fifth === 7) return 'min';
  if (q.third === 3 && q.fifth === 6) return 'dim';
  if (q.third === 4 && q.fifth === 8) return 'aug';
  return null;
}

/**
 * Seventh-chord template for a stacked quality. The augmented-triad case has
 * no dedicated catalog entry; it deterministically maps to maj7/7 by seventh.
 */
function seventhTemplate(q: StackedQuality): ChordTemplateId {
  switch (triadTemplate(q)) {
    case 'min':
      return q.seventh === 11 ? 'minMaj7' : 'min7';
    case 'dim':
      return q.seventh === 9 ? 'dim7' : 'halfDim7';
    default:
      // maj and aug both map on seventh size; aug stacks only occur in
      // Locrian degree V (maj7 quality).
      return q.seventh === 11 ? 'maj7' : '7';
  }
}

/**
 * Builds the deterministic candidate pool for the request context and
 * complexity, diatonic-first under the MAX_POOL_SIZE cap.
 */
export function buildCandidatePool(request: RecommendationRequest): ChordSpec[] {
  const context: HarmonyContext = request.context;
  const intervals = getModeProfile(context.mode).intervals;
  const tonicPc = pitchClassOf(context.tonic);

  const pool: ChordSpec[] = [];
  const seen = new Set<string>();
  const push = (rootPc: number, templateId: ChordTemplateId): void => {
    if (pool.length >= MAX_POOL_SIZE) return;
    const pc = ((rootPc % 12) + 12) % 12;
    const key = `${pc}:${templateId}`;
    if (seen.has(key)) return;
    seen.add(key);
    pool.push({ root: spellPitchClassInContext(pc, context), templateId });
  };

  const stackedRootPc = (degree: number): number =>
    (tonicPc + intervals[(degree - 1) % 7]!) % 12;

  // 1. Diatonic triads and sevenths (insertion priority: diatonic first).
  for (let degree = 1; degree <= 7; degree += 1) {
    const quality = stackedQuality(intervals, degree - 1);
    push(stackedRootPc(degree), triadTemplate(quality)!);
    push(stackedRootPc(degree), seventhTemplate(quality));
  }

  // 2. Aeolian major dominant V7 (the natural v7 stays in the pool as well).
  if (context.mode === 'aeolian') push(stackedRootPc(5), '7');

  // 3. Secondary dominants V/x for x ∈ {ii, iii, IV, v, vi}. The dominant
  //    root sits a perfect fifth ABOVE the target (target = root + 5,
  //    matching romanNumerals' analysis direction).
  if (context.mode === 'ionian' || context.mode === 'aeolian') {
    for (let targetDegree = 2; targetDegree <= 6; targetDegree += 1) {
      push(stackedRootPc(targetDegree) + 7, '7');
    }
  }

  // 4. Borrowed chords (rich only); see module docstring for ordering.
  if (request.complexity === 'rich') {
    if (context.mode === 'ionian') {
      push(stackedRootPc(4), 'min'); // iv
      push(tonicPc + 8, 'maj'); // bVI
      push(tonicPc + 10, 'maj'); // bVII
    } else if (context.mode === 'aeolian') {
      push(tonicPc + 5, 'maj'); // IV
      push(tonicPc + 7, 'maj'); // V (major)
      push(tonicPc + 1, 'maj'); // bII
    }
  }

  // 5. Rich extensions on diatonic major/minor roots.
  if (request.complexity === 'rich') {
    for (let degree = 1; degree <= 7; degree += 1) {
      const quality = stackedQuality(intervals, degree - 1);
      const triad = triadTemplate(quality);
      const rootPc = stackedRootPc(degree);
      if (triad === 'maj') {
        push(rootPc, 'add9');
        push(rootPc, '9');
        push(rootPc, 'maj9');
        push(rootPc, 'sus2');
        push(rootPc, 'sus4');
      } else if (triad === 'min') {
        push(rootPc, 'minAdd9');
        push(rootPc, 'min9');
        push(rootPc, 'sus2');
        push(rootPc, 'sus4');
      }
    }
  }

  return pool;
}
