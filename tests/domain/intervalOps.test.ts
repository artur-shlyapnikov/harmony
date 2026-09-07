import { describe, expect, it } from 'vitest';

import { clampTick, quantizeDuration, quantizeTick } from '@domain/timeline/quantize';
import {
  type IntervalEvent,
  mergeAdjacentIdenticalChords,
  replaceRange,
  sortEvents,
  trimEventsBeyond,
} from '@domain/timeline/intervalOps';
import {
  checkChordInvariants,
  checkMelodyInvariants,
  type InvariantViolation,
} from '@domain/timeline/invariants';
import type { ChordEvent } from '@domain/model/project';
import { CHORD_GRID, NOTE_GRID } from '@domain/timeline/constants';

// Beats are 960 ticks; the §3.7 diagram case: old note beats 1–4, insert beat 2–3.
const BEAT = 960;

let idCounter = 0;
const nextId = (): string => `gen-${(idCounter += 1)}`;

function note(id: string, startBeat: number, durationBeats: number): IntervalEvent & { kind: 'note' } {
  return {
    id,
    startTick: startBeat * BEAT,
    durationTicks: durationBeats * BEAT,
    kind: 'note',
  };
}

function chord(
  id: string,
  startBeat: number,
  durationBeats: number,
  overrides?: Partial<ChordEvent>,
): ChordEvent {
  return {
    id,
    startTick: startBeat * BEAT,
    durationTicks: durationBeats * BEAT,
    chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
    ...overrides,
  };
}

describe('quantize', () => {
  it('floors ticks to the grid and clamps at zero', () => {
    expect(quantizeTick(NOTE_GRID + 10, NOTE_GRID)).toBe(NOTE_GRID);
    expect(quantizeTick(-5, NOTE_GRID)).toBe(0);
    expect(quantizeTick(BEAT, BEAT)).toBe(BEAT);
  });

  it('floors durations to the grid with a one-step minimum', () => {
    expect(quantizeDuration(2 * NOTE_GRID - 1, NOTE_GRID)).toBe(NOTE_GRID);
    expect(quantizeDuration(0, NOTE_GRID)).toBe(NOTE_GRID);
    expect(quantizeDuration(3 * NOTE_GRID, NOTE_GRID)).toBe(3 * NOTE_GRID);
  });

  it('clamps ticks into the range', () => {
    expect(clampTick(-10, 0, 100)).toBe(0);
    expect(clampTick(50, 0, 100)).toBe(50);
    expect(clampTick(500, 0, 100)).toBe(100);
  });
});

describe('replaceRange', () => {
  it('splits a spanning note into left/new/right with three distinct ids', () => {
    // Old note beats 1–4; replacement inserted beats 2–3.
    const result = replaceRange([note('old', 1, 3)], { start: 2 * BEAT, end: 3 * BEAT }, note('new', 2, 1), nextId);

    expect(result.map((event) => [event.startTick, event.durationTicks])).toEqual([
      [BEAT, BEAT],
      [2 * BEAT, BEAT],
      [3 * BEAT, BEAT],
    ]);
    const ids = result.map((event) => event.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain('old');
  });

  it('removes exactly covered events and keeps the rest untouched', () => {
    const before = note('a', 0, 1);
    const covered = note('b', 1, 1);
    const after = note('c', 2, 1);
    const result = replaceRange([before, covered, after], { start: BEAT, end: 2 * BEAT }, null, nextId);

    expect(result.map((event) => event.id)).toEqual(['a', 'c']);
    expect(result[0]).toBe(before);
    expect(result[1]).toBe(after);
  });

  it('leaves events in gaps untouched', () => {
    const first = note('a', 0, 1);
    const second = note('b', 3, 1);
    const result = replaceRange([first, second], { start: BEAT, end: 2 * BEAT }, note('new', 1, 1), nextId);

    expect(result.map((event) => event.id)).toEqual(['a', 'new', 'b']);
    expect(result[0]).toBe(first);
    expect(result[2]).toBe(second);
  });

  it('replaces two partial events with one replacement', () => {
    // Two adjacent notes covering beats 0–2; replacement covers the middle of both.
    const result = replaceRange([note('a', 0, 1), note('b', 1, 1)], { start: BEAT / 2, end: 3 * (BEAT / 2) }, note('new', 0.5, 1), nextId);

    expect(result.map((event) => [event.id === 'a', event.startTick, event.durationTicks])).toEqual([
      [false, 0, BEAT / 2],
      [false, BEAT / 2, BEAT],
      [false, 3 * (BEAT / 2), BEAT / 2],
    ]);
    // Left fragment, replacement, right fragment — all distinct ids.
    expect(new Set(result.map((event) => event.id)).size).toBe(3);
  });

  it('returns sorted unchanged events for an empty range', () => {
    const unsorted = [note('b', 1, 1), note('a', 0, 1)];
    const result = replaceRange(unsorted, { start: BEAT, end: BEAT }, null, nextId);
    expect(result.map((event) => event.id)).toEqual(['a', 'b']);
    expect(result).not.toBe(unsorted);
  });
  it('leaves an event ending exactly at start untouched (§3.7 strict overlap)', () => {
    const abutting = note('abut', 0, 1); // ends exactly at range start
    const result = replaceRange([abutting], { start: BEAT, end: 2 * BEAT }, note('new', 1, 1), nextId);

    // «пересекающие» = strict overlap: zero-width contact is not overlap.
    expect(result[0]).toBe(abutting);
    expect(result.map((event) => event.id)).toEqual(['abut', 'new']);
    expect(checkMelodyInvariants(result, { lengthTicks: 8 * BEAT })).toEqual([]);
  });
  it('leaves an event starting exactly at end untouched (§3.7 half-open range)', () => {
    const abutting = note('abut', 2, 1); // starts exactly at range end
    const result = replaceRange([note('covered', 1, 1), abutting], { start: BEAT, end: 2 * BEAT }, note('new', 1, 1), nextId);

    expect(result[result.length - 1]).toBe(abutting);
    expect(result.map((event) => event.id)).toEqual(['new', 'abut']);
    expect(checkMelodyInvariants(result, { lengthTicks: 8 * BEAT })).toEqual([]);
  });

});

describe('mergeAdjacentIdenticalChords', () => {
  it('merges contiguous identical chords keeping the earlier id', () => {
    const merged = mergeAdjacentIdenticalChords([chord('first', 0, 1), chord('second', 1, 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('first');
    expect(merged[0]!.startTick).toBe(0);
    expect(merged[0]!.durationTicks).toBe(2 * BEAT);
  });

  it('does not merge chords with different specs', () => {
    const minor = chord('a', 0, 1, { chord: { root: { letter: 'A', accidental: 0 }, templateId: 'min' } });
    const major = chord('b', 1, 1);
    expect(mergeAdjacentIdenticalChords([minor, major])).toHaveLength(2);
  });

  it('treats patternOverride equality as mergeable and inequality as not', () => {
    const pattern = { kind: 'up' as const, subdivisionTicks: 240 as const, gate: 0.8, octaveSpan: 1 as const, velocity: 80 };
    const withOverrideA = chord('a', 0, 1, { patternOverride: pattern });
    const withOverrideB = chord('b', 1, 1, { patternOverride: pattern });
    const withOtherOverride = chord('b', 1, 1, { patternOverride: { ...pattern, gate: 0.9 } });

    const same = mergeAdjacentIdenticalChords([withOverrideA, withOverrideB]);
    expect(same).toHaveLength(1);
    expect(same[0]!.durationTicks).toBe(2 * BEAT);

    const different = mergeAdjacentIdenticalChords([withOverrideA, withOtherOverride]);
    expect(different).toHaveLength(2);
  });

  it('never merges across a gap or when only one side has an override', () => {
    const gapped = mergeAdjacentIdenticalChords([chord('a', 0, 1), chord('b', 2, 1)]);
    expect(gapped).toHaveLength(2);

    const overrideMismatch = mergeAdjacentIdenticalChords([
      chord('a', 0, 1),
      chord('b', 1, 1, { patternOverride: { kind: 'block', subdivisionTicks: 480, gate: 0.9, octaveSpan: 1, velocity: 80 } }),
    ]);
    expect(overrideMismatch).toHaveLength(2);
  });
});

describe('trimEventsBeyond', () => {
  it('clips crossing events with their original id, drops beyond-length events', () => {
    const lengthTicks = 4 * BEAT;
    const kept = note('kept', 0, 1);
    const crossing = note('crossing', 3, 2);
    const beyond = note('beyond', 5, 1);
    const trimmed = trimEventsBeyond([kept, crossing, beyond], lengthTicks);

    expect(trimmed.map((event) => [event.id, event.startTick, event.durationTicks])).toEqual([
      ['kept', 0, BEAT],
      ['crossing', 3 * BEAT, BEAT],
    ]);
    expect(trimmed[1]!.startTick + trimmed[1]!.durationTicks).toBe(lengthTicks);
  });

  it('preserves input order when clipping (§3.7 step 7 sort stability)', () => {
    const lengthTicks = 2 * BEAT;
    const first = note('first', 1, 2);
    const second = note('second', 0, 3);
    const third = note('third', 0, 1);
    const trimmed = trimEventsBeyond([first, second, third], lengthTicks);

    expect(trimmed.map((event) => event.id)).toEqual(['first', 'second', 'third']);
    expect(trimmed.map((event) => [event.startTick, event.durationTicks])).toEqual([
      [BEAT, BEAT],
      [0, 2 * BEAT],
      [0, BEAT],
    ]);
  });
  it('keeps an event whose end equals the length limit intact (§3.4)', () => {
    const lengthTicks = 4 * BEAT;
    const exact = note('exact', 3, 1); // ends exactly at lengthTicks

    // «события не выходят за lengthTicks»: touching the limit is not exceeding it.
    const trimmed = trimEventsBeyond([exact], lengthTicks);
    expect(trimmed).toEqual([exact]);
    expect(trimmed[0]!.id).toBe('exact');
    expect(trimmed[0]!.startTick + trimmed[0]!.durationTicks).toBe(lengthTicks);
    // Reference identity: a surviving event is kept by reference, not
    // re-clipped into a value-equal copy.
    expect(trimmed[0]).toBe(exact);
  });

});

describe('sortEvents', () => {
  it('sorts by startTick then id without mutating the input', () => {
    const input = [note('b', 0, 1), note('a', 1, 1), note('a0', 0, 1)];
    const sorted = sortEvents(input);
    expect(sorted.map((event) => `${event.id}@${event.startTick}`)).toEqual(['a0@0', 'b@0', 'a@960']);
    expect(input[0]!.id).toBe('b');
  });
});

describe('checkMelodyInvariants', () => {
  const ctx = { lengthTicks: 8 * BEAT };
  const codesOf = (notes: IntervalEvent[]): string[] =>
    checkMelodyInvariants(notes, ctx).map((violation: InvariantViolation) => violation.code);

  it('accepts valid sorted notes', () => {
    expect(codesOf([note('a', 0, 1), note('b', 1, 1)])).toEqual([]);
  });

  it('reports negative_start', () => {
    const violations = checkMelodyInvariants([{ ...note('a', 0, 1), startTick: -NOTE_GRID }], ctx);
    expect(violations.map((v) => v.code)).toContain('negative_start');
  });

  it('reports zero_duration', () => {
    const violations = checkMelodyInvariants([{ ...note('a', 0, 1), durationTicks: 0 }], ctx);
    expect(violations.map((v) => v.code)).toContain('zero_duration');
  });

  it('reports non_integer', () => {
    const violations = checkMelodyInvariants([{ ...note('a', 0, 1), startTick: 0.5 }], ctx);
    expect(violations.map((v) => v.code)).toContain('non_integer');
  });

  it('reports grid_melody for off-grid melody ticks but accepts on-grid', () => {
    expect(checkMelodyInvariants([note('a', 0, 0.25)], ctx)).toEqual([]);
    expect(codesOf([{ ...note('a', 0, 1), durationTicks: NOTE_GRID + 1 }])).toContain('grid_melody');
  });

  it('reports out_of_bounds', () => {
    const violations = checkMelodyInvariants([note('a', 7, 2)], ctx);
    expect(violations.map((v) => v.code)).toContain('out_of_bounds');
  });

  it('reports overlap for intersecting neighbors', () => {
    const violations = checkMelodyInvariants([note('a', 0, 2), note('b', 1, 1)], ctx);
    expect(violations.map((v) => v.code)).toContain('overlap');
    expect(violations.find((v) => v.code === 'overlap')!.index).toBe(1);
  });

  it('reports unsorted order including id tiebreak', () => {
    expect(codesOf([note('b', 1, 1), note('a', 0, 1)])).toContain('unsorted');
    expect(codesOf([note('a', 0, 1), note('z', 0, 1)])).toEqual(['overlap']);
  });

  it('reports unsorted AND overlap together for an out-of-order overlapping pair', () => {
    // b starts after a, so the pair is unsorted; b's end still overlaps a.
    const codes = codesOf([note('b', 2, 1), note('a', 0, 3)]);
    expect(codes).toContain('unsorted');
    expect(codes).toContain('overlap');
  });

  // Round-5 mutation audit (INV-D1): a fractional duration must surface as
  // non_integer INDEPENDENTLY of the grid check (a fractional duration can
  // never be an exact grid multiple, so the two codes legitimately co-occur);
  // an off-grid START with on-grid duration is grid_melody only; and the
  // unsorted check's id tiebreak fires for descending ids at equal starts.
  it('distinguishes non-integer durations from off-grid starts, and pins the unsorted id tiebreak', () => {
    const codes = codesOf([{ ...note('a', 0, 1), durationTicks: 240.5 }]);
    expect(codes).toContain('non_integer');
    expect(codes).not.toContain('zero_duration');

    expect(codesOf([{ ...note('a', 0, 1), startTick: 100 }])).toEqual(['grid_melody']);

    // Equal starts, DESCENDING ids: wholesale deletion of the pair check is
    // already killed above — this row kills deleting only the id tiebreak.
    expect(codesOf([note('z', 0, 1), note('a', 0, 1)])).toContain('unsorted');
  });

  // INV-B2: «события не выходят за lengthTicks» is inclusive — ending
  // exactly AT the limit is accepted, not reported out_of_bounds.
  it('accepts an event ending exactly at lengthTicks (boundary inclusivity)', () => {
    expect(codesOf([note('edge', 7, 1)])).toEqual([]);
  });

  // §3.4 pitch/velocity ride on events the sweep reads via
  // Partial<MelodyNoteEvent>: fixtures spread them onto plain note() output.
  const pitchedNote = (
    id: string,
    startBeat: number,
    durationBeats: number,
    pitch: { midi?: number; velocity?: number },
  ): IntervalEvent => ({ ...note(id, startBeat, durationBeats), ...pitch });

  // INV-P1: §3.4 «нота несёт каноническую высоту» — the bad_midi code,
  // offending index and detail are pinned directly, not transitively.
  it.each([
    ['below minimum (35)', 35],
    ['above maximum (97)', 97],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('reports bad_midi for a(n) %s pitch', (_label, midi) => {
    const violations = checkMelodyInvariants(
      [note('ok', 0, 1), pitchedNote('m', 2, 1, { midi })],
      ctx,
    );

    // Exactly one violation, pinned at the offending event's position.
    expect(violations).toEqual([{ code: 'bad_midi', index: 1, detail: 'id=m' }]);
  });

  it('accepts the exact bad_midi boundaries 36..96', () => {
    expect(codesOf([
      pitchedNote('lo', 0, 1, { midi: 36 }),
      pitchedNote('hi', 2, 1, { midi: 96 }),
    ])).toEqual([]);
  });

  // INV-P2: §3.4 canonical velocity bounds — bad_velocity is reported
  // independently of bad_midi (two separate pushes in the same sweep).
  it.each([
    ['zero (0)', 0],
    ['above maximum (128)', 128],
    ['NaN', Number.NaN],
  ])('reports bad_velocity for a(n) %s velocity without bad_midi', (_label, velocity) => {
    expect(codesOf([note('ok', 0, 1), pitchedNote('v', 2, 1, { velocity })])).toEqual([
      'bad_velocity',
    ]);
  });

  it('reports both bad_midi and bad_velocity for one doubly-bad note', () => {
    const violations = checkMelodyInvariants(
      [pitchedNote('m', 0, 1, { midi: 200, velocity: 0 })],
      ctx,
    );

    // Both codes fire for the same event, in sweep order.
    expect(violations.map((violation) => violation.code)).toEqual(['bad_midi', 'bad_velocity']);
  });

  it('accepts the exact bad_velocity boundaries 1..127', () => {
    expect(codesOf([
      pitchedNote('min', 0, 1, { velocity: 1 }),
      pitchedNote('max', 2, 1, { velocity: 127 }),
    ])).toEqual([]);
  });
});

describe('checkChordInvariants', () => {
  const ctx = { lengthTicks: 8 * BEAT };

  it('accepts quarter-aligned chords', () => {
    expect(checkChordInvariants([chord('a', 0, 1), chord('b', 1, 1)], ctx)).toEqual([]);
  });

  it('reports grid_chord for off-grid chord ticks', () => {
    const violations = checkChordInvariants([{ ...chord('a', 0, 1), durationTicks: CHORD_GRID / 2 }], ctx);
    expect(violations.map((v) => v.code)).toContain('grid_chord');
  });

  it('reports overlap between chord events', () => {
    const violations = checkChordInvariants([chord('a', 0, 2), chord('b', 1, 1)], ctx);
    expect(violations.map((v) => v.code)).toContain('overlap');
  });
});

// Round 6 (PROP-F1, §2/§4 of local://test-design-6.md): zero-dep seeded
// composition fuzz. One inline Math.imul LCG per seed — no Math.random, no
// Date.now; every failure message embeds the seed and offending JSON so any
// failing seed reproduces byte-for-byte (§4.3). The generator emits
// NON-OVERLAPPING NOTE_GRID-aligned arrangements (§4.2: overlapping inputs
// would make the checkMelodyInvariants oracle unsound) — the fuzz adds
// ARRANGEMENT diversity, not overlap semantics.
describe('property: seeded composition fuzz', () => {
  const ctx = { lengthTicks: 8 * BEAT };
  const codesOf = (notes: IntervalEvent[]): string[] =>
    checkMelodyInvariants(notes, ctx).map((violation: InvariantViolation) => violation.code);

  it('sort→replaceRange→trim keeps every generated arrangement invariant-clean, sorted, and input-untouched (seeds 0–99)', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      let s = seed >>> 0;
      const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);

      // Arrange: cursor-style non-overlapping events on the melody grid.
      // Durations/gaps are NOTE_GRID multiples so grid_melody can never fire.
      const input: IntervalEvent[] = [];
      let cursor = [0, NOTE_GRID, 2 * NOTE_GRID][Math.floor(rnd() * 3)]!;
      for (let i = 0; i < 12; i += 1) {
        const duration = NOTE_GRID * (1 + Math.floor(rnd() * 4)); // 240..960
        if (cursor + duration > ctx.lengthTicks) break;
        input.push({ id: `f${i}`, startTick: cursor, durationTicks: duration });
        cursor += duration + NOTE_GRID * Math.floor(rnd() * 3); // gap 0|240|480
        if (cursor >= ctx.lengthTicks) break;
      }
      const snapshot = JSON.stringify(input);

      const rangeCells = 1 + Math.floor(rnd() * 6); // 1..6 grid cells wide
      const range = {
        start: NOTE_GRID * Math.floor(rnd() * (ctx.lengthTicks / NOTE_GRID)),
        end: 0,
      };
      range.end = range.start + rangeCells * NOTE_GRID;

      // Replacement lives strictly inside [range.start, range.end), so it can
      // never collide with the fragments kept at either range edge.
      let replacement: IntervalEvent | null = null;
      if (rnd() < 0.5) {
        const offsetCells = Math.floor(rnd() * rangeCells);
        replacement = {
          id: `frag-${seed}-r`,
          startTick: range.start + offsetCells * NOTE_GRID,
          durationTicks: NOTE_GRID * (1 + Math.floor(rnd() * (rangeCells - offsetCells))),
        };
      }

      let fragN = 0;
      const fragId = (): string => `frag-${seed}-${(fragN += 1)}`;

      // Act.
      const sorted = sortEvents(input);
      const replaced = replaceRange(sorted, range, replacement, fragId);
      const limit = rnd() < 0.5 ? 4 * BEAT : ctx.lengthTicks;
      const trimmed = trimEventsBeyond(replaced, limit);

      // Assert — each message carries the seed (and inputs) for reproduction.
      expect(JSON.stringify(input), `seed ${seed}: input mutated`).toBe(snapshot);

      for (let i = 1; i < trimmed.length; i += 1) {
        const prev = trimmed[i - 1]!;
        const cur = trimmed[i]!;
        expect(
          prev.startTick < cur.startTick ||
            (prev.startTick === cur.startTick && prev.id < cur.id),
          `seed ${seed}: trimmed not sorted at index ${i}: ${JSON.stringify(trimmed)}`,
        ).toBe(true);
      }

      expect(
        codesOf(trimmed),
        `seed ${seed}: invariants ${JSON.stringify(codesOf(trimmed))} for ${JSON.stringify(trimmed)}`,
      ).toEqual([]);

      // Identity IS the contract here (round-5 §5.2 precedent): every event
      // lying entirely outside the range survives replaceRange by reference.
      for (const original of sorted) {
        const outside =
          original.startTick >= range.end ||
          original.startTick + original.durationTicks <= range.start;
        if (!outside) continue;
        expect(
          replaced.some((kept) => kept === original),
          `seed ${seed}: untouched event ${JSON.stringify(original)} lost identity through range ${JSON.stringify(range)} (input ${snapshot})`,
        ).toBe(true);
      }

      for (const kept of trimmed) {
        expect(
          kept.startTick >= 0 && kept.startTick + kept.durationTicks <= limit,
          `seed ${seed}: event ${JSON.stringify(kept)} crosses trim limit ${limit}`,
        ).toBe(true);
      }
    }
  });
});
