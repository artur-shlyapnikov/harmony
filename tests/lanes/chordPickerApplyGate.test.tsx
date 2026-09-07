// @vitest-environment jsdom
/**
 * ChordPicker apply-gate regression (§3.16/§3.20/§3.21).
 *
 * setChordSpecCmd / addChordRangeCmd return false when the ProjectEditor
 * rejects the edit (e.g. the MAX_CHORD_EVENTS chord cap). In that case
 * NOTHING was applied, so the picker MUST NOT close: closing would destroy
 * the user's drafted root/family/template spec together with their target
 * range selection.
 *
 * The command module is stubbed at the boundary (the cap-rejection path is
 * covered by state-level tests); everything else — store, reducers,
 * selectors — stays real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { ChordPicker } from '@features/chords/ChordPicker';
import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { openProjectCmd, selectRangeCmd } from '@state/commands';
import { selectSelection } from '@state/selectors';

// Hoisted so the vi.mock factory (lifted above imports) can reach it.
const gates = vi.hoisted(() => ({
  // What the stubbed add/set thunks resolve to.
  applyResult: true,
}));

vi.mock('@state/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@state/commands')>();
  const gated =
    () =>
    () =>
      gates.applyResult;
  return {
    ...actual,
    addChordRangeCmd: gated as unknown as typeof actual.addChordRangeCmd,
    setChordSpecCmd: gated as unknown as typeof actual.setChordSpecCmd,
  };
});

const C = parseSpelled('C')!;

function setup(editingChordId?: string | null) {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
  store.dispatch(selectRangeCmd(0, 3840));
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(
    <Provider store={store}>
      <ChordPicker open onClose={onClose} onApplied={onApplied} editingChordId={editingChordId ?? null} />
    </Provider>,
  );
  return { store, onClose, onApplied };
}

describe('ChordPicker apply gate', () => {
  beforeEach(() => {
    gates.applyResult = true;
  });

  it('stays open with the drafted spec when addChordRangeCmd rejects (chord cap)', async () => {
    const user = userEvent.setup();
    const { onClose, onApplied } = setup();
    gates.applyResult = false;

    await user.click(screen.getByTestId('picker-apply'));

    // Rejected → nothing applied → dialog stays mounted for another try and
    // the post-apply callback is skipped.
    expect(screen.getByTestId('chord-picker')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('closes and fires onApplied only after a successful apply', async () => {
    const user = userEvent.setup();
    const { onClose, onApplied } = setup();

    await user.click(screen.getByTestId('picker-apply'));

    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0]!,
    );
    // NOTE: unmounting is the parent's job via `open`; this harness pins
    // open=true, so the close contract is proven by onClose's call order.
  });

  it('keeps the range selection intact across a rejected apply', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    gates.applyResult = false;

    await user.click(screen.getByTestId('picker-apply'));

    expect(selectSelection(store.getState())?.kind).toBe('range');
  });
});
