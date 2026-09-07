/**
 * Playback validation (§3.13 validate stage).
 *
 * Pure structural checks over a rendered note stream. `unsorted` is
 * reported at the index of the first note that breaks ordering relative
 * to its predecessor.
 */

import type { PlaybackNote } from '@domain/model/playback';

export type PlaybackIssue = {
  code:
    | 'midi_range'
    | 'non_positive_duration'
    | 'negative_start'
    | 'beyond_length'
    | 'unsorted'
    | 'bad_velocity';
  index: number;
};

/** Track order: harmony before melody. */
function trackRank(track: PlaybackNote['track']): number {
  return track === 'harmony' ? 0 : 1;
}

/**
 * Deterministic playback order: startTick asc, harmony-before-melody,
 * midi asc, sourceEventId asc. Exported because renderProject sorts with
 * the exact comparator validatePlayback checks.
 */
export function comparePlaybackNotes(a: PlaybackNote, b: PlaybackNote): number {
  if (a.startTick !== b.startTick) return a.startTick - b.startTick;
  const rankDiff = trackRank(a.track) - trackRank(b.track);
  if (rankDiff !== 0) return rankDiff;
  if (a.midi !== b.midi) return a.midi - b.midi;
  if (a.sourceEventId !== b.sourceEventId) {
    return a.sourceEventId < b.sourceEventId ? -1 : 1;
  }
  return 0;
}

export function validatePlayback(
  notes: readonly PlaybackNote[],
  ctx: { lengthTicks: number },
): PlaybackIssue[] {
  const issues: PlaybackIssue[] = [];

  for (let index = 0; index < notes.length; index++) {
    const note = notes[index]!;
    if (note.midi < 0 || note.midi > 127) {
      issues.push({ code: 'midi_range', index });
    }
    if (!Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) {
      issues.push({ code: 'bad_velocity', index });
    }
    if (note.durationTicks <= 0) {
      issues.push({ code: 'non_positive_duration', index });
    }
    if (note.startTick < 0) {
      issues.push({ code: 'negative_start', index });
    }
    if (note.startTick + note.durationTicks > ctx.lengthTicks) {
      issues.push({ code: 'beyond_length', index });
    }
    if (index > 0 && comparePlaybackNotes(notes[index - 1]!, note) > 0) {
      issues.push({ code: 'unsorted', index });
    }
  }

  return issues;
}
