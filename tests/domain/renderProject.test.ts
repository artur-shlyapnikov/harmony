import { describe, expect, it } from 'vitest';

import type {
  ChordEvent,
  MelodyNoteEvent,
  ProjectDocumentV1,
} from '@domain/model/project';
import type { PatternSpec } from '@domain/model/pattern';
import { createProjectDocument } from '@domain/model/project';
import { PlaybackRenderError } from '@domain/render/renderErrors';
import { renderProject } from '@domain/render/renderProject';
import { validatePlayback } from '@domain/render/validatePlayback';

function makeDoc(overrides?: {
  bars?: number;
  melody?: MelodyNoteEvent[];
  chords?: ChordEvent[];
  defaultPattern?: PatternSpec;
}): ProjectDocumentV1 {
  const doc = createProjectDocument({ title: 't', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' });
  if (overrides?.bars !== undefined) doc.timing.bars = overrides.bars;
  if (overrides?.melody) doc.melody.notes = overrides.melody;
  if (overrides?.chords) doc.harmony.chords = overrides.chords;
  if (overrides?.defaultPattern) doc.harmony.defaultPattern = overrides.defaultPattern;
  return doc;
}

const BLOCK: PatternSpec = {
  kind: 'block',
  subdivisionTicks: 480,
  gate: 0.9,
  octaveSpan: 1,
  velocity: 80,
};

const UP: PatternSpec = { ...BLOCK, kind: 'up' };

function chord(id: string, startTick: number, durationTicks: number, patternOverride?: PatternSpec): ChordEvent {
  return {
    id,
    startTick,
    durationTicks,
    chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
    ...(patternOverride ? { patternOverride } : {}),
  };
}

function trackRank(track: 'melody' | 'harmony'): number {
  return track === 'harmony' ? 0 : 1;
}

describe('renderProject — header and empty project', () => {
  it('returns valid header with empty notes for an empty project', () => {
    const doc = makeDoc();
    const playback = renderProject(doc);

    expect(playback).toEqual({
      ppq: 960,
      bpm: 120,
      timeSignature: [4, 4],
      lengthTicks: 8 * 3840,
      notes: [],
    });
  });
});

describe('renderProject — melody mapping', () => {
  it('maps melody notes 1:1 without splitting across chord boundaries', () => {
    const doc = makeDoc({
      melody: [{ id: 'm1', startTick: 0, durationTicks: 3840, midi: 72, velocity: 100 }],
      chords: [chord('c1', 0, 1920), chord('c2', 1920, 1920)],
    });
    const playback = renderProject(doc);
    const melodyNotes = playback.notes.filter((n) => n.track === 'melody');

    expect(melodyNotes).toHaveLength(1); // spans both chords untouched
    expect(melodyNotes[0]).toEqual({
      track: 'melody',
      startTick: 0,
      durationTicks: 3840,
      midi: 72,
      velocity: 100,
      sourceEventId: 'm1',
    });
  });
  it('clips at lengthTicks inclusively: a note ending exactly at the limit survives whole, one starting there is dropped (§3.13)', () => {
    const lengthTicks = 8 * 3840;
    const doc = makeDoc({
      melody: [
        { id: 'abutting', startTick: lengthTicks - 960, durationTicks: 960, midi: 72, velocity: 100 },
        { id: 'beyond', startTick: lengthTicks, durationTicks: 480, midi: 74, velocity: 100 },
      ],
    });
    const playback = renderProject(doc);
    const melodyNotes = playback.notes.filter((n) => n.track === 'melody');

    expect(melodyNotes).toHaveLength(1);
    // Zero-overlap contact keeps the ORIGINAL duration — no truncation.
    expect(melodyNotes[0]).toEqual({
      track: 'melody',
      startTick: lengthTicks - 960,
      durationTicks: 960,
      midi: 72,
      velocity: 100,
      sourceEventId: 'abutting',
    });
    expect(melodyNotes.map((n) => n.sourceEventId)).not.toContain('beyond');
  });
});

describe('renderProject — harmony patterns', () => {
  it('uses patternOverride over defaultPattern per chord', () => {
    const doc = makeDoc({
      chords: [chord('c1', 0, 3840), chord('c2', 3840, 3840, UP)],
      defaultPattern: BLOCK,
    });
    const playback = renderProject(doc);
    const bySource = (id: string) => playback.notes.filter((n) => n.sourceEventId === id);

    // Default block: all voicing voices together at the chord start.
    const blockNotes = bySource('c1').filter((n) => n.track === 'harmony');
    expect(new Set(blockNotes.map((n) => n.startTick))).toEqual(new Set([0]));

    // Override up: one note per subdivision step.
    const upNotes = bySource('c2').filter((n) => n.track === 'harmony');
    expect(upNotes.length).toBeGreaterThan(4);
    expect(upNotes.map((n) => n.startTick)).toEqual([
      3840, 4320, 4800, 5280, 5760, 6240, 6720, 7200,
    ]);
  });

  it('resolves every harmony note back to a chord event id', () => {
    const doc = makeDoc({
      chords: [chord('c1', 0, 3840), chord('c2', 3840, 3840)],
    });
    const playback = renderProject(doc);
    const ids = new Set(
      playback.notes.filter((n) => n.track === 'harmony').map((n) => n.sourceEventId),
    );

    expect(ids).toEqual(new Set(['c1', 'c2']));
  });
});

describe('renderProject — pipeline finish', () => {
  it('clips notes beyond lengthTicks and drops zero-length remainders', () => {
    const doc = makeDoc({
      bars: 1, // lengthTicks 3840
      melody: [
        { id: 'm1', startTick: 3000, durationTicks: 2000, midi: 72, velocity: 90 },
        { id: 'm2', startTick: 4000, durationTicks: 500, midi: 74, velocity: 90 },
      ],
    });
    const playback = renderProject(doc);

    const m1 = playback.notes.find((n) => n.sourceEventId === 'm1');
    expect(m1).toMatchObject({ startTick: 3000, durationTicks: 840 });
    expect(playback.notes.find((n) => n.sourceEventId === 'm2')).toBeUndefined();
    for (const note of playback.notes) {
      expect(note.startTick + note.durationTicks).toBeLessThanOrEqual(3840);
    }
  });

  it('emits deterministic deep-equal output for identical documents', () => {
    const doc = makeDoc({
      melody: [
        { id: 'm1', startTick: 480, durationTicks: 240, midi: 60, velocity: 90 },
        { id: 'm2', startTick: 480, durationTicks: 240, midi: 64, velocity: 90 },
        { id: 'm3', startTick: 0, durationTicks: 240, midi: 67, velocity: 90 },
      ],
      chords: [chord('c1', 0, 3840)],
    });
    const a = renderProject(doc);
    const b = renderProject(doc);
    expect(a).toEqual(b);
  });

  it('sorts by startTick, harmony-before-melody, then midi', () => {
    const doc = makeDoc({
      melody: [
        { id: 'm2', startTick: 0, durationTicks: 96, midi: 55, velocity: 90 },
        { id: 'm1', startTick: 0, durationTicks: 96, midi: 48, velocity: 90 },
      ],
      chords: [chord('c1', 0, 3840)],
    });
    const playback = renderProject(doc);
    const atZero = playback.notes.filter((n) => n.startTick === 0);

    // Harmony before melody at equal keys.
    expect(atZero[0]).toMatchObject({ track: 'harmony' });
    // Then melody sorted by midi asc despite input order.
    const melodyAtZero = atZero.filter((n) => n.track === 'melody');
    expect(melodyAtZero.map((n) => n.sourceEventId)).toEqual(['m1', 'm2']);

    // Global comparator holds across the whole stream.
    for (let i = 1; i < playback.notes.length; i++) {
      const prev = playback.notes[i - 1]!;
      const curr = playback.notes[i]!;
      expect(
        prev.startTick < curr.startTick ||
          (prev.startTick === curr.startTick &&
            (trackRank(prev.track) < trackRank(curr.track) ||
              prev.midi <= curr.midi)),
      ).toBe(true);
    }
  });
});

describe('renderProject — validation stage (§3.13)', () => {
  it('renders a well-formed document without throwing and with a fully valid stream', () => {
    const doc = makeDoc({
      melody: [{ id: 'm1', startTick: 0, durationTicks: 3840, midi: 72, velocity: 100 }],
      chords: [chord('c1', 0, 3840)],
    });
    const playback = renderProject(doc); // must not throw

    expect(validatePlayback(playback.notes, { lengthTicks: playback.lengthTicks })).toEqual([]);
    // Valid input renders exactly as before validation was added.
    expect(playback.notes).toEqual([
      ...playback.notes.filter((n) => n.track === 'harmony'),
      {
        track: 'melody',
        startTick: 0,
        durationTicks: 3840,
        midi: 72,
        velocity: 100,
        sourceEventId: 'm1',
      },
    ]);
  });

  it('throws PlaybackRenderError carrying the issues for an out-of-range midi value', () => {
    // Reducers reject midi outside [0, 127]; construct directly to reach
    // the renderer's final §3.13 validation stage.
    const doc = makeDoc({
      melody: [{ id: 'm1', startTick: 0, durationTicks: 480, midi: 200, velocity: 100 }],
    });

    expect(() => renderProject(doc)).toThrow(PlaybackRenderError);
    try {
      renderProject(doc);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlaybackRenderError);
      const renderError = error as PlaybackRenderError;
      expect(renderError.issues).toContainEqual({ code: 'midi_range', index: 0 });
      expect(renderError.message).toContain('midi_range@0');
    }
  });
});
