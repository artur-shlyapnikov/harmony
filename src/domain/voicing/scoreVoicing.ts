/**
 * Voicing scoring (§3.11 Scoring). LOWER IS BETTER.
 *
 *   score = movementCost            bass ×1.4 / inner ×1.0 / top ×1.1
 *         + largeLeapPenalty        0.8 × max(0, leap − 7)² per matched voice
 *         + bassLeapPenalty         1.2 × max(0, bassLeap − 5)²
 *         + registerDriftPenalty    0.15 × |candidateMean − centerMidi|
 *         + spacingPenalty          0.05 × max(0, maxUpperGapActual − 9)²
 *         − commonToneBonus         2.5 per zero-movement matched voice
 *         + match.unmatchedPenalty  UNMATCHED_PENALTY per unmatched voice
 *
 * spacingPenalty (pinned): `maxUpperGapActual` is the largest adjacent gap
 * among NON-bass neighbors (bass-to-next has its own movement/leap terms and
 * its own larger limit in the profile); a chord with fewer than three voices
 * incurs none.
 *
 * Unmatched voices are charged via matchVoices' UNMATCHED_PENALTY inside the
 * movement term; bassLeapPenalty applies only to a MATCHED bass voice (an
 * unmatched bass contributes no measurable leap).
 *
 * First chord (prevMidi === null): no movement/leap/common-tone terms;
 * subtract ROOT_IN_BASS_BONUS = 2.0 when the lowest role is 'root', and add
 * close-position preference CLOSE_POSITION_COST = 0.1 × max(0, span − 12).
 * Register drift and spacing penalties still apply. Ties are broken
 * MIDI-lexicographically by the caller.
 *
 * Pure and deterministic.
 */

import type { VoicingCandidate } from './generateCandidates';
import { UNMATCHED_PENALTY, matchVoices } from './matchVoices';
import type { VoicingConstraints } from '@domain/model/project';

export { UNMATCHED_PENALTY };

export const ROOT_IN_BASS_BONUS = 2.0;
export const CLOSE_POSITION_COST = 0.1;

const LARGE_LEAP_COEFFICIENT = 0.8;
const BASS_LEAP_COEFFICIENT = 1.2;
const COMMON_TONE_BONUS = 2.5;
const REGISTER_DRIFT_COEFFICIENT = 0.15;
const SPACING_COEFFICIENT = 0.05;

export function scoreTransition(
  candidate: VoicingCandidate,
  prevMidi: readonly number[] | null,
  profile: VoicingConstraints,
): number {
  const notes = candidate.midiNotes;

  // Register drift: distance of the candidate's mean from the profile center.
  let score =
    notes.length === 0
      ? 0
      : REGISTER_DRIFT_COEFFICIENT *
        Math.abs(
          notes.reduce((sum, note) => sum + note, 0) / notes.length -
            profile.centerMidi,
        );

  // Spacing: penalize upper-register gaps wider than 9 semitones. The largest
  // gap among NON-bass neighbors (index ≥ 2); fewer than three voices → none.
  let maxUpperGapActual = 0;
  for (let i = 2; i < notes.length; i++) {
    maxUpperGapActual = Math.max(maxUpperGapActual, notes[i]! - notes[i - 1]!);
  }
  score += SPACING_COEFFICIENT * Math.pow(Math.max(0, maxUpperGapActual - 9), 2);

  if (prevMidi === null) {
    if (candidate.roles[0] === 'root') {
      score -= ROOT_IN_BASS_BONUS;
    }
    const span = notes.length > 0 ? notes[notes.length - 1]! - notes[0]! : 0;
    score += CLOSE_POSITION_COST * Math.max(0, span - 12);
    return score;
  }

  const match = matchVoices(prevMidi, notes);
  const lastIndex = notes.length - 1;

  for (const pair of match.pairs) {
    // Bass voice ×1.4, top voice ×1.1, inner ×1.0 (single-voice chords count
    // as bass).
    const weight =
      pair.nextIndex === 0 ? 1.4 : pair.nextIndex === lastIndex && lastIndex > 0 ? 1.1 : 1.0;
    score += weight * pair.movement;
    score += LARGE_LEAP_COEFFICIENT * Math.pow(Math.max(0, pair.movement - 7), 2);
    if (pair.nextIndex === 0) {
      score += BASS_LEAP_COEFFICIENT * Math.pow(Math.max(0, pair.movement - 5), 2);
    }
    if (pair.movement === 0) {
      score -= COMMON_TONE_BONUS;
    }
  }
  score += match.unmatchedPenalty;

  return score;
}
