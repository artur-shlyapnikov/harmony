/**
 * Progression voicing resolution (§3.11 Sequence).
 *
 * Resolves chords strictly left-to-right: each chord picks its candidate
 * minimizing scoreTransition against the previous chord's resolved voicing,
 * with deterministic tie-breaking:
 *   1. score ascending;
 *   2. midiNotes lexicographic ascending;
 *   3. candidate enumeration index.
 *
 * Zero-candidate fallback (degenerate profiles, e.g. an empty range):
 * build a close-position stack of the first three selected tones
 * (root + third + fifth whenever available) starting from the lowest root
 * placement inside [lowMidi, highMidi], stacking each next tone at its
 * minimal interval above the previous, then clipping every note into
 * [lowMidi, highMidi]. Clipping may collapse pitches in degenerate ranges;
 * the result stays deterministic and non-throwing.
 *
 * Pure and deterministic.
 */

import type { ChordToneRole } from '@domain/model/chord';
import type { ChordEvent } from '@domain/model/project';
import {
  DEFAULT_VOICING_PROFILE,
  type VoicingConstraints,
} from '@domain/model/project';
import type { SelectedTone } from './selectChordTones';
import { selectChordTones } from './selectChordTones';
import {
  type VoicingCandidate,
  generateCandidates,
} from './generateCandidates';
import { scoreTransition } from './scoreVoicing';

export type ResolvedVoicing = {
  chordEventId: string;
  midiNotes: number[];
  toneRoles: ChordToneRole[];
  score: number;
};

export function resolveProgressionVoicings(
  chords: readonly ChordEvent[],
  profile: VoicingConstraints = DEFAULT_VOICING_PROFILE,
): ResolvedVoicing[] {
  const resolved: ResolvedVoicing[] = [];
  let prevMidi: number[] | null = null;

  for (const chord of chords) {
    const tones = selectChordTones(chord.chord, profile.maxVoices);
    let candidates = generateCandidates(tones, profile);
    if (candidates.length === 0) {
      candidates = [fallbackCandidate(tones, profile)];
    }

    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < candidates.length; index++) {
      const score = scoreTransition(candidates[index]!, prevMidi, profile);
      const current = candidates[index]!;
      const best = candidates[bestIndex]!;
      const better =
        score < bestScore ||
        (score === bestScore && lexicographic(current.midiNotes, best.midiNotes) < 0);
      if (better) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const winner = candidates[bestIndex]!;
    resolved.push({
      chordEventId: chord.id,
      midiNotes: winner.midiNotes,
      toneRoles: [...winner.roles],
      score: bestScore,
    });
    prevMidi = winner.midiNotes;
  }

  return resolved;
}

function fallbackCandidate(
  tones: readonly SelectedTone[],
  profile: VoicingConstraints,
): VoicingCandidate {
  const chosen = tones.slice(0, 3);
  const midiNotes: number[] = [];

  for (let i = 0; i < chosen.length; i++) {
    const tone = chosen[i]!;
    let note: number;
    if (i === 0) {
      note = profile.lowMidi + ((((tone.pc - profile.lowMidi) % 12) + 12) % 12);
    } else {
      const previousPc = chosen[i - 1]!.pc;
      let step = ((tone.pc - previousPc) % 12 + 12) % 12;
      if (step === 0) step = 12;
      note = midiNotes[i - 1]! + step;
    }
    midiNotes.push(Math.min(profile.highMidi, Math.max(profile.lowMidi, note)));
  }

  return { midiNotes, roles: chosen.map((tone) => tone.role) };
}

/** Negative when a sorts before b, lexicographic over MIDI numbers. */
function lexicographic(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return a.length - b.length;
}
