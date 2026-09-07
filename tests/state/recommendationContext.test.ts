/**
 * §3.12 recommendation context assembly: chords straddling a target-range
 * edge must supply the adjacent-chord context even though they satisfy
 * neither the "ends before" nor the "starts at/after" predicate.
 *
 * Chords live on CHORD_GRID = 960 (one bar); range selections live on
 * NOTE_GRID = 240, so range edges routinely fall inside a bar-long chord.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeStore } from '@app/store';
import { parseSpelled } from '@domain/model/pitch';
import { createProjectDocument } from '@domain/model/project';
import { recommendChords } from '@domain/recommendations/recommendChords';
import { addChordRangeCmd, openProjectCmd } from '@state/commands';
import { createSelectRecommendations } from '@state/selectors';

vi.mock('@domain/recommendations/recommendChords', () => ({
  recommendChords: vi.fn(() => []),
}));

const recommendMock = vi.mocked(recommendChords);

const C = parseSpelled('C')!;
const D = parseSpelled('D')!;
const F = parseSpelled('F')!;
const G = parseSpelled('G')!;
const A = parseSpelled('A')!;

function openedStore() {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 'T', tonic: C, mode: 'ionian' })));
  return store;
}

/** Last RecommendationRequest handed to the engine. */
function lastRequest(): {
  previousChord?: { root: { letter: string }; templateId: string };
  nextChord?: { root: { letter: string }; templateId: string };
} {
  expect(recommendMock.mock.calls.length).toBeGreaterThan(0);
  return recommendMock.mock.calls.at(-1)![0];
}

describe('createSelectRecommendations: straddling-chord context', () => {
  beforeEach(() => {
    recommendMock.mockClear();
  });

  it('chord straddling the range start becomes previousChord', () => {
    const store = openedStore();
    // Chord spans [0, 1920); the target range [960, 1920) starts inside it.
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: 1920, chord: { root: C, templateId: 'maj' } }),
    );

    createSelectRecommendations()(store.getState(), { startTick: 960, durationTicks: 960 });

    expect(lastRequest().previousChord?.root.letter).toBe('C');
  });

  it('chord straddling the range end becomes nextChord', () => {
    const store = openedStore();
    // Chord spans [0, 1920); the target range [960, 1440) ends inside it.
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: 1920, chord: { root: G, templateId: 'maj' } }),
    );

    createSelectRecommendations()(store.getState(), { startTick: 960, durationTicks: 480 });

    expect(lastRequest().nextChord?.root.letter).toBe('G');
  });

  it('straddling chord takes precedence over an earlier strictly-before chord', () => {
    const store = openedStore();
    // Spans [0, 960): ends strictly before the range start 1200.
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: F, templateId: 'maj' } }),
    );
    // Spans [960, 1920): contains the range start 1200.
    store.dispatch(
      addChordRangeCmd({ startTick: 960, durationTicks: 960, chord: { root: C, templateId: 'min7' } }),
    );

    createSelectRecommendations()(store.getState(), { startTick: 1200, durationTicks: 960 });

    const { previousChord } = lastRequest();
    expect(previousChord?.root.letter).toBe('C');
    expect(previousChord?.templateId).toBe('min7');
  });

  it('straddling chord takes precedence over a later strictly-after chord', () => {
    const store = openedStore();
    // Spans [960, 1920): contains the range end 1440.
    store.dispatch(
      addChordRangeCmd({ startTick: 960, durationTicks: 960, chord: { root: G, templateId: 'maj' } }),
    );
    // Starts strictly after the range end 1440.
    store.dispatch(
      addChordRangeCmd({ startTick: 1920, durationTicks: 960, chord: { root: D, templateId: 'maj' } }),
    );

    createSelectRecommendations()(store.getState(), { startTick: 480, durationTicks: 960 });

    const { nextChord } = lastRequest();
    expect(nextChord?.root.letter).toBe('G');
    expect(nextChord?.templateId).toBe('maj');
  });

  it('strict adjacency unchanged: chord ending exactly at range start is previousChord', () => {
    const store = openedStore();
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: F, templateId: 'maj' } }),
    );

    createSelectRecommendations()(store.getState(), { startTick: 960, durationTicks: 960 });

    const { previousChord } = lastRequest();
    expect(previousChord?.root.letter).toBe('F');
    expect(previousChord?.templateId).toBe('maj');
  });

  it('strict adjacency unchanged: chord starting exactly at range end is nextChord', () => {
    const store = openedStore();
    store.dispatch(
      addChordRangeCmd({ startTick: 1920, durationTicks: 960, chord: { root: A, templateId: 'min7' } }),
    );

    createSelectRecommendations()(store.getState(), { startTick: 960, durationTicks: 960 });

    const { nextChord } = lastRequest();
    expect(nextChord?.root.letter).toBe('A');
    expect(nextChord?.templateId).toBe('min7');
  });
});
