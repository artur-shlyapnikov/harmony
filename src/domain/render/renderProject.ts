/**
 * The single event-generation path shared by audio scheduling and MIDI
 * export: melody maps 1:1, harmony resolves through
 * `resolveProgressionVoicings` + `renderPattern`, then the combined
 * stream is clipped to document length, sorted deterministically and
 * validated as the final §3.13 stage before leaving the renderer.
 */

import type {
  PlaybackNote,
  PlaybackProject,
} from '@domain/model/playback';
import { barsToLengthTicks, type ProjectDocumentV1, type VoicingConstraints } from '@domain/model/project';
import { resolveProgressionVoicings } from '@domain/voicing/resolveProgression';
import { renderPattern } from './patternRenderer';
import { PlaybackRenderError } from './renderErrors';
import { comparePlaybackNotes, validatePlayback } from './validatePlayback';

function renderMelody(project: ProjectDocumentV1): PlaybackNote[] {
  return project.melody.notes.map((note) => ({
    track: 'melody',
    startTick: note.startTick,
    durationTicks: note.durationTicks,
    midi: note.midi,
    velocity: note.velocity,
    sourceEventId: note.id,
  }));
}

function renderHarmony(
  project: ProjectDocumentV1,
  profile: VoicingConstraints,
): PlaybackNote[] {
  const chords = project.harmony.chords;
  const resolved = resolveProgressionVoicings(chords, profile);

  const notes: PlaybackNote[] = [];
  for (let i = 0; i < chords.length; i++) {
    const voicing = resolved[i];
    if (voicing === undefined) continue;
    const chord = chords[i]!;
    const pattern = chord.patternOverride ?? project.harmony.defaultPattern;
    notes.push(...renderPattern(voicing, chord, pattern, profile));
  }
  return notes;
}

/** Truncate beyond lengthTicks; drop zero-length remainders. */
function clipToLength(
  notes: readonly PlaybackNote[],
  lengthTicks: number,
): PlaybackNote[] {
  const clipped: PlaybackNote[] = [];
  for (const note of notes) {
    if (note.startTick >= lengthTicks) continue;
    const duration = Math.min(note.durationTicks, lengthTicks - note.startTick);
    if (duration <= 0) continue;
    clipped.push(
      note.durationTicks === duration ? note : { ...note, durationTicks: duration },
    );
  }
  return clipped;
}

export function renderProject(
  project: ProjectDocumentV1,
  profile: VoicingConstraints = project.harmony.voicingProfile,
): PlaybackProject {
  const lengthTicks = barsToLengthTicks(project.timing.bars);

  const notes = clipToLength(
    [...renderMelody(project), ...renderHarmony(project, profile)],
    lengthTicks,
  );
  notes.sort(comparePlaybackNotes);

  // §3.13 final stage: guarantee the unified stream is valid before it
  // reaches the audio path or MIDI export.
  const issues = validatePlayback(notes, { lengthTicks });
  if (issues.length > 0) throw new PlaybackRenderError(issues);

  return {
    ppq: project.timing.ppq,
    bpm: project.timing.bpm,
    timeSignature: [4, 4],
    lengthTicks,
    notes,
  };
}
