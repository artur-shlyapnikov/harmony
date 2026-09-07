/**
 * Timeline timing constants (§3.4) and MVP performance bounds (§3.21).
 */

export const PPQ = 960;
export const NOTE_GRID = 240; // 1/16
export const CHORD_GRID = 960; // 1/4

export const TICKS_PER_BEAT = 960;
export const TICKS_PER_BAR = 3840;

export const INITIAL_BARS = 8;
export const MIN_BARS = 1;
export const MAX_BARS = 128;

export const MAX_MELODY_NOTES = 2000;
export const MAX_CHORD_EVENTS = 512;
export const MAX_UNDO_ENTRIES = 100;
