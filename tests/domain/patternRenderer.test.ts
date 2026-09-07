import { describe, expect, it } from 'vitest';

import type { ChordSpec } from '@domain/model/chord';
import type { NoteLetter } from '@domain/model/pitch';
import type { PatternSpec } from '@domain/model/pattern';
import type { ChordEvent } from '@domain/model/project';
import { DEFAULT_VOICING_PROFILE } from '@domain/model/project';
import type { ResolvedVoicing } from '@domain/voicing/resolveProgression';
import { renderPattern } from '@domain/render/patternRenderer';

/** Cmaj7 close position: root, third, fifth, seventh. */
const CMAJ7: ResolvedVoicing = {
  chordEventId: 'c1',
  midiNotes: [48, 52, 55, 59],
  toneRoles: ['root', 'third', 'fifth', 'seventh'],
  score: 0,
};

const PROFILE = DEFAULT_VOICING_PROFILE; // lowMidi 43, highMidi 79

function makeCase(
  rootLetter: NoteLetter,
  templateId: ChordSpec['templateId'],
  durationTicks = 3840,
  overrides?: Partial<PatternSpec>,
): { chord: ChordEvent; pattern: PatternSpec } {
  const pattern: PatternSpec = {
    kind: 'block',
    subdivisionTicks: 480,
    gate: 0.9,
    octaveSpan: 1,
    velocity: 80,
    ...overrides,
  };
  const chord: ChordEvent = {
    id: 'c1',
    startTick: 0,
    durationTicks,
    chord: { root: { letter: rootLetter, accidental: 0 }, templateId },
  };
  return { chord, pattern };
}

function midis(notes: ReturnType<typeof renderPattern>): number[] {
  return notes.map((note) => note.midi);
}

describe('renderPattern — block', () => {
  it('renders all voicing notes together at gate-scaled chord duration', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, { kind: 'block' });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(notes).toHaveLength(4);
    expect(notes.map((n) => n.startTick)).toEqual([0, 0, 0, 0]);
    expect(notes.map((n) => n.durationTicks)).toEqual([3456, 3456, 3456, 3456]);
    expect(midis(notes)).toEqual([48, 52, 55, 59]);
  });
  it('with gate=1 ends exactly at the chord-event end, never past it (§3.13 note-off boundary)', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, { kind: 'block', gate: 1 });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(notes).toHaveLength(4);
    for (const note of notes) {
      // Integer arithmetic: startTick + durationTicks === chord end exactly.
      expect(note.startTick + note.durationTicks).toBe(chord.startTick + chord.durationTicks);
      expect(note.durationTicks).toBe(3840);
    }
  });
});

describe('renderPattern — up / down', () => {
  it('cycles ascending one note per subdivision', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, { kind: 'up' });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(notes.map((n) => n.startTick)).toEqual([
      0, 480, 960, 1440, 1920, 2400, 2880, 3360,
    ]);
    expect(midis(notes)).toEqual([48, 52, 55, 59, 48, 52, 55, 59]);
    for (const note of notes) expect(note.durationTicks).toBe(432);
  });

  it('cycles descending from the top note', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, { kind: 'down' });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(midis(notes)).toEqual([59, 55, 52, 48, 59, 55, 52, 48]);
    expect(notes.map((n) => n.startTick)).toEqual([
      0, 480, 960, 1440, 1920, 2400, 2880, 3360,
    ]);
  });

  it('clips the last step to the chord end', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 1000, { kind: 'up' });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    // Steps at 0, 480 and 960 all start before the chord end.
    expect(notes).toHaveLength(3);
    expect(notes[2]).toMatchObject({ startTick: 960, durationTicks: 40 });
  });
});

describe('renderPattern — upDown', () => {
  it('never doubles extremes at the direction change', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, { kind: 'upDown' });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    // cycle indices 0,1,2,3,2,1 | 0,1 over [48,52,55,59]
    expect(midis(notes)).toEqual([48, 52, 55, 59, 55, 52, 48, 52]);
    expect(notes.map((n) => n.startTick)).toEqual([
      0, 480, 960, 1440, 1920, 2400, 2880, 3360,
    ]);
  });

  it('degrades gracefully on a single-note voicing', () => {
    const single: ResolvedVoicing = {
      ...CMAJ7,
      midiNotes: [48],
      toneRoles: ['root'],
    };
    const { chord, pattern } = makeCase('C', 'maj', 1920, { kind: 'upDown' });
    const notes = renderPattern(single, chord, pattern, PROFILE);

    expect(midis(notes)).toEqual([48, 48, 48, 48]);
  });

  it('cycles 0,1 without doubling extremes for a two-note voicing', () => {
    const pair: ResolvedVoicing = {
      ...CMAJ7,
      midiNotes: [48, 55],
      toneRoles: ['root', 'fifth'],
    };
    const { chord, pattern } = makeCase('C', 'maj', 1920, { kind: 'upDown' });
    const notes = renderPattern(pair, chord, pattern, PROFILE);

    expect(midis(notes)).toEqual([48, 55, 48, 55]);
  });
});

describe('renderPattern — bassChord', () => {
  it('places bass on beat starts and remaining voices on the second eighth', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, {
      kind: 'bassChord',
    });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    // Bass at every beat start.
    expect(
      notes.filter((n) => n.midi === 48).map((n) => n.startTick),
    ).toEqual([0, 960, 1920, 2880]);
    // Upper voices at +480 of every beat.
    for (const midi of [52, 55, 59]) {
      expect(
        notes.filter((n) => n.midi === midi).map((n) => n.startTick),
      ).toEqual([480, 1440, 2400, 3360]);
    }
    for (const note of notes) expect(note.durationTicks).toBe(432);
  });

  it('falls back to block when subdivision is a quarter', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, {
      kind: 'bassChord',
      subdivisionTicks: 960,
    });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(notes).toHaveLength(4);
    expect(notes.map((n) => n.startTick)).toEqual([0, 0, 0, 0]);
    expect(notes.map((n) => n.durationTicks)).toEqual([3456, 3456, 3456, 3456]);
  });
});

describe('renderPattern — oneFiveThreeFive', () => {
  it('cycles root → fifth → third → fifth through toneRoles', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, {
      kind: 'oneFiveThreeFive',
    });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(midis(notes)).toEqual([48, 55, 52, 55, 48, 55, 52, 55]);
    expect(notes.map((n) => n.startTick)).toEqual([
      0, 480, 960, 1440, 1920, 2400, 2880, 3360,
    ]);
    for (const note of notes) expect(note.durationTicks).toBe(432);
  });

  it('substitutes suspension when the third is absent', () => {
    const sus4: ResolvedVoicing = {
      ...CMAJ7,
      midiNotes: [48, 50, 55],
      toneRoles: ['root', 'suspension', 'fifth'],
    };
    const { chord, pattern } = makeCase('C', 'sus4', 3840, {
      kind: 'oneFiveThreeFive',
    });
    const notes = renderPattern(sus4, chord, pattern, PROFILE);

    // root → fifth → suspension → fifth
    expect(midis(notes)).toEqual([48, 55, 50, 55, 48, 55, 50, 55]);
  });
});

describe('renderPattern — octaveSpan 2', () => {
  it('adds in-range +12 copies into the sequenced set before ordering', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, {
      kind: 'up',
      octaveSpan: 2,
    });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    // Set: 48,52,55,59 + copies 60,64,67,71 (all inside [43,79]).
    expect(midis(notes.slice(0, 8))).toEqual([
      48, 52, 55, 59, 60, 64, 67, 71,
    ]);
  });

  it('ignores octaveSpan for block', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, {
      kind: 'block',
      octaveSpan: 2,
    });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(midis(notes)).toEqual([48, 52, 55, 59]);
  });

  it('drops copies outside the profile range', () => {
    const tightProfile = { ...PROFILE, highMidi: 63 };
    const { chord, pattern } = makeCase('C', 'maj7', 3840, {
      kind: 'up',
      octaveSpan: 2,
    });
    const notes = renderPattern(CMAJ7, chord, pattern, tightProfile);

    // Only copy 60 fits under highMidi 63; 64, 67, 71 exceed it.
    expect(midis(notes.slice(0, 5))).toEqual([48, 52, 55, 59, 60]);
  });
  it('upDown with span 2 sequences BOTH octave copies without doubling an extreme across the copy boundary', () => {
    // 12 steps over the 8-note set so the turnaround happens INSIDE the
    // sequenced run — the 59→60 copy boundary and the 71→67 turn are both
    // exercised (a 3840-tick chord would only produce the ascending half).
    const { chord, pattern } = makeCase('C', 'maj7', 5760, {
      kind: 'upDown',
      octaveSpan: 2,
    });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);
    const sequence = midis(notes);

    // Base set plus in-range +12 copies are all present.
    for (const midi of [48, 52, 55, 59, 60, 64, 67, 71]) {
      expect(sequence).toContain(midi);
    }
    // Every note stays inside the voicing profile [43, 79].
    for (const midi of sequence) {
      expect(midi).toBeGreaterThanOrEqual(PROFILE.lowMidi);
      expect(midi).toBeLessThanOrEqual(PROFILE.highMidi);
    }
    // Hard invariant: the upDown no-doubling property holds across the
    // whole sequence, including the octave-copy turnaround.
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]).not.toBe(sequence[i - 1]);
    }
    // Pinned concrete sequence: indices 0..7 then back down over
    // [48,52,55,59,60,64,67,71] (HIST-D17 style pin of the real output).
    expect(sequence).toEqual([48, 52, 55, 59, 60, 64, 67, 71, 67, 64, 60, 59]);
  });
});


describe('renderPattern — note identity', () => {
  it('propagates pattern velocity and chord id on every note', () => {
    const { chord, pattern } = makeCase('C', 'maj7', 3840, {
      kind: 'up',
      velocity: 64,
    });
    const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.track).toBe('harmony');
      expect(note.velocity).toBe(64);
      expect(note.sourceEventId).toBe(chord.id);
    }
  });
});

// Round 6 (PROP-P2, §2/§4 of local://test-design-6.md): same LCG discipline
// as PROP-F1 — Math.imul integer stream per seed, no Math.random/Date.now,
// failure messages carry the seed and the full spec JSON for reproduction.
describe('property: seeded spec sweep', () => {
  it('every rendered note stays inside the chord span and profile, carries the pattern velocity/source, and upDown never repeats a midi (seeds 0–199)', () => {
    const kinds: PatternSpec['kind'][] = ['up', 'down', 'upDown', 'block', 'bassChord'];

    for (let seed = 0; seed < 200; seed += 1) {
      let s = seed >>> 0;
      const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);

      const kind = kinds[Math.floor(rnd() * kinds.length)]!;
      const subdivisionTicks = ([240, 480, 960] as const)[Math.floor(rnd() * 3)]!;
      // Rounded to 3 decimals so it always stays inside [0.1, 1].
      const gate = Math.round((0.1 + rnd() * 0.9) * 1000) / 1000;
      const octaveSpan: 1 | 2 = rnd() < 0.5 ? 1 : 2;
      const velocity = 1 + Math.floor(rnd() * 127); // §3.4 canonical 1..127
      const durationTicks = 240 * (1 + Math.floor(rnd() * 16)); // 1..16 grid cells
      const { chord, pattern } = makeCase('C', 'maj7', durationTicks, {
        kind,
        subdivisionTicks,
        gate,
        octaveSpan,
        velocity,
      });
      const specJson = JSON.stringify({ durationTicks, pattern });

      const notes = renderPattern(CMAJ7, chord, pattern, PROFILE);

      // (1) A legal spec never renders silence into a non-empty chord.
      expect(notes.length, `seed ${seed}: silence for ${specJson}`).toBeGreaterThan(0);

      for (const note of notes) {
        expect(
          note.track,
          `seed ${seed}: wrong track (${note.track}) for ${specJson}`,
        ).toBe('harmony');
        expect(note.sourceEventId, `seed ${seed}: wrong source id for ${specJson}`).toBe(chord.id);
        expect(
          note.velocity,
          `seed ${seed}: velocity passthrough broke for ${specJson}`,
        ).toBe(velocity);
        expect(
          note.startTick,
          `seed ${seed}: note starts before the chord for ${specJson}`,
        ).toBeGreaterThanOrEqual(chord.startTick);
        expect(
          note.durationTicks,
          `seed ${seed}: non-positive duration for ${specJson}: ${JSON.stringify(note)}`,
        ).toBeGreaterThan(0);
        expect(
          note.startTick + note.durationTicks,
          `seed ${seed}: note escapes the chord span for ${specJson}: ${JSON.stringify(note)}`,
        ).toBeLessThanOrEqual(chord.startTick + chord.durationTicks);
        expect(
          note.midi,
          `seed ${seed}: midi below profile floor for ${specJson}: ${JSON.stringify(note)}`,
        ).toBeGreaterThanOrEqual(PROFILE.lowMidi);
        expect(
          note.midi,
          `seed ${seed}: midi above profile ceiling for ${specJson}: ${JSON.stringify(note)}`,
        ).toBeLessThanOrEqual(PROFILE.highMidi);
      }

      if (kind === 'upDown') {
        for (let i = 1; i < notes.length; i += 1) {
          expect(
            notes[i]!.midi,
            `seed ${seed}: upDown repeats midi ${notes[i]!.midi} at index ${i} for ${specJson}`,
          ).not.toBe(notes[i - 1]!.midi);
        }
      }
    }
  });
});
