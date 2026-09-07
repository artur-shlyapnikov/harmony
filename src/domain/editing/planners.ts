/**
 * Gesture planning & edit geometry (§3.7, §3.20).
 *
 * The single physical home of the quantize / clamp / neighbor-window math
 * that lanes previously mirrored by hand ("mirroring addNoteCmd's commit
 * math"): both the preview planners below and `applyProjectEdit`'s commit
 * resolution draw on these helpers, so a ghost preview and its committed
 * mutation can never drift apart. Preview planners reproduce today's ghost
 * formulas exactly (including their historical quirks, e.g. a right-resize
 * ghost may overgrow into a neighbor and get truncated at commit); the
 * commit resolution in ./projectEditor is the reducer semantics.
 *
 * Pure domain: no React/Redux/Tone/Dexie/DOM imports (§3.3).
 */

import type { ChordEvent, MelodyNoteEvent, Tick } from '@domain/model/project';
import { MIDI_MAX, MIDI_MIN } from '@domain/model/pitch';
import { CHORD_GRID, NOTE_GRID } from '@domain/timeline/constants';
import { clampTick, quantizeDuration, quantizeTick } from '@domain/timeline/quantize';

// ---------------------------------------------------------------------------
// Shared lane primitives
// ---------------------------------------------------------------------------

/** Sounding pitch class (0..11) — the spelling-override survival test (§3.5). */
export function midiPitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** Neighbors strictly before/after the event at `index` in a start-sorted lane. */
export function neighborWindow(
  events: readonly MelodyNoteEvent[] | readonly ChordEvent[],
  index: number,
  lengthTicks: Tick,
): { prevEnd: Tick; nextStart: Tick } {
  const previous = events[index - 1];
  const next = events[index + 1];
  return {
    prevEnd: previous ? previous.startTick + previous.durationTicks : 0,
    nextStart: next ? next.startTick : lengthTicks,
  };
}

/** Index of `id` in an event lane, or -1. */
export function findEventIndexById(
  events: readonly { id: string }[],
  id: string,
): number {
  return events.findIndex((event) => event.id === id);
}

/**
 * Drag window for moving/resizing an existing event (§3.7: no ripple edit):
 * [min, max] bounds for the event's START so it never crosses the previous
 * end or pushes past the next start / project length.
 *
 * Scans like the lanes historically did (per-event comparisons against the
 * moving event's current start), which matches the positional neighbor window
 * on sorted non-overlapping lanes — including §3.18's tolerated overlapping
 * loads, whose preview behavior must not change either.
 */
export function draggedEventWindow(
  events: readonly MelodyNoteEvent[] | readonly ChordEvent[],
  id: string,
  anchorStartTick: Tick,
  durationTicks: Tick,
  lengthTicks: Tick,
): { min: Tick; max: Tick } {
  let min = 0;
  let max = Math.max(0, lengthTicks - durationTicks);
  for (const other of events) {
    if (other.id === id) continue;
    const otherEnd = other.startTick + other.durationTicks;
    if (otherEnd <= anchorStartTick) {
      min = Math.max(min, otherEnd);
    } else if (other.startTick >= anchorStartTick) {
      max = Math.min(max, Math.max(0, other.startTick - durationTicks));
    }
  }
  return { min: Math.min(min, max), max };
}

// ---------------------------------------------------------------------------
// Melody lane preview planners (NOTE_GRID gestures)
// ---------------------------------------------------------------------------

/** Draw-gesture geometry: grid-quantized duration (a bare click commits at
 * one grid step), start clamped so the note ends within the project. Returns
 * null when nothing fits in the lane (no dispatch, no ghost). The ghost and
 * the addNote edit payload share this exact value. */
export function planNoteDrawGeometry(
  anchorTick: number,
  currentTick: number,
  lengthTicks: number,
): { startTick: number; durationTicks: number } | null {
  const start = quantizeTick(Math.min(anchorTick, currentTick), NOTE_GRID);
  let duration = quantizeDuration(Math.abs(currentTick - anchorTick), NOTE_GRID);
  if (duration < NOTE_GRID) {
    duration = NOTE_GRID;
  }
  const maxStart = Math.max(0, lengthTicks - duration);
  const startTick = clampTick(start, 0, maxStart);
  if (lengthTicks - startTick <= 0) return null;
  return { startTick, durationTicks: duration };
}

/** Body-drag preview: grid-quantized start inside the neighbor window,
 * pitch clamped to the §3.5 midi range (== the melody row range). */
export function planNoteMovePreview(params: {
  notes: readonly MelodyNoteEvent[];
  note: MelodyNoteEvent;
  grabOffsetTicks: number;
  grabMidiOffset: number;
  tick: number;
  rowMidi: number;
  lengthTicks: number;
}): { previewStart: Tick; previewMidi: number } {
  const { min, max } = draggedEventWindow(
    params.notes,
    params.note.id,
    params.note.startTick,
    params.note.durationTicks,
    params.lengthTicks,
  );
  return {
    previewStart: clampTick(
      quantizeTick(params.tick - params.grabOffsetTicks, NOTE_GRID),
      min,
      max,
    ),
    previewMidi: clampTick(params.rowMidi + params.grabMidiOffset, MIDI_MIN, MIDI_MAX),
  };
}

/** Right-edge resize preview: grows toward the project end only (a neighbor
 * further right truncates at commit — historical ghost quirk, preserved). */
export function planNoteRightResizePreview(params: {
  note: MelodyNoteEvent;
  tick: number;
  lengthTicks: number;
}): number {
  const maxDuration = Math.max(NOTE_GRID, params.lengthTicks - params.note.startTick);
  return clampTick(
    quantizeDuration(params.tick - params.note.startTick, NOTE_GRID),
    NOTE_GRID,
    maxDuration,
  );
}

/** Left-edge resize preview: one field decides — the quantized edge position
 * clamps between the neighbor window and leaving one grid step of body; the
 * duration derives from the fixed right edge. */
export function planNoteLeftResizePreview(params: {
  notes: readonly MelodyNoteEvent[];
  note: MelodyNoteEvent;
  tick: number;
  lengthTicks: number;
}): { previewStart: Tick; previewDuration: Tick } {
  const { min } = draggedEventWindow(
    params.notes,
    params.note.id,
    params.note.startTick,
    params.note.durationTicks,
    params.lengthTicks,
  );
  const noteEnd = params.note.startTick + params.note.durationTicks;
  const previewStart = clampTick(
    quantizeTick(params.tick, NOTE_GRID),
    Math.max(min, 0),
    noteEnd - NOTE_GRID,
  );
  return { previewStart, previewDuration: noteEnd - previewStart };
}

// ---------------------------------------------------------------------------
// Chord lane preview planners (CHORD_GRID gestures)
// ---------------------------------------------------------------------------

/** Body-drag preview: grid-quantized start inside the neighbor window. */
export function planChordMovePreview(params: {
  chords: readonly ChordEvent[];
  chord: ChordEvent;
  grabOffsetTicks: number;
  tick: number;
  lengthTicks: number;
}): { previewStart: Tick } {
  const { min, max } = draggedEventWindow(
    params.chords,
    params.chord.id,
    params.chord.startTick,
    params.chord.durationTicks,
    params.lengthTicks,
  );
  return {
    previewStart: clampTick(
      quantizeTick(params.tick - params.grabOffsetTicks, CHORD_GRID),
      min,
      max,
    ),
  };
}

/** Right-edge resize preview (see planNoteRightResizePreview). */
export function planChordRightResizePreview(params: {
  chord: ChordEvent;
  tick: number;
  lengthTicks: number;
}): number {
  const maxDuration = Math.max(CHORD_GRID, params.lengthTicks - params.chord.startTick);
  return clampTick(
    quantizeDuration(params.tick - params.chord.startTick, CHORD_GRID),
    CHORD_GRID,
    maxDuration,
  );
}

/** Left-edge resize preview (see planNoteLeftResizePreview). */
export function planChordLeftResizePreview(params: {
  chords: readonly ChordEvent[];
  chord: ChordEvent;
  tick: number;
  lengthTicks: number;
}): { previewStart: Tick; previewDuration: Tick } {
  const { min } = draggedEventWindow(
    params.chords,
    params.chord.id,
    params.chord.startTick,
    params.chord.durationTicks,
    params.lengthTicks,
  );
  const chordEnd = params.chord.startTick + params.chord.durationTicks;
  const previewStart = clampTick(
    quantizeTick(params.tick, CHORD_GRID),
    Math.max(min, 0),
    chordEnd - CHORD_GRID,
  );
  return { previewStart, previewDuration: chordEnd - previewStart };
}

// ---------------------------------------------------------------------------
// Range selection (§3.20)
// ---------------------------------------------------------------------------

/** Range-drag geometry: grid-quantized start and duration (min one grid step)
 * so the ghost preview and the committed selection never disagree. */
export function planRangeSelectionGeometry(
  anchorTick: number,
  currentTick: number,
): { startTick: Tick; durationTicks: Tick } {
  return {
    startTick: quantizeTick(Math.min(anchorTick, currentTick), CHORD_GRID),
    durationTicks: quantizeDuration(Math.abs(currentTick - anchorTick), CHORD_GRID),
  };
}
