/**
 * MIDI export (§3.19).
 *
 * Consumes only the unified playback format (§3.13): the renderer has
 * already resolved voicings, applied patterns, clipped to project length
 * and sorted the stream. Export validates before writing and never
 * silently clips or drops notes.
 */

import { Midi, type Track } from '@tonejs/midi';

import type {
  PlaybackNote,
  PlaybackProject,
} from '@domain/model/playback';
import type { PlaybackIssue } from '@domain/render/validatePlayback';
import { validatePlayback } from '@domain/render/validatePlayback';

const FALLBACK_TITLE = 'untitled';

/** Export aborted because the playback stream failed §3.19 validation. */
export class MidiExportError extends Error {
  readonly issues: readonly PlaybackIssue[];

  constructor(issues: readonly PlaybackIssue[]) {
    super(
      `MIDI export rejected playback stream: ${issues
        .map((issue) => `${issue.code}@${issue.index}`)
        .join(', ')}`,
    );
    this.name = 'MidiExportError';
    this.issues = issues;
  }
}

/**
 * Filename/header-safe title: keep letters (any script), digits, space,
 * underscore and hyphen; collapse whitespace; fall back to `untitled`.
 */
export function sanitizeTitle(title: string): string {
  const stripped = title.replace(/[^\p{L}\p{N} _-]/gu, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : FALLBACK_TITLE;
}

function addNotes(midiTrack: Track, notes: readonly PlaybackNote[]): void {
  for (const note of notes) {
    midiTrack.addNote({
      midi: note.midi,
      // Tick-exact: @tonejs/midi accepts ticks/durationTicks directly, so
      // PPQ-960 positions survive without a float seconds round-trip.
      ticks: note.startTick,
      durationTicks: note.durationTicks,
      // @tonejs/midi stores velocity normalized to [0, 1]; scaling back
      // with Math.round(v * 127) reproduces the original byte exactly.
      velocity: note.velocity / 127,
    });
  }
}

/**
 * Serialize a validated PlaybackProject to a standard MIDI file:
 * PPQ from the project (960), tempo event at tick 0, 4/4 time signature,
 * raw project title as header name, Track 1 `Melody` (channel 1)
 * and Track 2 `Harmony` (channel 2), original velocities preserved.
 *
 * @throws {MidiExportError} when validation finds any issue.
 */
export function exportPlaybackProjectToMidi(
  project: PlaybackProject,
  opts?: { title?: string },
): Uint8Array {
  const issues = validatePlayback(project.notes, {
    lengthTicks: project.lengthTicks,
  });
  if (issues.length > 0) {
    throw new MidiExportError(issues);
  }

  const midi = new Midi();
  midi.header.fromJSON({
    name: opts?.title ?? '',
    ppq: project.ppq,
    tempos: [{ bpm: project.bpm, ticks: 0 }],
    timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
    keySignatures: [],
    meta: [],
  });

  const melodyTrack = midi.addTrack();
  melodyTrack.name = 'Melody';
  melodyTrack.channel = 0;
  addNotes(
    melodyTrack,
    project.notes.filter((note) => note.track === 'melody'),
  );

  const harmonyTrack = midi.addTrack();
  harmonyTrack.name = 'Harmony';
  harmonyTrack.channel = 1;
  addNotes(
    harmonyTrack,
    project.notes.filter((note) => note.track === 'harmony'),
  );

  return midi.toArray();
}
