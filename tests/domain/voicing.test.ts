import { describe, expect, it } from 'vitest';

import type { ChordSpec } from '@domain/model/chord';
import {
  DEFAULT_VOICING_PROFILE,
  type ChordEvent,
  type VoicingConstraints,
  type VoicingProfile,
} from '@domain/model/project';
import {
  MAX_CANDIDATES,
  generateCandidates,
} from '@domain/voicing/generateCandidates';
import type { VoicingCandidate } from '@domain/voicing/generateCandidates';
import type { SelectedTone } from '@domain/voicing/selectChordTones';
import { UNMATCHED_PENALTY, matchVoices } from '@domain/voicing/matchVoices';
import { resolveProgressionVoicings } from '@domain/voicing/resolveProgression';
import { scoreTransition } from '@domain/voicing/scoreVoicing';
import { selectChordTones } from '@domain/voicing/selectChordTones';

const spec = (
  templateId: ChordSpec['templateId'],
  letter: 'C' | 'A' | 'G' | 'F' | 'D' | 'E' | 'B' = 'C',
): ChordSpec => ({ root: { letter, accidental: 0 }, templateId });

function event(id: string, chord: ChordSpec): ChordEvent {
  return { id, startTick: 0, durationTicks: 480, chord };
}

/** |mean(notes) − centerMidi| for the register-drift sanity checks. */
function candidateMeanDistance(
  candidate: { midiNotes: number[] },
  profile: VoicingProfile,
): number {
  const mean =
    candidate.midiNotes.reduce((sum, note) => sum + note, 0) /
    candidate.midiNotes.length;
  return Math.abs(mean - profile.centerMidi);
}

describe('selectChordTones', () => {
  it('returns exactly three tones for a simple triad (no root doubling)', () => {
    const tones = selectChordTones(spec('maj'));
    expect(tones).toHaveLength(3);
    expect(tones.map((tone) => tone.role)).toEqual(['root', 'third', 'fifth']);
    expect(new Set(tones.map((tone) => tone.pc)).size).toBe(3);
  });

  it('selects root, third, fifth, seventh for maj7 in degree order', () => {
    const tones = selectChordTones(spec('maj7'));
    expect(tones.map((tone) => tone.role)).toEqual([
      'root',
      'third',
      'fifth',
      'seventh',
    ]);
    expect(tones.map((tone) => tone.pc)).toEqual([0, 4, 7, 11]);
    expect(tones.map((tone) => tone.degree)).toEqual([1, 3, 5, 7]);
  });

  it('selects root, third, seventh, highest extension for a 13 chord (fifth dropped)', () => {
    const tones = selectChordTones(spec('13'));
    expect(tones.map((tone) => tone.role)).toEqual([
      'root',
      'third',
      'seventh',
      'extension',
    ]);
    // 13th above C: (0 + 21) % 12 = 9.
    const extension = tones[3]!;
    expect(extension.degree).toBe(13);
    expect(extension.pc).toBe(9);
    expect(tones.map((tone) => tone.degree)).toEqual([1, 3, 7, 13]);
  });

  it('honors a custom voice limit, dropping the optional fifth first', () => {
    const tones = selectChordTones(spec('maj7'), 3);
    expect(tones.map((tone) => tone.role)).toEqual(['root', 'third', 'seventh']);
  });
});

/** Two-tone probes for the §3.11 filter constants (roles are irrelevant to generation). */
function probeTones(pcs: [number, number] | [number, number, number]): SelectedTone[] {
  return pcs.map((pc, index) => ({
    pc,
    role: index === 0 ? 'root' : 'third',
    degree: index === 0 ? 1 : 3,
  }));
}

function probeProfile(overrides: Partial<VoicingConstraints>): VoicingConstraints {
  const base: VoicingConstraints = {
    lowMidi: 48,
    highMidi: 77,
    maxVoices: 4,
    maxSpanSemitones: 36,
    maxUpperGapSemitones: 24,
    maxBassGapSemitones: 32,
    centerMidi: 60,
  };
  return { ...base, ...overrides };
}

function noteSets(candidates: VoicingCandidate[]): Set<string> {
  return new Set(candidates.map((candidate) => candidate.midiNotes.join(',')));
}

describe('generateCandidates', () => {
  it('produces strictly ascending candidates within profile limits', () => {
    const tones = selectChordTones(spec('maj7'));
    const candidates = generateCandidates(tones, DEFAULT_VOICING_PROFILE);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const notes = candidate.midiNotes;
      expect(notes).toHaveLength(tones.length);
      for (let i = 1; i < notes.length; i++) {
        expect(notes[i]!).toBeGreaterThan(notes[i - 1]!);
        expect(notes[i]! - notes[i - 1]!).toBeLessThanOrEqual(
          i === 1
            ? DEFAULT_VOICING_PROFILE.maxBassGapSemitones
            : DEFAULT_VOICING_PROFILE.maxUpperGapSemitones,
        );
      }
      expect(notes[notes.length - 1]! - notes[0]!).toBeLessThanOrEqual(
        DEFAULT_VOICING_PROFILE.maxSpanSemitones,
      );
      // Voice 0 follows stacking order, so the bass always carries the
      expect(notes[0]! % 12).toBe(0);
      expect(candidate.roles).toEqual(tones.map((tone) => tone.role));
    }
  });

  it('enumerates every octave combination for Cmaj7 (§3.11 literal)', () => {
    const tones = selectChordTones(spec('maj7'));
    const candidates = generateCandidates(tones, DEFAULT_VOICING_PROFILE);
    // Expected winners derived from §3.11-literal enumeration under the
    // default profile (range 43..79, span ≤24, upper gap ≤12, bass gap ≤16):
    // exactly three combinations survive the filters, pre-sorted by
    // |mean − 60| ascending.
    expect(candidates.map((c) => c.midiNotes.join(','))).toEqual([
      '48,64,67,71',
      '60,64,67,71',
      '48,52,55,59',
    ]);
    expect(candidateMeanDistance(candidates[0]!, DEFAULT_VOICING_PROFILE)).toBeCloseTo(2.5);
    expect(candidateMeanDistance(candidates[1]!, DEFAULT_VOICING_PROFILE)).toBeCloseTo(5.5);
    expect(candidateMeanDistance(candidates[2]!, DEFAULT_VOICING_PROFILE)).toBeCloseTo(6.5);
  });

  it('caps output at 256 candidates on a pathological wide-range profile', () => {
    const tones = selectChordTones(spec('maj7'));
    const wide: VoicingConstraints = {
      lowMidi: 0,
      highMidi: 127,
      maxVoices: 4,
      maxSpanSemitones: 200,
      maxUpperGapSemitones: 24,
      maxBassGapSemitones: 36,
      centerMidi: 60,
    };
    const candidates = generateCandidates(tones, wide);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('returns [] when no placement fits the range', () => {
    const tones = selectChordTones(spec('maj7'));
    expect(
      generateCandidates(tones, { ...DEFAULT_VOICING_PROFILE, highMidi: 42 }),
    ).toEqual([]);
  });
  it('keeps a candidate spanning exactly maxSpanSemitones (24) and drops 25 (§3.11)', () => {
    // Same-pc octaves give span-exactly-24 pairs: (48,72) and (60,84).
    const octaves = probeTones([0, 0]);
    const kept = noteSets(generateCandidates(octaves, probeProfile({ highMidi: 85, maxSpanSemitones: 24 })));
    expect(kept.has('48,72')).toBe(true);
    expect(kept.has('60,84')).toBe(true);

    // A semitone-displaced pair reaches span 25: admitted one semitone
    // looser, filtered at exactly 24.
    const shifted = probeTones([0, 1]);
    expect(noteSets(generateCandidates(shifted, probeProfile({ lowMidi: 48, highMidi: 73, maxSpanSemitones: 24 }))).has('48,73')).toBe(false);
    expect(noteSets(generateCandidates(shifted, probeProfile({ lowMidi: 48, highMidi: 73, maxSpanSemitones: 25 }))).has('48,73')).toBe(true);
  });
  it('keeps an upper gap of exactly maxUpperGapSemitones (12) and drops 13 (§3.11)', () => {
    // Same-pc upper voices give an exact-12 upper gap: (48,52,64).
    const octaves = probeTones([0, 4, 4]);
    const kept = noteSets(
      generateCandidates(octaves, probeProfile({ maxUpperGapSemitones: 12 })),
    );
    expect(kept.has('48,52,64')).toBe(true); // upper gap exactly 12 survives

    // A semitone-displaced top voice reaches an upper gap of 13: admitted
    // one semitone looser, filtered at exactly 12.
    const shifted = probeTones([0, 4, 5]); // voice placements: 48/60/72, 52/64/76, 53/65/77
    expect(noteSets(generateCandidates(shifted, probeProfile({ maxUpperGapSemitones: 12 }))).has('48,64,77')).toBe(false);
    expect(noteSets(generateCandidates(shifted, probeProfile({ maxUpperGapSemitones: 13 }))).has('48,64,77')).toBe(true);
  });

  it('keeps a bass gap of exactly maxBassGapSemitones (16) and drops 17 (§3.11)', () => {
    const fifth = probeTones([0, 4]); // [60,76] has a bass gap of exactly 16
    expect(noteSets(generateCandidates(fifth, probeProfile({ maxBassGapSemitones: 16 }))).has('60,76')).toBe(true);
    expect(noteSets(generateCandidates(fifth, probeProfile({ maxBassGapSemitones: 15 }))).has('60,76')).toBe(false);

    const sixth = probeTones([0, 5]); // [60,77] has a bass gap of exactly 17
    expect(noteSets(generateCandidates(sixth, probeProfile({ highMidi: 78, maxBassGapSemitones: 17 }))).has('60,77')).toBe(true);
    expect(noteSets(generateCandidates(sixth, probeProfile({ highMidi: 78, maxBassGapSemitones: 16 }))).has('60,77')).toBe(false);
  });

});

describe('matchVoices', () => {
  it('pairs voices monotonically without crossing on a fixed fixture', () => {
    const { pairs, unmatchedPenalty } = matchVoices(
      [60, 64, 67],
      [62, 65, 69],
    );
    expect(pairs).toEqual([
      { prevIndex: 0, nextIndex: 0, movement: 2 },
      { prevIndex: 1, nextIndex: 1, movement: 1 },
      { prevIndex: 2, nextIndex: 2, movement: 2 },
    ]);
    expect(unmatchedPenalty).toBe(0);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i]!.prevIndex).toBeGreaterThan(pairs[i - 1]!.prevIndex);
      expect(pairs[i]!.nextIndex).toBeGreaterThan(pairs[i - 1]!.nextIndex);
    }
  });

  it('charges UNMATCHED_PENALTY per unmatched voice when counts differ', () => {
    expect(UNMATCHED_PENALTY).toBe(3.0);
    const { pairs, unmatchedPenalty } = matchVoices([60, 64], [62, 65, 69]);
    expect(pairs).toEqual([
      { prevIndex: 0, nextIndex: 0, movement: 2 },
      { prevIndex: 1, nextIndex: 1, movement: 1 },
    ]);
    expect(unmatchedPenalty).toBe(UNMATCHED_PENALTY);
  });

  it('keeps pair indices valid and non-crossing for unsorted inputs', () => {
    const { pairs } = matchVoices([67, 60, 64], [69, 62, 65]);
    const prevIdx = pairs.map((p) => p.prevIndex).sort((a, b) => a - b);
    const nextIdx = pairs.map((p) => p.nextIndex).sort((a, b) => a - b);
    expect(prevIdx).toEqual([0, 1, 2]);
    expect(nextIdx).toEqual([0, 1, 2]);
    // Pairing follows pitch order regardless of input order: every movement
    // is small (the fixture is a near-transposition).
    for (const pair of pairs) {
      expect(pair.movement).toBeGreaterThanOrEqual(0);
      expect(pair.movement).toBeLessThanOrEqual(2.5);
    }
  });
});

describe('scoreTransition', () => {
  const closeRoot: VoicingCandidate = {
    midiNotes: [48, 52, 55],
    roles: ['root', 'third', 'fifth'],
  };
  const spreadThird: VoicingCandidate = {
    midiNotes: [52, 55, 59],
    roles: ['third', 'fifth', 'seventh'],
  };

  it('is finite and lower for root-in-bass close position on the first chord', () => {
    const close = scoreTransition(closeRoot, null, DEFAULT_VOICING_PROFILE);
    const spread = scoreTransition(spreadThird, null, DEFAULT_VOICING_PROFILE);
    expect(Number.isFinite(close)).toBe(true);
    expect(close).toBeLessThan(spread);
  });

  it('rewards common tones over movement', () => {
    const staticCandidate: VoicingCandidate = {
      midiNotes: [48, 52, 55, 59],
      roles: ['root', 'third', 'fifth', 'seventh'],
    };
    const movedCandidate: VoicingCandidate = {
      midiNotes: [50, 53, 57, 60],
      roles: ['root', 'third', 'fifth', 'seventh'],
    };
    const prev = [48, 52, 55, 59];
    expect(
      scoreTransition(staticCandidate, prev, DEFAULT_VOICING_PROFILE),
    ).toBeLessThan(
      scoreTransition(movedCandidate, prev, DEFAULT_VOICING_PROFILE),
    );
  });
});

describe('resolveProgressionVoicings', () => {
  it('resolves a lone Cmaj7 near center register under §3.11-literal enumeration', () => {
    const result = resolveProgressionVoicings([event('c1', spec('maj7'))]);
    expect(result).toHaveLength(1);
    expect(result[0]!.chordEventId).toBe('c1');
    // Derived from §3.11-literal enumeration: the first chord minimizes the
    // first-chord score (root-in-bass bonus + drift + close-position cost),
    // landing on {60,64,67,71} — mean 65.5 beats the old anchored
    // {48,52,55,59} (|mean−60| = 6.5) but not {48,64,67,71} on total score.
    expect(result[0]!.midiNotes).toEqual([60, 64, 67, 71]);
    expect(result[0]!.toneRoles).toEqual(['root', 'third', 'fifth', 'seventh']);
    // First chord keeps the root pc in the bass.
    expect(result[0]!.midiNotes[0]! % 12).toBe(0);
    // Register sanity: chosen mean distance ≤ that of the old low-anchored
    // alternative {48,52,55,59}.
    const chosenDistance = candidateMeanDistance(
      { midiNotes: result[0]!.midiNotes },
      DEFAULT_VOICING_PROFILE,
    );
    expect(chosenDistance).toBeLessThanOrEqual(Math.abs((48 + 52 + 55 + 59) / 4 - 60));
  });

  it('resolves Cmaj7 → Am7 keeping three common tones', () => {
    // Under §3.11-literal enumeration the engine keeps C4/E4/G4 stationary
    // and drops the major seventh over an A2 root bass: {45,60,64,67}.
    const result = resolveProgressionVoicings([
      event('c1', spec('maj7')),
      event('a1', spec('min7', 'A')),
    ]);
    expect(result[0]!.midiNotes).toEqual([60, 64, 67, 71]);
    expect(result[1]!.midiNotes).toEqual([45, 60, 64, 67]);
    const common = result[1]!.midiNotes.filter((note) =>
      result[0]!.midiNotes.includes(note),
    );
    expect(common.length).toBeGreaterThanOrEqual(3);
    expect(result[1]!.midiNotes[0]! % 12).toBe(9); // bass on A, the root
  });

  it('resolves a 13 chord with roles root, third, seventh, extension (pc of the 13th)', () => {
    const result = resolveProgressionVoicings([event('g1', spec('13', 'G'))]);
    expect(result[0]!.toneRoles).toEqual([
      'root',
      'third',
      'seventh',
      'extension',
    ]);
    const notes = result[0]!.midiNotes;
    // G13 selected pcs: 7 (root), 11 (third B), 5 (seventh F), 4 (13th E).
    expect(notes.map((note) => note % 12).sort((a, b) => a - b)).toEqual([
      4, 5, 7, 11,
    ]);
  });

  it('voices a simple triad as exactly three distinct voices without doubling', () => {
    const result = resolveProgressionVoicings([event('c1', spec('maj'))]);
    expect(result[0]!.midiNotes).toHaveLength(3);
    expect(new Set(result[0]!.midiNotes).size).toBe(3);
    expect(result[0]!.toneRoles).toEqual(['root', 'third', 'fifth']);
  });

  it('puts the root pitch class in the bass for a first-chord Cmaj triad', () => {
    const result = resolveProgressionVoicings([event('c1', spec('maj'))]);
    expect(result[0]!.midiNotes[0]! % 12).toBe(0);
    expect(result[0]!.toneRoles[0]).toBe('root');
  });

  it('stays inside the default range 43..79 across a progression', () => {
    const result = resolveProgressionVoicings([
      event('d1', spec('min7', 'D')),
      event('g1', spec('7', 'G')),
      event('c1', spec('maj7')),
      event('f1', spec('maj9', 'F')),
      event('b1', spec('halfDim7', 'B')),
    ]);
    expect(result).toHaveLength(5);
    for (const voicing of result) {
      for (const note of voicing.midiNotes) {
        expect(note).toBeGreaterThanOrEqual(DEFAULT_VOICING_PROFILE.lowMidi);
        expect(note).toBeLessThanOrEqual(DEFAULT_VOICING_PROFILE.highMidi);
      }
    }
  });

  it('is fully deterministic across runs', () => {
    const chords = [
      event('c1', spec('maj7')),
      event('a1', spec('min7', 'A')),
      event('g1', spec('13', 'G')),
      event('e1', spec('min9', 'E')),
    ];
    const first = resolveProgressionVoicings(chords);
    const second = resolveProgressionVoicings(chords);
    expect(first).toEqual(second);
  });

  it('returns [] for empty input', () => {
    expect(resolveProgressionVoicings([])).toEqual([]);
  });

  it('falls back deterministically (no throw) on a degenerate single-note range', () => {
    const degenerate: VoicingProfile = {
      lowMidi: 60,
      highMidi: 60,
      maxVoices: 4,
      maxSpanSemitones: 24,
      maxUpperGapSemitones: 12,
      maxBassGapSemitones: 16,
      centerMidi: 60,
    };
    const chords = [event('c1', spec('maj'))];
    expect(() => resolveProgressionVoicings(chords, degenerate)).not.toThrow();
    const first = resolveProgressionVoicings(chords, degenerate);
    const second = resolveProgressionVoicings(chords, degenerate);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]!.midiNotes.length).toBe(3);
    for (const note of first[0]!.midiNotes) {
      expect(note).toBe(60);
    }
    expect(first[0]!.toneRoles).toEqual(['root', 'third', 'fifth']);
    expect(Number.isFinite(first[0]!.score)).toBe(true);
  });
});
