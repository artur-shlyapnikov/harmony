/**
 * Recommendation engine tests (§3.12).
 *
 * Covers: generic contract invariants over the curated HARMONY_CASES
 * fixtures, category/reason/breakdown pins, pool construction caps,
 * repetition handling, determinism, and metricWeight units.
 */

import { describe, expect, it } from 'vitest';

import { pitchClassOf, parseSpelled } from '@domain/model/pitch';
import type { ChordSpec, ChordTemplateId } from '@domain/model/chord';
import { buildCandidatePool, MAX_POOL_SIZE } from '@domain/recommendations/candidatePool';
import {
  computeRepetitionPenalty,
  computeTotal,
  scoreTransitionFrom,
  type ChordRecommendation,
  type RecommendationRequest,
} from '@domain/recommendations/scoring';
import { metricWeight, scoreMelodyCompatibility } from '@domain/recommendations/melodyScore';
import { recommendChords } from '@domain/recommendations/recommendChords';
import type { ResolvedVoicing } from '@domain/voicing/resolveProgression';
import { HARMONY_CASES, type HarmonyCase } from '../fixtures/harmonyCases';

function requestOf(c: HarmonyCase): RecommendationRequest {
  return {
    context: c.context,
    targetRange: { startTick: 0, durationTicks: 3840 },
    ...(c.previousChord !== undefined && { previousChord: c.previousChord }),
    recentChords: c.recentChords,
    melodyNotes: c.melodyNotes,
    complexity: c.complexity,
  };
}

const specKey = (spec: ChordSpec): string =>
  `${pitchClassOf(spec.root)}:${spec.templateId}`;

const C_IONIAN: HarmonyContextSeed = { tonic: parseSpelled('C')!, mode: 'ionian' };

const PC_TO_NAME: readonly string[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
type HarmonyContextSeed = RecommendationRequest['context'];

const baseRequest = (): RecommendationRequest => ({
  context: C_IONIAN,
  targetRange: { startTick: 0, durationTicks: 3840 },
  recentChords: [],
  melodyNotes: [],
  complexity: 'basic',
});

describe('recommendChords — contract invariants over fixtures', () => {
  for (const testCase of HARMONY_CASES) {
    describe(testCase.name, () => {
      const request = requestOf(testCase);
      const cards = recommendChords(request);
      const pool = buildCandidatePool(request);

      it('returns between 1 and 4 cards', () => {
        expect(cards.length).toBeGreaterThanOrEqual(1);
        expect(cards.length).toBeLessThanOrEqual(4);
      });

      it('assigns unique categories in canonical order', () => {
        const categories = cards.map((card) => card.category);
        expect(new Set(categories).size).toBe(categories.length);
        const canonicalOrder = ['safe', 'smooth', 'strong', 'color'];
        const positions = categories.map((category) => canonicalOrder.indexOf(category));
        const sorted = [...positions].sort((a, b) => a - b);
        expect(positions).toEqual(sorted);
      });

      it('never reuses a chord across categories', () => {
        const keys = cards.map((card) => specKey(card.chord));
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('always carries 1–2 non-empty reasons', () => {
        for (const card of cards) {
          expect(card.reasons.length).toBeGreaterThanOrEqual(1);
          expect(card.reasons.length).toBeLessThanOrEqual(2);
          for (const reason of card.reasons) {
            expect(reason.length).toBeGreaterThan(0);
          }
        }
      });

      it('keeps every breakdown component within [-1, 1]', () => {
        for (const card of cards) {
          for (const value of Object.values(card.scoreBreakdown)) {
            expect(value).toBeGreaterThanOrEqual(-1);
            expect(value).toBeLessThanOrEqual(1);
          }
          expect(card.score).toBeGreaterThanOrEqual(-1.16); // − max penalty
        }
      });

      it('matches the §3.12 total formula exactly', () => {
        for (const card of cards) {
          const recomputed = computeTotal(card.scoreBreakdown);
          expect(Math.abs(card.score - recomputed)).toBeLessThan(1e-9);
        }
      });

      it('honors expectNoColor', () => {
        if (testCase.expectNoColor) {
          expect(cards.some((card) => card.category === 'color')).toBe(false);
        }
      });

      it('honors expectContains across suggestions and pool', () => {
        if (!testCase.expectContains) return;
        const available = new Set<string>([
          ...cards.map((card) => specKey(card.chord)),
          ...pool.map(specKey),
        ]);
        for (const expected of testCase.expectContains) {
          expect(available.has(`${expected.rootPc}:${expected.templateId}`)).toBe(true);
        }
      });

      it('honors expectRomanInSuggestions', () => {
        if (!testCase.expectRomanInSuggestions) return;
        for (const roman of testCase.expectRomanInSuggestions) {
          expect(
            cards.some((card) => card.romanNumeral.startsWith(roman)),
          ).toBe(true);
        }
      });
    });
  }
});

describe('pinned behaviors', () => {
  it('ii–V–I: a dominant (roman numeral starting with V) is suggested', () => {
    const testCase = HARMONY_CASES[0]!;
    const cards = recommendChords(requestOf(testCase));
    // §3.12 forbids reusing a chord across categories, so when the V7 chord
    // itself is the top-ranked safe card the strong slot goes to the next
    // candidate; the pin asserts the dominant family is surfaced at all.
    const dominantCard = cards.find((card) => card.romanNumeral.startsWith('V'));
    expect(dominantCard).toBeDefined();
    expect(
      dominantCard!.category === 'safe' || dominantCard!.category === 'strong',
    ).toBe(true);
  });

  it('melody case: melody component still ranks chord-tone pairs on top', () => {
    const testCase = HARMONY_CASES[1]!; // F4/A4 over Dm7 target
    const request = requestOf(testCase);
    const cards = recommendChords(request);

    // §3.21 anchors empty-project hints on the tonic chord, so C-root cards
    // gain the transition bonus; the melody component still dominates within
    // that anchored field — the best card carries a near-perfect melody
    // score for the F4+A4 chord-tone pair.
    const bestMelody = Math.max(...cards.map((card) => card.scoreBreakdown.melody));
    expect(bestMelody).toBeGreaterThan(0.9);

    // The Dm7 candidate itself scores a perfect melody component.
    const dm7: ChordSpec = { root: parseSpelled('D')!, templateId: 'min7' };
    expect(scoreMelodyCompatibility(dm7, request)).toBeCloseTo(1, 12);

  });

  it('Aeolian pool contains the E7 major dominant', () => {
    const testCase = HARMONY_CASES[2]!;
    const pool = buildCandidatePool(requestOf(testCase));
    expect(
      pool.some(
        (spec) => pitchClassOf(spec.root) === 4 && spec.templateId === '7',
      ),
    ).toBe(true);
  });

  it('Locrian rich yields no color card', () => {
    const testCase = HARMONY_CASES[7]!;
    const cards = recommendChords(requestOf(testCase));
    expect(cards.every((card) => card.category !== 'color')).toBe(true);
  });

  it('repetition: exact previous chord falls out of suggestions entirely', () => {
    // Empty history — C major is the safe card.
    const emptyRun = recommendChords(baseRequest());
    const emptySafe = emptyRun.find((card) => card.category === 'safe');
    expect(emptySafe).toBeDefined();
    expect(pitchClassOf(emptySafe!.chord.root)).toBe(0);
    expect(emptySafe!.chord.templateId).toBe('maj');

    // Same request but the previous chord was exactly C major.
    const repeatRun = recommendChords({
      ...baseRequest(),
      recentChords: [{ root: parseSpelled('C')!, templateId: 'maj' }],
    });
    expect(
      repeatRun.some(
        (card) => pitchClassOf(card.chord.root) === 0 && card.chord.templateId === 'maj',
      ),
    ).toBe(false);

    // Penalty unit pins.
    const cmaj: ChordSpec = { root: parseSpelled('C')!, templateId: 'maj' };
    const gmaj: ChordSpec = { root: parseSpelled('G')!, templateId: 'maj' };
    const gmin: ChordSpec = { root: parseSpelled('G')!, templateId: 'min' };
    expect(computeRepetitionPenalty(cmaj, [cmaj])).toBe(0.15);
    expect(computeRepetitionPenalty(gmin, [gmaj])).toBe(0.08);
    expect(computeRepetitionPenalty(gmin, [gmaj, gmaj])).toBe(0.08);
    expect(computeRepetitionPenalty(cmaj, [gmaj])).toBe(0);
    expect(computeRepetitionPenalty(cmaj, [])).toBe(0);
  });

  it('repetition penalty surfaces as a negative breakdown field', () => {
    // Bb4 is a chord tone of C7 and a chromatic clash for everything else,
    // making C7 the color card in both runs. Adding {C,maj} to the recent
    // history puts C within the last two roots and must drop C7's total by
    // exactly 0.08 via breakdown.repetition.
    const withMelody = {
      ...baseRequest(),
      melodyNotes: [
        { id: 'n-bb4', startTick: 0, durationTicks: 1920, midi: 70, velocity: 100 },
      ],
    };
    const emptyRun = recommendChords(withMelody);
    const repeatRun = recommendChords({
      ...withMelody,
      recentChords: [{ root: parseSpelled('C')!, templateId: 'maj' }],
    });
    // Safe is legitimately omitted here (the clash fails the melody floor),
    // so C7 may surface under any category; find it by chord identity.
    const emptyColor = emptyRun.find(
      (card) => pitchClassOf(card.chord.root) === 0 && card.chord.templateId === '7',
    );
    const repeatColor = repeatRun.find(
      (card) => pitchClassOf(card.chord.root) === 0 && card.chord.templateId === '7',
    );

    expect(emptyColor!.scoreBreakdown.repetition).toBeCloseTo(0, 12);
    expect(repeatColor!.scoreBreakdown.repetition).toBe(-0.08);
  });

  it('basic ionian pool is exactly 19 candidates; rich stays within cap', () => {
    expect(buildCandidatePool(baseRequest()).length).toBe(19);
    const richPool = buildCandidatePool({ ...baseRequest(), complexity: 'rich' });
    expect(richPool.length).toBeLessThanOrEqual(MAX_POOL_SIZE);
    expect(richPool.length).toBeGreaterThan(19);
  });

  it('is deterministic across double runs for every fixture', () => {
    for (const testCase of HARMONY_CASES) {
      const request = requestOf(testCase);
      const first = recommendChords(request);
      const second = recommendChords(request);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
});

describe('metricWeight', () => {
  it.each([
    [0, 1.5], // beat 1
    [3840, 1.5], // wraps per bar
    [960, 1.0], // beat 2
    [1920, 1.25], // beat 3
    [2880, 1.0], // beat 4
    [480, 0.5], // offbeat
    [1200, 0.5], // offbeat
  ])('tick %i → %f', (tick, expected) => {
    expect(metricWeight(tick)).toBe(expected);
  });
});

describe('recommendChords — hardening sweep (§5 risk-1)', () => {
  it('fixture set spans ≥60 contexts covering all 7 modes', () => {
    expect(HARMONY_CASES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(HARMONY_CASES.map((c) => c.context.mode)).size).toBe(7);
  });

  for (const testCase of HARMONY_CASES) {
    it(`sweep: ${testCase.name}`, () => {
      const request = requestOf(testCase);
      const attempt = (): { cards?: ChordRecommendation[]; error?: unknown } => {
        try {
          return { cards: recommendChords(request) };
        } catch (error) {
          return { error };
        }
      };

      const firstRun = attempt();
      expect(firstRun.error).toBeUndefined();
      const cards = firstRun.cards ?? [];

      // ≤4 cards, categories unique.
      expect(cards.length).toBeLessThanOrEqual(4);
      const categories = cards.map((card) => card.category);
      expect(new Set(categories).size).toBe(categories.length);

      for (const card of cards) {
        // Reasons: non-empty, ≤2, no numeric scores leaked into prose.
        expect(card.reasons.length).toBeGreaterThanOrEqual(1);
        expect(card.reasons.length).toBeLessThanOrEqual(2);
        for (const reason of card.reasons) {
          expect(reason.length).toBeGreaterThan(0);
          expect(reason).not.toMatch(/\d/);
        }
        // Breakdown fields within [-1, 1].
        for (const value of Object.values(card.scoreBreakdown)) {
          expect(value).toBeGreaterThanOrEqual(-1);
          expect(value).toBeLessThanOrEqual(1);
        }
      }

      // Safe-card melody component stays above the −0.3 clash floor.
      const safe = cards.find((card) => card.category === 'safe');
      if (safe !== undefined) {
        expect(safe.scoreBreakdown.melody).toBeGreaterThan(-0.3);
      }

      // Determinism: a second identical call deep-equals the first.
      expect(attempt().cards).toEqual(cards);
    });
  }
});

describe('audit fixes — §3.12/§3.21 conformance', () => {
  const specOf = (name: string, templateId: ChordTemplateId): ChordSpec => ({
    root: parseSpelled(name)!,
    templateId,
  });

  it('rich pool adds sus2/sus4 on diatonic minor roots unconditionally (§3.12)', () => {
    // C ionian: ii root D (pc 2). Previously sus2 was dorian-only on minor
    // roots; the spec lists sus2/sus4 without conditions.
    const richPool = buildCandidatePool({ ...baseRequest(), complexity: 'rich' });
    expect(
      richPool.some((s) => pitchClassOf(s.root) === 2 && s.templateId === 'sus2'),
    ).toBe(true);
    expect(
      richPool.some((s) => pitchClassOf(s.root) === 2 && s.templateId === 'sus4'),
    ).toBe(true);

    // Dorian keeps its sus2 coverage (no regression).
    const dorianRich = buildCandidatePool({
      context: { tonic: parseSpelled('C')!, mode: 'dorian' },
      targetRange: { startTick: 0, durationTicks: 3840 },
      recentChords: [],
      melodyNotes: [],
      complexity: 'rich',
    });
    expect(
      dorianRich.some((s) => pitchClassOf(s.root) === 0 && s.templateId === 'sus2'),
    ).toBe(true);
  });

  it('strong category admits secondary dominants with top transition weight', () => {
    // Previous IV (predominant): every dominant-function candidate ties at
    // the 0.8 predominant→dominant weight. The F#5 melody is a chord tone of
    // V/V (D7) and V/iii (B7) but a chromatic clash for every diatonic
    // candidate, so the secondary dominants outrank G/G7 in total order and
    // must be eligible for the strong slot (rootDegree === null no longer
    // disqualifies).
    const cards = recommendChords({
      ...baseRequest(),
      previousChord: specOf('F', 'maj'),
      melodyNotes: [
        { id: 'n-fs5', startTick: 0, durationTicks: 1920, midi: 78, velocity: 100 },
      ],
    });
    const strong = cards.find((card) => card.category === 'strong');
    expect(strong).toBeDefined();
    const strongKey = `${pitchClassOf(strong!.chord.root)}:${strong!.chord.templateId}`;
    expect(['2:7', '11:7']).toContain(strongKey); // V/V (D7) or V/iii (B7)
  });

  it('strong category is omitted when no candidate has a functional profile (§3.12)', () => {
    // D dorian: modal profiles assign only tonic/modal functions and flat
    // transition weights (≤0.4), so no candidate carries a functional or
    // cadential transition profile — the strong card must be omitted
    // instead of being filled with a non-functional option.
    const cards = recommendChords({
      context: { tonic: parseSpelled('D')!, mode: 'dorian' },
      targetRange: { startTick: 0, durationTicks: 3840 },
      previousChord: specOf('D', 'min7'),
      recentChords: [specOf('D', 'min7')],
      melodyNotes: [],
      complexity: 'basic',
    });
    expect(cards.some((card) => card.category === 'strong')).toBe(false);
    // The rest of the pipeline still yields suggestions.
    expect(cards.length).toBeGreaterThanOrEqual(1);
  });

  describe('scoreTransitionFrom — empty-project tonic anchoring (§3.21)', () => {
    const context = baseRequest().context;

    it('tonic chord scores above neutral start freedom', () => {
      expect(scoreTransitionFrom(undefined, specOf('C', 'maj'), context)).toBeCloseTo(0.85, 12);
    });

    it('other tonic-function degrees keep the functional bonus only', () => {
      // vi (A min) is tonic-function but its root is not the tonic pc.
      expect(scoreTransitionFrom(undefined, specOf('A', 'min'), context)).toBeCloseTo(0.7, 12);
    });

    it('non-tonic candidates stay at the neutral value', () => {
      expect(scoreTransitionFrom(undefined, specOf('G', 'maj'), context)).toBeCloseTo(0.5, 12);
    });

    it('anchored values stay deterministic and within [-1, 1]', () => {
      for (let pc = 0; pc < 12; pc += 1) {
        const spelling = PC_TO_NAME[pc]!;
        for (const templateId of ['maj', 'min', 'dim', '7'] as const) {
          const score = scoreTransitionFrom(
            undefined,
            { root: parseSpelled(spelling)!, templateId },
            context,
          );
          expect(score).toBeGreaterThanOrEqual(-1);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    });
  });
});

describe('melody reason pairs the note name with its own span (§3.12)', () => {
  it('names the chord-tone note, not the earliest overlapping note', () => {
    // D4 is a scale tone of C major and starts before E4, which is a chord
    // tone (the third). Both notes overlap the target range; the §3.12
    // melody reason must name E with the third label taken from E's own
    // span — never D with a borrowed interval.
    const request: RecommendationRequest = {
      ...baseRequest(),
      melodyNotes: [
        { id: 'n-d4', startTick: 120, durationTicks: 480, midi: 62, velocity: 100 },
        { id: 'n-e4', startTick: 240, durationTicks: 1920, midi: 64, velocity: 100 },
      ],
    };
    const cards = recommendChords(request);

    const cmajIndex = cards.findIndex(
      (card) => pitchClassOf(card.chord.root) === 0 && card.chord.templateId === 'maj',
    );
    expect(cmajIndex).toBeGreaterThanOrEqual(0);
    expect(cmajIndex).toBeLessThan(2); // surfaces within the first two cards
    const cmaj = cards[cmajIndex]!;
    expect(cmaj.scoreBreakdown.melody).toBeGreaterThanOrEqual(0.3);
    expect(cmaj.reasons).toContain('Мелодическая нота E является терцией');
  });
});

describe('melody onset multiplier (§3.12 ×1.2 at the new-chord onset)', () => {
  it('weights a chord tone sounding exactly at the placement start by an extra ×1.2', () => {
    // Candidate C major; E4 is the third (+1.0), F#4 a chromatic clash
    // (−0.8) on beat 3 (weight 1.25). With the §3.12 onset bonus the E4
    // weight is 1.5 × 1.2 = 1.8:
    //   expected = (1.8·1.0 + 1.25·(−0.8)) / (1.8 + 1.25) = 0.8 / 3.05.
    // Without the bonus the value would be (1.5 − 1) / 2.75 ≈ 0.1818 — the
    // exact pin below fails if ONSET_BONUS ever drifts from 1.2.
    const request: RecommendationRequest = {
      ...baseRequest(),
      melodyNotes: [
        { id: 'n-onset', startTick: 0, durationTicks: 960, midi: 64, velocity: 100 },
        { id: 'n-clash', startTick: 1920, durationTicks: 960, midi: 66, velocity: 100 },
      ],
    };

    const score = scoreMelodyCompatibility({ root: parseSpelled('C')!, templateId: 'maj' }, request);
    expect(score).toBeCloseTo(0.8 / 3.05, 12);
  });
});


describe('chromatic clash weight is decision-relevant (§3.12 −0.8)', () => {
  const cmaj: ChordSpec = { root: parseSpelled('C')!, templateId: 'maj' };
  const dmaj: ChordSpec = { root: parseSpelled('D')!, templateId: 'maj' };
  const noteAt = (id: string, midi: number): RecommendationRequest['melodyNotes'][number] => ({
    id,
    startTick: 0,
    durationTicks: 960,
    midi,
    velocity: 100,
  });

  it('a chromatic-clash candidate loses to an otherwise-equal chord-tone candidate; removing the clash flips the ranking', () => {
    // F#4 over C ionian: a chromatic clash for C major, but the third of
    // D major. Every other breakdown term is identical by construction —
    // the single note is the only differing input.
    const clashRequest: RecommendationRequest = {
      ...baseRequest(),
      melodyNotes: [noteAt('n-fs4', 66)],
    };
    const clashScores = {
      cmaj: scoreMelodyCompatibility(cmaj, clashRequest),
      dmaj: scoreMelodyCompatibility(dmaj, clashRequest),
    };
    expect(clashScores.cmaj).toBeCloseTo(-0.8, 12);
    expect(clashScores.dmaj).toBeCloseTo(1, 12);
    expect(clashScores.dmaj).toBeGreaterThan(clashScores.cmaj);

    // Removing the clash (G4: chord tone of C, mere scale tone of D) flips
    // the winner — proving the −0.8 weight is decision-relevant.
    const cleanRequest: RecommendationRequest = {
      ...baseRequest(),
      melodyNotes: [noteAt('n-g4', 67)],
    };
    const cleanScores = {
      cmaj: scoreMelodyCompatibility(cmaj, cleanRequest),
      dmaj: scoreMelodyCompatibility(dmaj, cleanRequest),
    };
    expect(cleanScores.cmaj).toBeCloseTo(1, 12);
    expect(cleanScores.cmaj).toBeGreaterThan(cleanScores.dmaj);
  });
});

describe('smooth category assignment (§3.12 category table)', () => {
  /** Dm7 as the previous voicing: D3 F#-free close position D3 F3 A3 C4. */
  const previousVoicing: ResolvedVoicing = {
    chordEventId: 'prev',
    midiNotes: [50, 54, 57, 60],
    toneRoles: ['root', 'third', 'fifth', 'seventh'],
    score: 0,
  };

  it('the smooth card wraps the best voice-leading candidate from the eligible pool, with the smooth transition reason', () => {
    const request: RecommendationRequest = {
      ...baseRequest(),
      previousChord: { root: parseSpelled('D')!, templateId: 'min7' },
    };
    const cards = recommendChords(request, previousVoicing);

    const smooth = cards.find((card) => card.category === 'smooth');
    expect(smooth).toBeDefined();
    // The smooth slot carries the maximum voice-leading breakdown among the
    // returned cards and the dedicated §3.12 transition reason string.
    const maxVoiceLeading = Math.max(...cards.map((card) => card.scoreBreakdown.voiceLeading));
    expect(smooth!.scoreBreakdown.voiceLeading).toBe(maxVoiceLeading);
    expect(smooth!.scoreBreakdown.voiceLeading).toBeGreaterThan(0);
    expect(smooth!.reasons).toContain(
      'Плавный функциональный переход от предыдущего аккорда',
    );
    // Category assignment stays unique and canonical for this pool.
    const categories = cards.map((card) => card.category);
    expect(new Set(categories).size).toBe(categories.length);
    // Pinned shape of the crafted pool: the D7 secondary dominant wins the
    // smooth slot; safe/strong/color keep their picks. scoreVoiceLeading is
    // clamped to [-1, 1], so the repeated Dm7 (inflated >1 unclamped, minus
    // the immediate-repetition penalty) loses the safe slot to diatonic Bm7b5.
    const cardByCategory = new Map(cards.map((card) => [card.category, card]));
    expect(specKey(cardByCategory.get('safe')!.chord)).toBe('11:halfDim7');
    expect(specKey(cardByCategory.get('smooth')!.chord)).toBe('2:7');
    expect(cardByCategory.get('strong')).toBeDefined();
    expect(cardByCategory.get('color')).toBeDefined();
});
});
