/**
 * Timeline geometry (§3.20): pure pixel/tick/diatonic-row math for the
 * staff-like editor. Document space only — x coordinates never bake in a
 * scroll offset; callers add/subtract scrollLeft themselves. All functions
 * are total, deterministic and side-effect free.
 */

import { TICKS_PER_BAR, TICKS_PER_BEAT } from '@domain/timeline/constants';
import {
  LETTER_SEMITONES,
  type NoteLetter,
  type SpelledPitchClass,
} from '@domain/model/pitch';
import type { HarmonyContext } from '@domain/model/project';
import { modeScaleDegrees } from '@domain/theory/spelling';

// ---------------------------------------------------------------------------
// Pitch-row constants
// ---------------------------------------------------------------------------

export const MELODY_ROW_MIN_MIDI = 36;
export const MELODY_ROW_MAX_MIDI = 96;

/** Distance in px between adjacent diatonic steps (letter rows). */
export const DEFAULT_ROW_HEIGHT_PX = 12;

export const MIN_ZOOM_PX_PER_BEAT = 20;
export const MAX_ZOOM_PX_PER_BEAT = 200;

const LETTERS: readonly NoteLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const LETTER_INDEX: Readonly<Record<NoteLetter, number>> = Object.freeze({
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
});

/**
 * Diatonic row of a spelled pitch: `octave * 7 + letterIndex` so C0 is row 0
 * and every letter+octave occupies exactly one row.
 */
export function diatonicRowOf(letter: NoteLetter, octave: number): number {
  return octave * 7 + LETTER_INDEX[letter];
}

export function rowLetter(row: number): NoteLetter {
  return LETTERS[((row % 7) + 7) % 7] as NoteLetter;
}

export function rowOctave(row: number): number {
  return Math.floor(row / 7);
}

/** Sounding MIDI of the natural (unaltered) pitch sitting on `row`. */
export function naturalMidiOfRow(row: number): number {
  return (rowOctave(row) + 1) * 12 + LETTER_SEMITONES[rowLetter(row)];
}

/**
 * The five staff lines as diatonic rows. Treble-clef anchoring: E4 G4 B4 D5
 * F5, so B4 (row 34) is the middle line — the treble range centers on it.
 */
export const B4_ROW = diatonicRowOf('B', 4); // 34
export const STAFF_LINE_ROWS: readonly number[] = Object.freeze([
  B4_ROW - 4,
  B4_ROW - 2,
  B4_ROW,
  B4_ROW + 2,
  B4_ROW + 4,
]);

/** Highest/lowest diatonic rows rendered by the melody lane. */
export const LANE_TOP_ROW = midiToRow(MELODY_ROW_MAX_MIDI);
export const LANE_BOTTOM_ROW = midiToRow(MELODY_ROW_MIN_MIDI);

/** Lane content height in px for the full MELODY_ROW_RANGE. */
export function laneHeightPx(rowHeight: number = DEFAULT_ROW_HEIGHT_PX): number {
  return (LANE_TOP_ROW - LANE_BOTTOM_ROW + 1) * rowHeight;
}

// ---------------------------------------------------------------------------
// midi <-> diatonic row
// ---------------------------------------------------------------------------
/** Nearest natural-pitch diatonic row for a (possibly chromatic) MIDI note. */
export function midiToRow(midi: number): number {
  const estimate = Math.round(((midi / 12) - 1) * 7);
  let best = estimate;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = estimate - 2; row <= estimate + 2; row++) {
    const distance = Math.abs(naturalMidiOfRow(row) - midi);
    // Strict `<` keeps the LOWER row on ties (e.g. F#4 lands on F4).
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}


/**
 * Diatonic row for a MIDI note known to be spelled with `letter`: picks the
 * octave whose natural pitch is closest to `midi`, so B#3 lands on the B3 row
 * and Cb4 on the C4 row.
 */
export function diatonicRowForMidi(midi: number, letter: NoteLetter): number {
  const centerOctave = Math.floor(midi / 12) - 1;
  let best = diatonicRowOf(letter, centerOctave);
  let bestDistance = Math.abs(naturalMidiOfRow(best) - midi);
  for (let octave = centerOctave - 1; octave <= centerOctave + 1; octave++) {
    const row = diatonicRowOf(letter, octave);
    const distance = Math.abs(naturalMidiOfRow(row) - midi);
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// y <-> row / midi
// ---------------------------------------------------------------------------

export type RowAxisOpts = { topMidi: number; rowHeight: number };

/** y (px, document space) of a diatonic row; `topMidi` sits at y = 0. */
export function rowToY(row: number, opts: RowAxisOpts): number {
  return (midiToRow(opts.topMidi) - row) * opts.rowHeight;
}

/** y (px, document space) of the nearest natural row for a MIDI note. */
export function pitchRowY(midi: number, opts: RowAxisOpts): number {
  return rowToY(midiToRow(midi), opts);
}

/** Fractional diatonic row under pixel offset `y`. */
export function yToRow(y: number, opts: RowAxisOpts): number {
  return midiToRow(opts.topMidi) - y / opts.rowHeight;
}

/** Nearest natural MIDI pitch row under pixel offset `y`, clamped to range. */
export function yToMidiRow(y: number, opts: RowAxisOpts): number {
  const row = clamp(Math.round(yToRow(y, opts)), LANE_BOTTOM_ROW, LANE_TOP_ROW);
  return naturalMidiOfRow(row);
}

// ---------------------------------------------------------------------------
// Ledger lines
// ---------------------------------------------------------------------------

/**
 * Ledger-line diatonic rows required by a note on `row`: one line per even
 * step beyond the staff down/up to the note's position.
 */
export function ledgerRowsForRow(row: number): number[] {
  const topStaff = STAFF_LINE_ROWS[STAFF_LINE_ROWS.length - 1] as number;
  const bottomStaff = STAFF_LINE_ROWS[0] as number;
  if (row >= bottomStaff && row <= topStaff) return [];
  const lines: number[] = [];
  if (row > topStaff) {
    for (let r = topStaff + 2; r <= row; r += 2) lines.push(r);
  } else {
    for (let r = bottomStaff - 2; r >= row; r -= 2) lines.push(r);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// x <-> tick (document space, no scroll offset)
// ---------------------------------------------------------------------------

/** Document-space x of a tick at the given zoom (px per beat). */
export function tickToX(tick: number, zoomPxPerBeat: number): number {
  return (tick * zoomPxPerBeat) / TICKS_PER_BEAT;
}

/** Raw inverse of {@link tickToX}; the caller quantizes to its grid. */
export function xToTick(x: number, zoomPxPerBeat: number): number {
  return (x * TICKS_PER_BEAT) / zoomPxPerBeat;
}

/** Width of one measure (bar) in px at the given zoom. */
export function measureWidthPx(zoomPxPerBeat: number): number {
  return tickToX(TICKS_PER_BAR, zoomPxPerBeat);
}

export function clampZoomPxPerBeat(zoom: number): number {
  return clamp(zoom, MIN_ZOOM_PX_PER_BEAT, MAX_ZOOM_PX_PER_BEAT);
}

// ---------------------------------------------------------------------------
// Context-aware helpers (thin wrappers over domain theory — no theory logic)
// ---------------------------------------------------------------------------

/**
 * Sounding MIDI for a click that landed on the natural row `naturalMidi`:
 * the row letter is spelled per the mode ("клик по F-row → F#" в D major),
 * falling back to neutral when the letter is outside the scale.
 */
export function soundingMidiForRow(naturalMidi: number, context: HarmonyContext): number {
  const letter = rowLetter(midiToRow(naturalMidi));
  const degree = modeScaleDegrees(context).find((d) => d.letter === letter);
  const accidental = degree ? degree.accidental : 0;
  const naturalPc = naturalMidi % 12;
  const spelledPc = ((LETTER_SEMITONES[letter] + accidental) % 12 + 12) % 12;
  // Non-negative remainder fold: JS `%` keeps the dividend's sign, so a
  // plain `(diff + 6) % 12` sends diff < -6 (e.g. B# row under an E# tonic)
  // a full octave down instead of one semitone up.
  const diff = ((spelledPc - naturalPc) % 12 + 12) % 12;
  const delta = diff > 6 ? diff - 12 : diff;
  return clamp(naturalMidi + delta, MELODY_ROW_MIN_MIDI, MELODY_ROW_MAX_MIDI);
}

/** Letter row a spelled melody note renders on (letter+octave axis). */
export function spelledRowOfMidi(
  midi: number,
  spelling: SpelledPitchClass,
): number {
  return diatonicRowForMidi(midi, spelling.letter);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Namespace facade over the geometry API for consumers preferring a single
 * import (`import { timelineGeometry } from ...`), e.g. the Playhead overlay.
 */
export const timelineGeometry = Object.freeze({
  tickToX,
  xToTick,
  pitchRowY,
  measureWidthPx,
});

