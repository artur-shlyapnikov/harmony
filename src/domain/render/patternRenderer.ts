/**
 * Accompaniment pattern renderer (§3.13 Pattern semantics).
 *
 * Pure: renders one resolved voicing against one chord event under one
 * pattern spec. Every emitted note carries `track: 'harmony'` and
 * `sourceEventId = chord.id`; velocity comes from `pattern.velocity`.
 *
 * `octaveSpan === 2` extends the sequenced note set with +12-semitone
 * copies that stay inside `[profile.lowMidi, profile.highMidi]`. Copies
 * join the set BEFORE ordering/cycling logic. `block` ignores octaveSpan.
 */

import type { ChordToneRole } from '@domain/model/chord';
import type { PlaybackNote } from '@domain/model/playback';
import type { PatternSpec } from '@domain/model/pattern';
import type { ChordEvent, Tick, VoicingConstraints } from '@domain/model/project';
import { TICKS_PER_BEAT } from '@domain/timeline/constants';
import type { ResolvedVoicing } from '@domain/voicing/resolveProgression';

type VoicedNote = { midi: number; role: ChordToneRole };

/** Note set being sequenced: voicing notes (asc), optionally +12 copies. */
function noteSet(
  voicing: ResolvedVoicing,
  profile: VoicingConstraints,
  withOctaveCopies: boolean,
): VoicedNote[] {
  const notes: VoicedNote[] = voicing.midiNotes.map((midi, i) => ({
    midi,
    role: voicing.toneRoles[i] ?? 'root',
  }));
  if (withOctaveCopies) {
    for (let i = 0; i < voicing.midiNotes.length; i++) {
      const copy = voicing.midiNotes[i]! + 12;
      if (copy >= profile.lowMidi && copy <= profile.highMidi) {
        notes.push({ midi: copy, role: voicing.toneRoles[i] ?? 'root' });
      }
    }
  }
  notes.sort((a, b) => a.midi - b.midi);
  return notes;
}

/** 0..n-1 then n-2..1, repeating; extremes never doubled at the turn. */
function upDownIndices(n: number): number[] {
  if (n <= 1) return n === 1 ? [0] : [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) indices.push(i);
  for (let i = n - 2; i >= 1; i--) indices.push(i);
  return indices;
}

function harmonyNote(
  chord: ChordEvent,
  offsetTicks: Tick,
  durationTicks: Tick,
  midi: number,
  velocity: number,
): PlaybackNote | null {
  const startTick = chord.startTick + offsetTicks;
  const chordEnd = chord.startTick + chord.durationTicks;
  const duration = Math.min(durationTicks, chordEnd - startTick);
  if (duration <= 0) return null;
  return {
    track: 'harmony',
    startTick,
    durationTicks: duration,
    midi,
    velocity,
    sourceEventId: chord.id,
  };
}

function collect(
  chord: ChordEvent,
  entries: Array<{ offsetTicks: Tick; durationTicks: Tick; midi: number }>,
  velocity: number,
): PlaybackNote[] {
  const notes: PlaybackNote[] = [];
  for (const entry of entries) {
    const note = harmonyNote(
      chord,
      entry.offsetTicks,
      entry.durationTicks,
      entry.midi,
      velocity,
    );
    if (note !== null) notes.push(note);
  }
  return notes;
}

function renderBlock(
  voicingMidi: readonly number[],
  chord: ChordEvent,
  pattern: PatternSpec,
): PlaybackNote[] {
  const duration = Math.round(chord.durationTicks * pattern.gate);
  return collect(
    chord,
    voicingMidi.map((midi) => ({
      offsetTicks: 0,
      durationTicks: duration,
      midi,
    })),
    pattern.velocity,
  );
}

/**
 * Shared melodic-sequence engine for up/down/upDown/oneFiveThreeFive:
 * one note per `subdivisionTicks` step cycling until chord end.
 */
function renderSequence(
  sources: readonly VoicedNote[],
  order: readonly number[],
  chord: ChordEvent,
  pattern: PatternSpec,
): PlaybackNote[] {
  if (order.length === 0) return [];
  const step = pattern.subdivisionTicks;
  const stepDuration = Math.round(step * pattern.gate);
  const entries: Array<{ offsetTicks: Tick; durationTicks: Tick; midi: number }> = [];
  for (let t = 0; t < chord.durationTicks; t += step) {
    const midi = sources[order[(t / step) % order.length]!]!.midi;
    entries.push({ offsetTicks: t, durationTicks: stepDuration, midi });
  }
  return collect(chord, entries, pattern.velocity);
}

function renderBassChord(
  pile: readonly VoicedNote[],
  chord: ChordEvent,
  pattern: PatternSpec,
): PlaybackNote[] {
  if (pile.length === 0) return [];
  const bass = pile[0]!.midi;
  const eighthDuration = Math.round((TICKS_PER_BEAT / 2) * pattern.gate);
  const entries: Array<{ offsetTicks: Tick; durationTicks: Tick; midi: number }> = [];

  for (let beat = 0; beat < chord.durationTicks; beat += TICKS_PER_BEAT) {
    // Bass on the first eighth of every beat.
    entries.push({
      offsetTicks: beat,
      durationTicks: eighthDuration,
      midi: bass,
    });
    // Remaining voices on the second eighth (eighth grid regardless of
    // subdivisionTicks).
    for (let i = 1; i < pile.length; i++) {
      entries.push({
        offsetTicks: beat + TICKS_PER_BEAT / 2,
        durationTicks: eighthDuration,
        midi: pile[i]!.midi,
      });
    }
  }
  return collect(chord, entries, pattern.velocity);
}

/** Role cycle root → fifth → third/suspension → fifth (§3.13). */
const ONE_FIVE_THREE_FIVE_CYCLE: ChordToneRole[] = [
  'root',
  'fifth',
  'third',
  'fifth',
];

function renderOneFiveThreeFive(
  sources: readonly VoicedNote[],
  chord: ChordEvent,
  pattern: PatternSpec,
): PlaybackNote[] {
  if (sources.length === 0) return [];
  const hasRole = (role: ChordToneRole) => sources.some((n) => n.role === role);

  const order: number[] = [];
  for (const target of ONE_FIVE_THREE_FIVE_CYCLE) {
    let role: ChordToneRole;
    if (target === 'root') {
      role = 'root';
    } else if (target === 'fifth') {
      // Fifth missing → root voice.
      role = hasRole('fifth') ? 'fifth' : 'root';
    } else if (hasRole('third')) {
      role = 'third';
    } else if (hasRole('suspension')) {
      // Third absent because of sus → suspension voice.
      role = 'suspension';
    } else {
      // Neither third nor suspension → root.
      role = 'root';
    }
    const index = sources.findIndex((note) => note.role === role);
    if (index >= 0) order.push(index);
  }

  return renderSequence(sources, order, chord, pattern);
}

export function renderPattern(
  voicing: ResolvedVoicing,
  chord: ChordEvent,
  pattern: PatternSpec,
  profile: VoicingConstraints,
): PlaybackNote[] {
  if (pattern.kind === 'bassChord' && pattern.subdivisionTicks === TICKS_PER_BEAT) {
    // Quarter subdivision → block fallback (§3.13).
    return renderBlock(voicing.midiNotes, chord, pattern);
  }

  // block ignores octaveSpan (§3.13); every other kind honours it.
  const withCopies = pattern.octaveSpan === 2;

  switch (pattern.kind) {
    case 'block':
      return renderBlock(voicing.midiNotes, chord, pattern);
    case 'up':
    case 'down': {
      const sources = noteSet(voicing, profile, withCopies);
      const order = sources.map((_, i) => i);
      if (pattern.kind === 'down') order.reverse();
      return renderSequence(sources, order, chord, pattern);
    }
    case 'upDown': {
      const sources = noteSet(voicing, profile, withCopies);
      return renderSequence(sources, upDownIndices(sources.length), chord, pattern);
    }
    case 'bassChord':
      return renderBassChord(noteSet(voicing, profile, withCopies), chord, pattern);
    case 'oneFiveThreeFive':
      return renderOneFiveThreeFive(noteSet(voicing, profile, withCopies), chord, pattern);
  }
  return [];
}
