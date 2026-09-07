// @vitest-environment jsdom
/**
 * SuggestionPanel apply-gate regression (§3.16 apply flow).
 *
 * addChordRangeCmd returns false when the MAX_CHORD_EVENTS projection rejects
 * the add (after an error toast). In that case nothing was applied, so the
 * panel MUST NOT dispatch clearSelectionCmd(): that would destroy the user's
 * range selection and unmount the panel with no chord added.
 *
 * The command module is stubbed at the boundary (the cap-rejection path is
 * covered by state-level tests); everything else — store, engine, reducers,
 * selectors — stays real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { SuggestionPanel } from '@features/suggestions/SuggestionPanel';
import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { openProjectCmd, selectRangeCmd } from '@state/commands';
import { selectSelection } from '@state/selectors';

// Hoisted so the vi.mock factory (lifted above imports) can reach it.
const gates = vi.hoisted(() => ({
  // What the stubbed addChordRangeCmd thunk resolves to.
  applyResult: true,
  // Records every clearSelectionCmd() dispatch.
  clearCalls: 0,
  // document.activeElement captured INSIDE the clearSelectionCmd stub.
  focusAtClear: null as Element | null,
}));

vi.mock('@state/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@state/commands')>();
  return {
    ...actual,
    // Counting stub over the range-add: resolves via `gates.applyResult`
    // (true = applied, false = rejected at the chord cap).
    addChordRangeCmd:
      (() =>
        () =>
          gates.applyResult) as unknown as typeof actual.addChordRangeCmd,
    clearSelectionCmd: (() => {
      gates.clearCalls += 1;
      gates.focusAtClear = document.activeElement;
      return actual.clearSelectionCmd();
    }) as typeof actual.clearSelectionCmd,
  };
});

const C = parseSpelled('C')!;

function renderPanel() {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 'Test', tonic: C, mode: 'ionian' })));
  store.dispatch(selectRangeCmd(0, 3840));
  render(
    <Provider store={store}>
      {/* Persistent post-apply focus target (ChordLane in the editor). */}
      <div data-testid="chord-lane" tabIndex={-1} />
      <SuggestionPanel />
    </Provider>,
  );
  return store;
}

describe('SuggestionPanel apply gate', () => {
  beforeEach(() => {
    gates.applyResult = true;
    gates.clearCalls = 0;
    gates.focusAtClear = null;
  });

  it('does NOT clear the selection when addChordRangeCmd rejects (chord cap)', async () => {
    const user = userEvent.setup();
    const store = renderPanel();
    gates.applyResult = false;

    expect(screen.getByText('Безопасно')).toBeTruthy();
    await user.click(screen.getByText('Безопасно').closest('button')!);

    // Rejected add → selection preserved, panel stays mounted.
    expect(gates.clearCalls).toBe(0);
    expect(selectSelection(store.getState())?.kind).toBe('range');
    expect(screen.getByTestId('suggestion-panel')).toBeTruthy();
  });

  it('still clears the selection on the success path', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByText('Безопасно').closest('button')!);

    expect(gates.clearCalls).toBe(1);
    expect(screen.queryByTestId('suggestion-panel')).toBeNull();
  });

  it('moves focus to the persistent harmony lane BEFORE the clear dispatch (no body drop)', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByText('Безопасно').closest('button')!);

    expect(gates.clearCalls).toBe(1);
    // Focus was already on the persistent chord lane when the selection
    // cleared — not on the card button that was about to unmount.
    const anchor = gates.focusAtClear as HTMLElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('data-testid')).toBe('chord-lane');
    expect(anchor).not.toBe(document.body);
  });
});
