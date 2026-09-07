// @vitest-environment jsdom
/**
 * SuggestionPanel component tests (§3.12 UI, §3.16 apply flow).
 *
 * Uses a real configured store (makeStore + openProjectCmd, same as
 * tests/state/editorFlows.test.ts) and the real recommendation engine —
 * deterministic fixtures only. The one exception is a counting pass-through
 * around recommendChords (logic untouched) for the memoization regression.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { SuggestionPanel } from '@features/suggestions/SuggestionPanel';
import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import type * as RecommendChordsModule from '@domain/recommendations/recommendChords';
import type {
  ChordRecommendation,
  RecommendationRequest,
} from '@domain/recommendations/recommendChords';
import { openProjectCmd, selectRangeCmd } from '@state/commands';
import { createSelectRecommendations, selectChords, selectSelection } from '@state/selectors';

// Counting pass-through: the real engine stays in charge (see file header),
// the wrapper only records invocations for the memoization regression test.
const recommendCalls = vi.fn();
vi.mock('@domain/recommendations/recommendChords', async (importOriginal) => {
  // The factory is hoisted above imports: resolve the real implementation
  // here rather than closing over the mocked top-level import binding.
  const actual = await importOriginal<typeof RecommendChordsModule>();
  return {
    ...actual,
    recommendChords: (request: RecommendationRequest): ChordRecommendation[] => {
      recommendCalls(request);
      return actual.recommendChords(request);
    },
  };
});

const C = parseSpelled('C')!;

// One bar on the quarter-note chord grid.
const RANGE = { startTick: 0, durationTicks: 3840 };

function renderPanel(mode: 'ionian' | 'locrian' = 'ionian') {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 'Test', tonic: C, mode })));
  store.dispatch(selectRangeCmd(RANGE.startTick, RANGE.durationTicks));
  const utils = render(
    <Provider store={store}>
      <SuggestionPanel />
    </Provider>,
  );
  return { store, ...utils };
}

describe('SuggestionPanel', () => {
  it('renders category cards from real recommendChords output for C ionian', () => {
    const { store } = renderPanel();

    const expected = createSelectRecommendations()(store.getState(), RANGE);
    expect(expected.length).toBeGreaterThanOrEqual(1);

    // Every engine card appears with its category label and roman numeral.
    for (const recommendation of expected) {
      expect(screen.getByText(recommendation.romanNumeral)).toBeTruthy();
    }
    // C ionian with empty history yields all four categories (§3.12 fixtures).
    expect(screen.getByText('Безопасно')).toBeTruthy();
    expect(screen.getByText('Плавно')).toBeTruthy();
    expect(screen.getByText('Сильно')).toBeTruthy();
    expect(screen.getByText('Колор')).toBeTruthy();

    // Russian reason strings surface on the cards.
    const panelText = screen.getByTestId('suggestion-panel').textContent ?? '';
    // §3.12: numeric scores never reach the UI (chord symbols like "C7"
    // legitimately contain digits, so pin the actual score values instead).
    for (const recommendation of expected) {
      const renderedScore = recommendation.score.toFixed(2);
      expect(panelText).not.toContain(renderedScore);
    }
    expect(panelText).not.toMatch(/[01]\.\d/);
  });

  it('does not re-run the engine on unrelated store updates (memoized targetRange)', () => {
    const { store } = renderPanel();
    const afterRender = recommendCalls.mock.calls.length;
    expect(afterRender).toBeGreaterThanOrEqual(1);

    // An unrelated store update (viewport scroll) must hit the reselect
    // cache, not re-run the §3.12 engine.
    act(() => {
      store.dispatch({ type: 'session/viewportChanged', payload: { scrollTick: 480 } });
    });
    expect(recommendCalls.mock.calls.length).toBe(afterRender);
  });

  it('clicking a card applies addChordRangeCmd over the range and collapses the panel', async () => {
    const user = userEvent.setup();
    const { store } = renderPanel();

    const expected = createSelectRecommendations()(store.getState(), RANGE);
    const first = expected[0]!;

    await user.click(screen.getByText('Безопасно').closest('button')!);

    const chords = selectChords(store.getState());
    expect(chords).toHaveLength(1);
    expect(chords[0]).toMatchObject({
      startTick: RANGE.startTick,
      durationTicks: RANGE.durationTicks,
      chord: { root: first.chord.root, templateId: first.chord.templateId },
    });

    // Selection cleared → panel gone (§3.16 apply flow).
    expect(selectSelection(store.getState())).toBeNull();
    expect(screen.queryByTestId('suggestion-panel')).toBeNull();
  });

  it('opens the full ChordPicker from a range selection and applies into it', async () => {
    const user = userEvent.setup();
    const { store } = renderPanel();

    expect(screen.queryByTestId('chord-picker')).toBeNull();
    await user.click(screen.getByTestId('open-chord-picker'));
    expect(screen.getByTestId('chord-picker')).toBeTruthy();

    // Picker is in create mode (no chord id): apply writes addChordRangeCmd
    // over the current range selection with the default draft (tonic maj).
    await user.click(screen.getByTestId('picker-apply'));

    const chords = selectChords(store.getState());
    expect(chords).toHaveLength(1);
    expect(chords[0]).toMatchObject({
      startTick: RANGE.startTick,
      durationTicks: RANGE.durationTicks,
      chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
    });
  });

  it('a successful create-mode picker apply clears the range selection so the panel collapses', async () => {
    const user = userEvent.setup();
    const { store } = renderPanel();

    await user.click(screen.getByTestId('open-chord-picker'));
    expect(selectSelection(store.getState())?.kind).toBe('range');
    await user.click(screen.getByTestId('picker-apply'));

    // Same post-apply contract as the recommendation cards: onApplied →
    // clearSelectionCmd → panel unmounts (§3.16).
    expect(selectChords(store.getState())).toHaveLength(1);
    expect(selectSelection(store.getState())).toBeNull();
    expect(screen.queryByTestId('suggestion-panel')).toBeNull();
    expect(screen.queryByTestId('chord-picker')).toBeNull();
  });

  it('omits the color card in a colorless context (locrian) without a placeholder', () => {
    renderPanel('locrian');

    expect(screen.getByText('Безопасно')).toBeTruthy();
    expect(screen.queryByText('Колор')).toBeNull();
    expect(screen.queryByText(/Колор/i)).toBeNull();
    expect(screen.queryByText('Нет предложений для этого контекста')).toBeNull();
  });

  it('shows the empty-context text when recommendations are empty', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian' })));
    store.dispatch(selectRangeCmd(0, 0)); // degenerate range → no suggestions
    render(
      <Provider store={store}>
        <SuggestionPanel />
      </Provider>,
    );

    expect(screen.getByTestId('suggestion-panel')).toBeTruthy();
    expect(screen.getByText('Нет предложений для этого контекста')).toBeTruthy();
  });

  it('renders nothing without a range selection', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian' })));
    render(
      <Provider store={store}>
        <SuggestionPanel />
      </Provider>,
    );

    expect(screen.queryByTestId('suggestion-panel')).toBeNull();
    expect(selectSelection(store.getState())).toBeNull();
  });

  // SGP-H3: the §3.12 header affordance — title, click-to-add hint and the
  // matching aria-label — present whenever a range selection is active.
  it('shows the header title and click-to-add hint whenever a range selection is active', () => {
    renderPanel();

    expect(screen.getByText('Предложения гармонии')).toBeTruthy();
    expect(
      screen.getByText('Нажмите на карточку, чтобы добавить аккорд в выделенный диапазон'),
    ).toBeTruthy();
    expect(screen.getByTestId('suggestion-panel').getAttribute('aria-label')).toBe(
      'Предложения гармонии',
    );
  });
});
