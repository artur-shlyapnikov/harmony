/**
 * Timeline invariant checks (§3.4 Инварианты).
 *
 * Pure validation over event arrays; no mutation, no side effects.
 */

import { MIDI_MAX, MIDI_MIN } from '@domain/model/pitch';
import type { MelodyNoteEvent } from '@domain/model/project';
import { type ProjectDocumentV1, projectLengthTicks, type Tick } from '@domain/model/project';
import type { IntervalEvent } from './intervalOps';
import { NOTE_GRID, CHORD_GRID } from './constants';

export type InvariantViolation = {
  code:
    | 'negative_start'
    | 'zero_duration'
    | 'non_integer'
    | 'grid_melody'
    | 'grid_chord'
    | 'out_of_bounds'
    | 'overlap'
    | 'unsorted'
    | 'bad_midi'
    | 'bad_velocity';
  index?: number;
  detail?: string;
};

type InvariantContext = { lengthTicks: Tick };

function checkCommonInvariants(
  events: readonly IntervalEvent[],
  ctx: InvariantContext,
  gridCode: 'grid_melody' | 'grid_chord',
  grid: number,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  events.forEach((event, index) => {
    if (!Number.isInteger(event.startTick) || !Number.isInteger(event.durationTicks)) {
      violations.push({ code: 'non_integer', index, detail: `id=${event.id}` });
    }
    if (event.startTick < 0) {
      violations.push({ code: 'negative_start', index, detail: `id=${event.id}` });
    }
    if (event.durationTicks <= 0) {
      violations.push({ code: 'zero_duration', index, detail: `id=${event.id}` });
    }
    if (event.startTick % grid !== 0 || event.durationTicks % grid !== 0) {
      violations.push({ code: gridCode, index, detail: `id=${event.id}` });
    }
    if (event.startTick + event.durationTicks > ctx.lengthTicks) {
      violations.push({ code: 'out_of_bounds', index, detail: `id=${event.id}` });
    }
  });

  for (let i = 1; i < events.length; i += 1) {
    const previous = events[i - 1]!;
    const current = events[i]!;
    if (
      current.startTick < previous.startTick ||
      (current.startTick === previous.startTick && current.id < previous.id)
    ) {
      violations.push({ code: 'unsorted', index: i, detail: `id=${current.id}` });
    }
    // §3.4: order and overlap are independent — an out-of-order pair must
    // still get its overlap check.
    if (previous.startTick + previous.durationTicks > current.startTick) {
      violations.push({
        code: 'overlap',
        index: i,
        detail: `${previous.id} overlaps ${current.id}`,
      });
    }
  }

  return violations;
}
/** §3.4: every melody note carries a canonical pitch and velocity. */
function checkPitchInvariants(
  events: readonly IntervalEvent[],
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  events.forEach((event, index) => {
    const { midi, velocity } = event as Partial<MelodyNoteEvent>;
    if (midi !== undefined && (!Number.isFinite(midi) || midi < MIDI_MIN || midi > MIDI_MAX)) {
      violations.push({ code: 'bad_midi', index, detail: `id=${event.id}` });
    }
    if (
      velocity !== undefined &&
      (!Number.isFinite(velocity) || velocity < 1 || velocity > 127)
    ) {
      violations.push({ code: 'bad_velocity', index, detail: `id=${event.id}` });
    }
  });
  return violations;
}

/** All §3.4 melody-lane invariants over a note array. */
export function checkMelodyInvariants(
  notes: readonly IntervalEvent[],
  ctx: InvariantContext,
): InvariantViolation[] {
  return [
    ...checkCommonInvariants(notes, ctx, 'grid_melody', NOTE_GRID),
    ...checkPitchInvariants(notes),
  ];
}

/** All §3.4 harmony-lane invariants over a chord array. */
export function checkChordInvariants(
  chords: readonly IntervalEvent[],
  ctx: InvariantContext,
): InvariantViolation[] {
  return checkCommonInvariants(chords, ctx, 'grid_chord', CHORD_GRID);
}

/** All §3.4 lane invariants over a whole document (§3.7 step 8 sweep). */
export function documentInvariantViolations(
  doc: ProjectDocumentV1,
): readonly InvariantViolation[] {
  const ctx = { lengthTicks: projectLengthTicks(doc) };
  return [
    ...checkMelodyInvariants(doc.melody.notes, ctx),
    ...checkChordInvariants(doc.harmony.chords, ctx),
  ];
}

/**
 * Violation kinds a SCHEMA-VALID loaded document may legitimately carry
 * (§3.18): step 5 deliberately preserves beyond-length events, and the
 * load-path normalization repairs lane ordering but is NOT lossy about
 * overlaps. Both commit gates (editor + reducer defense-in-depth) MUST
 * ignore these kinds — otherwise every subsequent edit on such a document
 * is rejected as invariant_violation and the editor is permanently bricked.
 *
 * Deliberately minimal: any other violation kind can only arrive through a
 * bug and stays rejected by the sweep.
 */
const LOAD_TOLERATED_CODES: ReadonlySet<InvariantViolation['code']> = new Set([
  'out_of_bounds',
  'overlap',
]);

/**
 * §3.7 step 8 sweep for COMMITTED documents: full invariants minus the
 * kinds a legal load can carry. Used identically by the editor's commit
 * gate and the reducer's defense-in-depth sweep.
 */
export function committedDocumentViolations(
  doc: ProjectDocumentV1,
): readonly InvariantViolation[] {
  return documentInvariantViolations(doc).filter(
    (violation) => !LOAD_TOLERATED_CODES.has(violation.code),
  );
}
