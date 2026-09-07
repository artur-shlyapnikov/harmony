/**
 * Accompaniment pattern model (§3.6).
 *
 * A pattern never mutates ChordEvent and never creates persisted melody notes.
 */

export type PatternKind =
  | 'block'
  | 'up'
  | 'down'
  | 'upDown'
  | 'bassChord'
  | 'oneFiveThreeFive';

export type PatternSpec = {
  kind: PatternKind;
  subdivisionTicks: 240 | 480 | 960;
  /** Note length as a fraction of the subdivision step. */
  gate: number;
  octaveSpan: 1 | 2;
  velocity: number;
};

export const DEFAULT_PATTERN: PatternSpec = Object.freeze({
  kind: 'block',
  subdivisionTicks: 480,
  gate: 0.9,
  octaveSpan: 1,
  velocity: 80,
});
