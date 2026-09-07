/**
 * Unified playback output format (§3.13).
 *
 * The single event-generation path consumed by both AudioEngine and
 * MidiExporter (§5 risk 4). Pure data, no behaviour.
 */

import type { Tick } from './project';

export type PlaybackTrack = 'melody' | 'harmony';

export type PlaybackNote = {
  track: PlaybackTrack;
  startTick: Tick;
  durationTicks: Tick;
  midi: number;
  velocity: number;
  /** Melody note id or owning ChordEvent id. */
  sourceEventId: string;
};

export type PlaybackProject = {
  ppq: number;
  bpm: number;
  timeSignature: [4, 4];
  lengthTicks: Tick;
  notes: PlaybackNote[];
};
