/**
 * Melody compatibility scoring (§3.12 Melody compatibility).
 *
 * The candidate chord is analyzed as if placed at `targetRange.startTick`
 * for `targetRange.durationTicks`; every melody note intersecting that range
 * is classified via noteAnalysis spans and valued:
 *
 *   chord tone         +1.0
 *   available tension  +0.55
 *   scale non-chord    +0.15
 *   chromatic clash    −0.8
 *
 * Notes are weighted by metric position (beat 1: 1.5, beat 3: 1.25,
 * beats 2/4: 1.0, offbeat: 0.5); a note sounding exactly at the placement
 * start gets its weight multiplied by 1.2. The score is the weighted average
 * normalized against the maximum value 1.0, clamped to [-1, 1]; with no
 * overlapping notes it is 0.
 *
 * Pure and deterministic.
 */

import type { ChordSpec } from '@domain/model/chord';
import {
  type ChordEvent,
  type MelodyNoteEvent,
  type Tick,
} from '@domain/model/project';
import { TICKS_PER_BAR, TICKS_PER_BEAT } from '@domain/timeline/constants';
import {
  analyzeNoteSpans,
  type NoteClassification,
  type NoteHarmonySpan,
} from '@domain/theory/noteAnalysis';
import { clampScore, type RecommendationRequest } from './scoring';

/** Metric weight of a tick inside its 4/4 bar. */
export function metricWeight(startTick: Tick): number {
  const inBar = ((startTick % TICKS_PER_BAR) + TICKS_PER_BAR) % TICKS_PER_BAR;
  if (inBar % TICKS_PER_BEAT !== 0) return 0.5; // offbeat
  const beat = inBar / TICKS_PER_BEAT;
  if (beat === 0) return 1.5; // beat 1
  if (beat === 2) return 1.25; // beat 3
  return 1.0; // beats 2 and 4
}

const VALUE_BY_CLASSIFICATION: Record<NoteClassification, number> = Object.freeze({
  chordTone: 1.0,
  availableTension: 0.55,
  scaleTone: 0.15,
  chromatic: -0.8,
  unscored: 0,
});

const ONSET_BONUS = 1.2;
/** One melody note paired with its classification spans against the candidate. */
export type MelodySpanGroup = {
  note: MelodyNoteEvent;
  spans: NoteHarmonySpan[];
};

/**
 * Classification spans of every melody note intersecting the target range,
 * analyzed against the candidate placed at the range start, grouped by the
 * source note (order follows request.melodyNotes). Used for scoring and
 * reason derivation ("Мелодическая нота F является терцией") — pairing a
 * span with its own note keeps the reason's note name consistent with the
 * span that produced it.
 */
export function melodySpanGroupsForCandidate(
  candidate: ChordSpec,
  request: RecommendationRequest,
): MelodySpanGroup[] {
  const startTick = request.targetRange.startTick;
  const endTick = request.targetRange.startTick + request.targetRange.durationTicks;
  const syntheticChord: ChordEvent = {
    id: 'candidate-placement',
    startTick,
    durationTicks: request.targetRange.durationTicks,
    chord: candidate,
  };

  const groups: MelodySpanGroup[] = [];
  for (const note of request.melodyNotes) {
    const noteEnd = note.startTick + note.durationTicks;
    if (!(note.startTick < endTick && noteEnd > startTick)) continue;
    groups.push({
      note,
      spans: analyzeNoteSpans(note, [syntheticChord], request.context),
    });
  }
  return groups;
}


/**
 * Melody compatibility of the candidate in [-1, 1] per §3.12; 0 when no
 * melody note overlaps the target range.
 */
export function scoreMelodyCompatibility(
  candidate: ChordSpec,
  request: RecommendationRequest,
): number {
  const startTick = request.targetRange.startTick;
  const endTick = startTick + request.targetRange.durationTicks;

  let weighted = 0;
  let totalWeight = 0;

  const groups = melodySpanGroupsForCandidate(candidate, request);
  for (const { note, spans } of groups) {
    const noteEnd = note.startTick + note.durationTicks;

    let weight = metricWeight(note.startTick);
    if (note.startTick <= startTick && noteEnd > startTick) weight *= ONSET_BONUS;

    // Value comes from the span overlapping the range most (earliest wins ties).
    let bestSpan: NoteHarmonySpan | null = null;
    let bestOverlap = -1;
    for (const span of spans) {
      const overlapFrom = Math.max(span.fromTick, startTick);
      const overlapTo = Math.min(span.toTick, endTick);
      const overlap = Math.max(0, overlapTo - overlapFrom);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpan = span;
      }
    }
    if (!bestSpan || bestOverlap <= 0) continue;

    weighted += weight * VALUE_BY_CLASSIFICATION[bestSpan.classification];
    totalWeight += weight;
  }

  if (groups.length === 0 || totalWeight === 0) return 0;

  return clampScore(weighted / totalWeight);
}
