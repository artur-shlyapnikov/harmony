/**
 * Candidate voicing generation (§3.11 Candidate generation).
 *
 * Construction (deterministic, plan-literal): §3.11 says to "generate all
 * octave placements inside the range" for every selected tone. This module
 * takes that literally: every candidate is a strictly ascending combination
 * of octave placements — one per selected tone in stacking order — drawn
 * from ALL octave placements of each tone's pitch class inside
 * [lowMidi, highMidi]. No voice (including the bass) is anchored to a fixed
 * register, so e.g. Cmaj7 under the default profile yields candidates across
 * the whole range such as {48,52,55,59} and {52,55,59,64}.
 *
 * Every generated candidate contains all selected tones by construction
 * (the "missing required tone" rejection of §3.11 is trivially satisfied).
 *
 * Candidates are pre-sorted by |mean - centerMidi| ascending (stable) and
 * capped at MAX_CANDIDATES = 256.
 *
 * Rejected combinations:
 *  - span > maxSpanSemitones;
 *  - non-bass adjacent gap > maxUpperGapSemitones;
 *  - bass-to-next gap > maxBassGapSemitones;
 *  - duplicate pitches (excluded a fortiori by strict ascent).
 * Pure and deterministic.
 */

import type { ChordToneRole } from '@domain/model/chord';
import type { SelectedTone } from './selectChordTones';
import type { VoicingConstraints } from '@domain/model/project';

export type VoicingCandidate = {
  midiNotes: number[];
  roles: ChordToneRole[];
};

export const MAX_CANDIDATES = 256;

export function generateCandidates(
  tones: readonly SelectedTone[],
  profile: VoicingConstraints,
): VoicingCandidate[] {
  if (tones.length === 0) return [];

  const roles = tones.map((tone) => tone.role);
  const results: number[][] = [];
  const current: number[] = [];

  const extend = (toneIndex: number): void => {
    if (toneIndex === tones.length) {
      results.push([...current]);
      return;
    }
    for (const placement of octavePlacements(tones[toneIndex]!.pc, profile)) {
      if (current.length > 0) {
        const previous = current[current.length - 1]!;
        if (placement <= previous) continue;
        const gap = placement - previous;
        const limit =
          current.length === 1 ? profile.maxBassGapSemitones : profile.maxUpperGapSemitones;
        if (gap > limit) continue;
        if (placement - current[0]! > profile.maxSpanSemitones) continue;
      }
      current.push(placement);
      extend(toneIndex + 1);
      current.pop();
    }
  };

  extend(0);

  const meanOf = (notes: number[]): number =>
    notes.reduce((sum, note) => sum + note, 0) / notes.length;

  // Stable sort (Array#sort is stable in ES2019+ runtimes): ties keep
  // enumeration order.
  results.sort(
    (a, b) =>
      Math.abs(meanOf(a) - profile.centerMidi) - Math.abs(meanOf(b) - profile.centerMidi),
  );

  return results.slice(0, MAX_CANDIDATES).map((midiNotes) => ({
    midiNotes,
    roles: [...roles],
  }));
}

function octavePlacements(pc: number, profile: VoicingConstraints): number[] {
  const placements: number[] = [];
  let note = profile.lowMidi + (((pc - profile.lowMidi) % 12) + 12) % 12;
  for (; note <= profile.highMidi; note += 12) {
    placements.push(note);
  }
  return placements;
}
