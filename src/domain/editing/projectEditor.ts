/**
 * ProjectEditor (§3.5 document, §3.7 timeline mutation rules, §3.8/§3.14).
 *
 * The single owner of all PROJECT EDIT SEMANTICS: quantize/clamp, neighbor
 * exclusion windows, range replacement, chord merge policy (incl. which id
 * survives), projected event limits (§3.21), no-op detection, validation and
 * the §3.7 step 8 invariant gate. Previously these rules existed three times
 * (command preflight, Redux reducer, lane preview math); every caller now
 * goes through {@link applyProjectEdit} or the preview planners next door.
 *
 * Purity contract:
 *  - pure function of (document, edit) → EditResult; the input is never
 *    mutated;
 *  - applied documents are returned WITHOUT a fresh `updatedAt` — wall-clock
 *    stamping is owned by the state layer (the commit reducer), matching how
 *    transposeProjectToTonic treats timestamps;
 *  - new event ids arrive inside the edit payload (application-layer UUIDs);
 *    replaceRange fragment ids stay internal to @domain/timeline.
 *
 * No React/Redux/Tone/Dexie imports (§3.3, enforced by domainPurity).
 */

import type { PatternSpec } from '@domain/model/pattern';
import type { ChordSpec } from '@domain/model/chord';
import {
  MIDI_MAX,
  MIDI_MIN,
  type ModeId,
  pitchClassOf,
  type SpelledPitchClass,
} from '@domain/model/pitch';
import {
  type ChordEvent,
  type MelodyNoteEvent,
  type ProjectDocumentV1,
  type Tick,
  barsToLengthTicks,
  projectLengthTicks,
} from '@domain/model/project';
import {
  CHORD_GRID,
  MAX_BARS,
  MAX_CHORD_EVENTS,
  MAX_MELODY_NOTES,
  MIN_BARS,
  NOTE_GRID,
} from '@domain/timeline/constants';
import { mergeAdjacentIdenticalChords, replaceRange } from '@domain/timeline/intervalOps';
import { committedDocumentViolations } from '@domain/timeline/invariants';
import { clampTick, quantizeDuration, quantizeTick } from '@domain/timeline/quantize';
import { transposeProjectToTonic } from '@domain/transpose/transposeProject';
import { findEventIndexById, midiPitchClass, neighborWindow } from './planners';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Why an edit did not apply. The application layer maps these to toasts. */
export type EditRejection =
  | { kind: 'not_found' }
  /** Non-finite ticks/midi/velocity ingress that clamping cannot rescue. */
  | { kind: 'invalid_event' }
  | { kind: 'melody_limit' }
  | { kind: 'chord_limit' }
  | { kind: 'velocity_out_of_range' }
  | { kind: 'midi_out_of_range'; midi: number }
  | { kind: 'title_empty' }
  | { kind: 'bpm_out_of_range' }
  | { kind: 'bars_out_of_range' }
  | { kind: 'transpose_out_of_range'; offendingNoteIds: readonly string[] }
  | { kind: 'same_tonic' }
  /** §3.7 step 8: the resulting document violates a §3.4 lane invariant. */
  | { kind: 'invariant_violation' }
  /** The spelling override does not name the note's sounding pitch class
   *  (§3.5: an override may only respell, never retune). */
  | { kind: 'invalid_spelling_override' };

/** Every document-mutating operation in the editor (§3.7, §3.8, §3.14). */
export type ProjectEdit =
  // Melody lane
  | { kind: 'addNote'; id: string; startTick: Tick; durationTicks: Tick; midi: number; velocity: number }
  | { kind: 'moveNote'; id: string; newStartTick: Tick; newMidi: number }
  | { kind: 'resizeNote'; id: string; newDurationTicks: Tick }
  /** Atomic left-edge resize: BOTH fields in ONE mutation = one undo entry (§3.7/§3.8). */
  | { kind: 'moveResizeNote'; id: string; newStartTick: Tick; newDurationTicks: Tick }
  | { kind: 'deleteNote'; id: string }
  /** §3.20 range delete: every note AND chord intersecting [startTick, endTick). */
  | { kind: 'deleteEventsInRange'; startTick: Tick; endTick: Tick }
  | { kind: 'setNoteVelocity'; id: string; velocity: number }
  | { kind: 'setNoteSpellingOverride'; id: string; override: SpelledPitchClass | null }
  | { kind: 'moveNoteSemitones'; id: string; delta: number }
  // Harmony lane
  | { kind: 'addChordRange'; id: string; startTick: Tick; durationTicks: Tick; chord: ChordSpec }
  | { kind: 'setChordSpec'; id: string; chord: ChordSpec }
  | { kind: 'deleteChord'; id: string }
  | { kind: 'moveChord'; id: string; newStartTick: Tick }
  | { kind: 'resizeChord'; id: string; newDurationTicks: Tick }
  | { kind: 'moveResizeChord'; id: string; newStartTick: Tick; newDurationTicks: Tick }
  | { kind: 'setChordPatternOverride'; id: string; pattern: PatternSpec | null }
  // Global
  | { kind: 'setTitle'; title: string }
  | { kind: 'setBpm'; bpm: number }
  | { kind: 'setBars'; bars: number }
  | { kind: 'setDefaultPattern'; pattern: PatternSpec }
  | { kind: 'transposeToTonic'; targetTonic: SpelledPitchClass }
  | { kind: 'setMode'; mode: ModeId };

export type EditResult =
  | { kind: 'applied'; project: ProjectDocumentV1 }
  /** Semantic no-op: nothing would change. Whether that is reported as
   *  silent success or as an error is APPLICATION policy (§3.8 mutation
   *  economy vs the legacy identity-protocol toasts); the domain only
   *  reports that no change would occur. */
  | { kind: 'unchanged' }
  | { kind: 'rejected'; reason: EditRejection };

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function applyProjectEdit(
  project: ProjectDocumentV1,
  edit: ProjectEdit,
): EditResult {
  switch (edit.kind) {
    // ------------------------------------------------------------------
    // Melody lane (§3.7: insert replaces the intersected range)
    // ------------------------------------------------------------------
    case 'addNote': {
      if (!allFinite(edit.startTick, edit.durationTicks, edit.midi, edit.velocity)) {
        return rejected({ kind: 'invalid_event' });
      }
      // quantizeDuration floors toward the grid minimum, so a negative or
      // zero duration would silently become a full grid step — reject first.
      if (edit.durationTicks <= 0) return rejected({ kind: 'invalid_event' });
      const durationTicks = quantizeDuration(edit.durationTicks, NOTE_GRID);
      const maxStart = Math.max(0, projectLengthTicks(project) - durationTicks);
      const startTick = clampTick(quantizeTick(edit.startTick, NOTE_GRID), 0, maxStart);
      // §3.4: events never extend past lengthTicks — cap duration to the
      // remaining room and reject a zero/negative result.
      const cappedDuration = Math.min(durationTicks, projectLengthTicks(project) - startTick);
      if (cappedDuration <= 0) return rejected({ kind: 'invalid_event' });
      const notes = replaceRange<MelodyNoteEvent>(
        project.melody.notes,
        { start: startTick, end: startTick + cappedDuration },
        {
          id: edit.id,
          startTick,
          durationTicks: cappedDuration,
          midi: clampTick(Math.round(edit.midi), MIDI_MIN, MIDI_MAX),
          velocity: clampTick(Math.round(edit.velocity), 1, 127),
        },
      );
      // §3.21: limit applies to the RESULT — a replacement that shrinks or
      // keeps the lane at the cap stays legal; only exceeding rejects.
      if (notes.length > MAX_MELODY_NOTES) return rejected({ kind: 'melody_limit' });
      return commit(withNotes(project, notes));
    }

    case 'moveNote': {
      const index = findEventIndexById(project.melody.notes, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      if (!Number.isFinite(edit.newMidi)) return rejected({ kind: 'invalid_event' });
      const notes = project.melody.notes;
      const note = notes[index]!;
      const { prevEnd, nextStart } = neighborWindow(notes, index, projectLengthTicks(project));

      const windowWidth = nextStart - prevEnd;
      let newStartTick: Tick;
      if (windowWidth < note.durationTicks) {
        newStartTick = note.startTick; // no room: keep position, still allow pitch move
      } else {
        newStartTick = clampTick(
          quantizeTick(edit.newStartTick, NOTE_GRID),
          prevEnd,
          nextStart - note.durationTicks,
        );
      }
      const newMidi = clampTick(Math.round(edit.newMidi), MIDI_MIN, MIDI_MAX);

      if (newStartTick === note.startTick && newMidi === note.midi) return UNCHANGED;
      return commit(
        withNotes(
          project,
          notes.map((n, i) => (i === index ? movedNote(note, newStartTick, newMidi) : n)),
        ),
      );
    }

    case 'resizeNote': {
      const index = findEventIndexById(project.melody.notes, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      if (!Number.isFinite(edit.newDurationTicks)) return rejected({ kind: 'invalid_event' });
      const notes = project.melody.notes;
      const note = notes[index]!;
      const { nextStart } = neighborWindow(notes, index, projectLengthTicks(project));
      // Cap = room until next neighbor / project end. No room for even one
      // grid step -> leave untouched rather than break the grid invariant.
      const cap = Math.min(nextStart, projectLengthTicks(project)) - note.startTick;
      if (cap < NOTE_GRID) return UNCHANGED;
      const durationTicks = Math.min(quantizeDuration(edit.newDurationTicks, NOTE_GRID), cap);
      if (durationTicks === note.durationTicks) return UNCHANGED;
      return commit(
        withNotes(
          project,
          notes.map((n, i) => (i === index ? { ...n, durationTicks } : n)),
        ),
      );
    }

    case 'moveResizeNote': {
      // Atomic left-edge resize (§3.7/§3.8): start and duration change in ONE
      // mutation so a drag produces exactly one history entry.
      const index = findEventIndexById(project.melody.notes, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      if (!allFinite(edit.newStartTick, edit.newDurationTicks)) {
        return rejected({ kind: 'invalid_event' });
      }
      const notes = project.melody.notes;
      const note = notes[index]!;
      const { prevEnd, nextStart } = neighborWindow(notes, index, projectLengthTicks(project));

      const cap = Math.min(nextStart, projectLengthTicks(project)) - prevEnd;
      if (cap < NOTE_GRID) return UNCHANGED;
      const durationTicks = Math.min(quantizeDuration(edit.newDurationTicks, NOTE_GRID), cap);
      const newStartTick = clampTick(
        quantizeTick(edit.newStartTick, NOTE_GRID),
        prevEnd,
        nextStart - durationTicks,
      );

      if (newStartTick === note.startTick && durationTicks === note.durationTicks) return UNCHANGED;
      return commit(
        withNotes(
          project,
          notes.map((n, i) =>
            i === index ? { ...n, startTick: newStartTick, durationTicks } : n,
          ),
        ),
      );
    }

    case 'deleteNote': {
      const remaining = project.melody.notes.filter((note) => note.id !== edit.id);
      if (remaining.length === project.melody.notes.length) return UNCHANGED;
      return commit(withNotes(project, remaining));
    }

    case 'deleteEventsInRange': {
      // §3.20 range delete: every note AND chord intersecting
      // [startTick, endTick) goes in ONE mutation (one history entry).
      // Intersection matches lane culling: half-open interval overlap.
      const { startTick, endTick } = edit;
      const notes = project.melody.notes.filter(
        (note) =>
          !(note.startTick < endTick && note.startTick + note.durationTicks > startTick),
      );
      let chords = project.harmony.chords.filter(
        (chord) =>
          !(chord.startTick < endTick && chord.startTick + chord.durationTicks > startTick),
      );
      if (
        notes.length === project.melody.notes.length &&
        chords.length === project.harmony.chords.length
      ) {
        return UNCHANGED; // nothing covered → no history entry
      }
      // §3.7 step 7: chord removal can make formerly separated identical
      // neighbors adjacent — merge like any other harmony edit.
      chords = mergeAdjacentIdenticalChords(chords);
      return commit(withChords(withNotes(project, notes), chords));
    }

    case 'setNoteVelocity': {
      // Reject non-integer/out-of-range before touching the lane (NaN fails
      // Number.isInteger and would defeat the value-equality no-op below).
      if (!Number.isInteger(edit.velocity) || edit.velocity < 1 || edit.velocity > 127) {
        return rejected({ kind: 'velocity_out_of_range' });
      }
      const index = findEventIndexById(project.melody.notes, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      const note = project.melody.notes[index]!;
      if (note.velocity === edit.velocity) return UNCHANGED;
      return commit(
        withNotes(
          project,
          project.melody.notes.map((n, i) =>
            i === index ? { ...n, velocity: edit.velocity } : n,
          ),
        ),
      );
    }

    case 'setNoteSpellingOverride': {
      const index = findEventIndexById(project.melody.notes, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      const note = project.melody.notes[index]!;
      const incoming = edit.override;
      // §3.5: an override RESPELLS the sounding pitch class — it must never
      // contradict it, or displayed pitch diverges from sounding pitch.
      if (incoming !== null && pitchClassOf(incoming) !== midiPitchClass(note.midi)) {
        return rejected({ kind: 'invalid_spelling_override' });
      }
      // Value-equality short-circuit: an override equal to the existing one
      // is a no-op.
      if (incoming === null) {
        if (note.spellingOverride === undefined) return UNCHANGED;
      } else if (
        note.spellingOverride !== undefined &&
        note.spellingOverride.letter === incoming.letter &&
        note.spellingOverride.accidental === incoming.accidental
      ) {
        return UNCHANGED;
      }
      return commit(
        withNotes(
          project,
          project.melody.notes.map((n, i) => {
            if (i !== index) return n;
            if (edit.override === null) {
              const { spellingOverride: _removed, ...rest } = n;
              return rest;
            }
            return { ...n, spellingOverride: edit.override };
          }),
        ),
      );
    }

    case 'moveNoteSemitones': {
      const index = findEventIndexById(project.melody.notes, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      const note = project.melody.notes[index]!;
      const target = note.midi + edit.delta;
      if (!Number.isFinite(target) || target < MIDI_MIN || target > MIDI_MAX) {
        return rejected({ kind: 'midi_out_of_range', midi: target });
      }
      // §3.5: result stays integral like every midi-carrying mutation; an
      // override pins one sounding pitch class — a move that changes it
      // leaves the old spelling stale, so drop it.
      return commit(
        withNotes(
          project,
          project.melody.notes.map((n, i) =>
            i === index ? movedNote(note, note.startTick, Math.round(target)) : n,
          ),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Harmony lane (§3.7: same replace semantics + adjacent-merge)
    // ------------------------------------------------------------------
    case 'addChordRange': {
      if (!allFinite(edit.startTick, edit.durationTicks)) {
        return rejected({ kind: 'invalid_event' });
      }
      // quantizeDuration floors toward the grid minimum, so a negative or
      // zero duration would silently become a full grid step — reject first.
      if (edit.durationTicks <= 0) return rejected({ kind: 'invalid_event' });
      const durationTicks = quantizeDuration(edit.durationTicks, CHORD_GRID);
      const maxStart = Math.max(0, projectLengthTicks(project) - durationTicks);
      const startTick = clampTick(quantizeTick(edit.startTick, CHORD_GRID), 0, maxStart);
      const cappedDuration = Math.min(durationTicks, projectLengthTicks(project) - startTick);
      if (cappedDuration <= 0) return rejected({ kind: 'invalid_event' });

      const replaced = replaceRange<ChordEvent>(
        project.harmony.chords,
        { start: startTick, end: startTick + cappedDuration },
        {
          id: edit.id,
          startTick,
          durationTicks: cappedDuration,
          chord: edit.chord,
        },
      );
      const chords = mergeAdjacentIdenticalChords(replaced);
      // §3.21: limit applies to the RESULT — symmetric with the melody lane.
      if (chords.length > MAX_CHORD_EVENTS) return rejected({ kind: 'chord_limit' });
      return commit(withChords(project, chords));
    }

    case 'setChordSpec': {
      const index = findEventIndexById(project.harmony.chords, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      // §3.8 mutation economy: re-selecting the current spec changes nothing.
      const existing = project.harmony.chords[index]!.chord;
      if (
        existing.root.letter === edit.chord.root.letter &&
        existing.root.accidental === edit.chord.root.accidental &&
        existing.templateId === edit.chord.templateId
      ) {
        return UNCHANGED;
      }
      // §3.7 step 7: a spec change can make newly-adjacent identical
      // neighbors mergeable (the EARLIER of the pair keeps its id).
      return commit(
        withChords(
          project,
          mergeAdjacentIdenticalChords(
            project.harmony.chords.map((c, i) => (i === index ? { ...c, chord: edit.chord } : c)),
          ),
        ),
      );
    }

    case 'deleteChord': {
      const remaining = project.harmony.chords.filter((chord) => chord.id !== edit.id);
      if (remaining.length === project.harmony.chords.length) return UNCHANGED;
      // §3.7 step 7: removal can make formerly separated identical chords
      // adjacent — they merge just like after any other harmony edit.
      return commit(withChords(project, mergeAdjacentIdenticalChords(remaining)));
    }

    case 'moveChord': {
      const index = findEventIndexById(project.harmony.chords, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      const chords = project.harmony.chords;
      const chord = chords[index]!;
      const { prevEnd, nextStart } = neighborWindow(chords, index, projectLengthTicks(project));

      const windowWidth = nextStart - prevEnd;
      const newStartTick =
        windowWidth < chord.durationTicks
          ? chord.startTick
          : clampTick(
              quantizeTick(edit.newStartTick, CHORD_GRID),
              prevEnd,
              nextStart - chord.durationTicks,
            );
      if (newStartTick === chord.startTick) return UNCHANGED;
      // §3.7 step 7: moving flush against an identical neighbor merges.
      return commit(
        withChords(
          project,
          mergeAdjacentIdenticalChords(
            chords.map((c, i) => (i === index ? { ...c, startTick: newStartTick } : c)),
          ),
        ),
      );
    }

    case 'resizeChord': {
      const index = findEventIndexById(project.harmony.chords, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      if (!Number.isFinite(edit.newDurationTicks)) return rejected({ kind: 'invalid_event' });
      const chords = project.harmony.chords;
      const chord = chords[index]!;
      const { nextStart } = neighborWindow(chords, index, projectLengthTicks(project));
      // Cap = room until next neighbor / project end. No room for even one
      // grid step -> leave untouched rather than break the grid invariant.
      const cap = Math.min(nextStart, projectLengthTicks(project)) - chord.startTick;
      if (cap < CHORD_GRID) return UNCHANGED;
      const durationTicks = Math.min(quantizeDuration(edit.newDurationTicks, CHORD_GRID), cap);
      if (durationTicks === chord.durationTicks) return UNCHANGED;
      // §3.7 step 7: growing flush against an identical neighbor merges.
      return commit(
        withChords(
          project,
          mergeAdjacentIdenticalChords(
            chords.map((c, i) => (i === index ? { ...c, durationTicks } : c)),
          ),
        ),
      );
    }

    case 'moveResizeChord': {
      const index = findEventIndexById(project.harmony.chords, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      if (!allFinite(edit.newStartTick, edit.newDurationTicks)) {
        return rejected({ kind: 'invalid_event' });
      }
      const chords = project.harmony.chords;
      const chord = chords[index]!;
      const { prevEnd, nextStart } = neighborWindow(chords, index, projectLengthTicks(project));

      const cap = Math.min(nextStart, projectLengthTicks(project)) - prevEnd;
      if (cap < CHORD_GRID) return UNCHANGED;
      const durationTicks = Math.min(quantizeDuration(edit.newDurationTicks, CHORD_GRID), cap);
      const newStartTick = clampTick(
        quantizeTick(edit.newStartTick, CHORD_GRID),
        prevEnd,
        nextStart - durationTicks,
      );

      if (newStartTick === chord.startTick && durationTicks === chord.durationTicks) return UNCHANGED;
      // §3.7 step 7: growing flush against an identical neighbor merges.
      return commit(
        withChords(
          project,
          mergeAdjacentIdenticalChords(
            chords.map((c, i) =>
              i === index ? { ...c, startTick: newStartTick, durationTicks } : c,
            ),
          ),
        ),
      );
    }

    case 'setChordPatternOverride': {
      const index = findEventIndexById(project.harmony.chords, edit.id);
      if (index === -1) return rejected({ kind: 'not_found' });
      const chord = project.harmony.chords[index]!;
      const incoming = edit.pattern;
      // Value-equality short-circuit: an override equal to the existing one
      // is a no-op.
      if (incoming === null) {
        if (chord.patternOverride === undefined) return UNCHANGED;
      } else if (
        chord.patternOverride !== undefined &&
        chord.patternOverride.kind === incoming.kind &&
        chord.patternOverride.subdivisionTicks === incoming.subdivisionTicks &&
        chord.patternOverride.gate === incoming.gate &&
        chord.patternOverride.octaveSpan === incoming.octaveSpan &&
        chord.patternOverride.velocity === incoming.velocity
      ) {
        return UNCHANGED;
      }
      // §3.7 step 7: removing/adding an override can make previously
      // distinct neighbors identical — merge like any other harmony edit.
      return commit(
        withChords(
          project,
          mergeAdjacentIdenticalChords(
            project.harmony.chords.map((c, i) => {
              if (i !== index) return c;
              if (edit.pattern === null) {
                const { patternOverride: _removed, ...rest } = c;
                return rest;
              }
              return { ...c, patternOverride: edit.pattern };
            }),
          ),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Global document fields (§3.5, §3.8, §3.14)
    // ------------------------------------------------------------------
    case 'setTitle': {
      // Schema floor is min(1); the toolbar caps entry at 60 chars (matching
      // the create dialog) — re-validate here so a stale client cannot
      // persist an empty title.
      const title = edit.title.trim().slice(0, 60);
      if (title.length === 0) return rejected({ kind: 'title_empty' });
      if (title === project.title) return UNCHANGED;
      return commit({ ...project, title });
    }

    case 'setBpm': {
      // §3.5: fractional tempos in 40..240 are allowed; NaN/Infinity must be
      // rejected — NaN fails both range comparisons and would corrupt
      // timing.bpm.
      if (!Number.isFinite(edit.bpm) || edit.bpm < 40 || edit.bpm > 240) {
        return rejected({ kind: 'bpm_out_of_range' });
      }
      if (edit.bpm === project.timing.bpm) return UNCHANGED;
      return commit({
        ...project,
        timing: { ...project.timing, bpm: edit.bpm },
      });
    }

    case 'setBars': {
      // §3.8 «add/remove bars»: resize the timeline as ONE mutation — drop
      // events fully at/after the new boundary, truncate straddlers.
      if (
        !Number.isFinite(edit.bars) ||
        !Number.isInteger(edit.bars) ||
        edit.bars < MIN_BARS ||
        edit.bars > MAX_BARS
      ) {
        return rejected({ kind: 'bars_out_of_range' });
      }
      if (edit.bars === project.timing.bars) return UNCHANGED;
      const newLengthTicks: Tick = barsToLengthTicks(edit.bars);
      // Fully at/after the boundary → removed; straddling → truncated to
      // end exactly at the boundary (zero-length results dropped); ids of
      // surviving events are untouched.
      const notes = project.melody.notes.flatMap((note) => {
        if (note.startTick >= newLengthTicks) return [];
        const durationTicks = Math.min(note.durationTicks, newLengthTicks - note.startTick);
        if (durationTicks <= 0) return [];
        return [durationTicks === note.durationTicks ? note : { ...note, durationTicks }];
      });
      const chords = project.harmony.chords.flatMap((chord) => {
        if (chord.startTick >= newLengthTicks) return [];
        const durationTicks = Math.min(chord.durationTicks, newLengthTicks - chord.startTick);
        if (durationTicks <= 0) return [];
        return [durationTicks === chord.durationTicks ? chord : { ...chord, durationTicks }];
      });
      return commit({
        ...project,
        timing: { ...project.timing, bars: edit.bars },
        melody: { ...project.melody, notes },
        harmony: { ...project.harmony, chords },
      });
    }

    case 'setDefaultPattern': {
      const existing = project.harmony.defaultPattern;
      // Value-equality short-circuit: an identical pattern spec is a no-op.
      if (
        existing.kind === edit.pattern.kind &&
        existing.subdivisionTicks === edit.pattern.subdivisionTicks &&
        existing.gate === edit.pattern.gate &&
        existing.octaveSpan === edit.pattern.octaveSpan &&
        existing.velocity === edit.pattern.velocity
      ) {
        return UNCHANGED;
      }
      return commit({ ...project, harmony: { ...project.harmony, defaultPattern: edit.pattern } });
    }

    case 'transposeToTonic': {
      // §3.14 atomic transposition; ids/durations/patterns untouched.
      const result = transposeProjectToTonic(project, edit.targetTonic);
      if (!result.ok) {
        return result.error.kind === 'out_of_range'
          ? rejected({
              kind: 'transpose_out_of_range',
              offendingNoteIds: result.error.offendingNoteIds,
            })
          : rejected({ kind: 'same_tonic' });
      }
      return commit(result.project);
    }

    case 'setMode': {
      if (edit.mode === project.harmonyContext.mode) return UNCHANGED;
      return commit({
        ...project,
        harmonyContext: { ...project.harmonyContext, mode: edit.mode },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const UNCHANGED: EditResult = { kind: 'unchanged' };

function rejected(reason: EditRejection): EditResult {
  return { kind: 'rejected', reason };
}

function allFinite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function withNotes(project: ProjectDocumentV1, notes: MelodyNoteEvent[]): ProjectDocumentV1 {
  return { ...project, melody: { ...project.melody, notes } };
}

function withChords(project: ProjectDocumentV1, chords: ChordEvent[]): ProjectDocumentV1 {
  return { ...project, harmony: { ...project.harmony, chords } };
}

/**
 * §3.7 step 8 ("Проверить invariants"): EVERY accepted mutation must satisfy
 * the §3.4 lane invariants — a violation rejects the whole edit. This is the
 * PRIMARY gate since the editor decides success before dispatch; the commit
 * reducer keeps the same sweep as defense-in-depth only.
 *
 * The kinds a SCHEMA-VALID load can carry ('out_of_bounds' per §3.18 step 5,
 * 'overlap' because load normalization tolerates overlaps) are EXCLUDED:
 * such documents are legal present state — rejecting every mutation on them
 * would permanently brick the editor. Mutations can never CREATE either kind
 * anyway: every geometry path clamps to projectLengthTicks and sorts the
 * lane, and replaceRange truncates rather than overlaps. See
 * committedDocumentViolations in @domain/timeline/invariants.
 */
function commit(next: ProjectDocumentV1): EditResult {
  const violations = committedDocumentViolations(next);
  if (violations.length > 0) {
    if (import.meta.env.DEV) {
      console.error('[projectEditor] §3.4 invariant violations rejected the edit:', violations);
    }
    return rejected({ kind: 'invariant_violation' });
  }
  return { kind: 'applied', project: next };
}

/** A pitch-moving update: fresh event object; a stale spelling override
 *  (pitch class changed) is stripped (§3.5). */
function movedNote(
  note: MelodyNoteEvent,
  newStartTick: Tick,
  newMidi: number,
): MelodyNoteEvent {
  const moved: MelodyNoteEvent = { ...note, startTick: newStartTick, midi: newMidi };
  if (
    moved.spellingOverride !== undefined &&
    midiPitchClass(newMidi) !== midiPitchClass(note.midi)
  ) {
    const { spellingOverride: _stale, ...rest } = moved;
    return rest;
  }
  return moved;
}
