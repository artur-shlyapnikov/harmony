/**
 * @vitest-environment jsdom
 *
 * ChordPicker apply flow (§3.20): Root → Family → Template → Apply dispatches
 * the correct spec into the current range selection or the edited chord.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'react-redux';

import { makeStore, type AppDispatch, type RootState } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID } from '@domain/timeline/constants';
import {
  addChordRangeCmd,
  openProjectCmd,
  selectChordCmd,
  selectRangeCmd,
} from '@state/commands';
import { selectChords, selectSelection } from '@state/selectors';
import { ChordLane } from '@features/editor/ChordLane';
import { createEditorShortcutHandler, type ShortcutTransport } from '@features/editor/useEditorShortcuts';
import { ChordPicker } from '@features/chords/ChordPicker';

const C = parseSpelled('C')!;

function setup() {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
  const onClose = vi.fn();
  render(
    <Provider store={store}>
      <ChordPicker open onClose={onClose} />
    </Provider>,
  );
  return { store, onClose };
}

describe('ChordPicker', () => {
  it('applies G7 into the current range selection', () => {
    const { store, onClose } = setup();
    store.dispatch(selectRangeCmd(0, CHORD_GRID * 2));

    // Root: spelled pitch class grid (12 chromatic roots, I12) — click "G".
    const rootButton = [...screen.getByTestId('picker-roots').querySelectorAll('button')]
      .find((b) => b.textContent === 'G') as HTMLElement;
    expect(rootButton).toBeDefined();
    fireEvent.click(rootButton);
    // Family: Seventh.
    fireEvent.click(screen.getByTestId('picker-family').querySelectorAll('button')[1] as HTMLElement);
    // Template: "7" (scoped to the template list).
    const templateButton = [...screen.getByTestId('picker-templates').querySelectorAll('button')]
      .find((b) => b.textContent === '7') as HTMLElement;
    expect(templateButton).toBeDefined();
    fireEvent.click(templateButton);

    fireEvent.click(screen.getByTestId('picker-apply'));

    const chords = selectChords(store.getState());
    expect(chords).toHaveLength(1);
    expect(chords[0]?.chord.root).toEqual({ letter: 'G', accidental: 0 });
    expect(chords[0]?.chord.templateId).toBe('7');
    expect(onClose).toHaveBeenCalled();
  });

  it('exposes role="dialog" with an accessible name and aria-modal (a11y-1)', () => {
    setup();

    const dialog = screen.getByRole('dialog', { name: /выбор аккорда/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('clicks inside the dialog do not bubble to the overlay and close it (e2e regression)', () => {
    const { store, onClose } = setup();
    store.dispatch(selectRangeCmd(0, CHORD_GRID * 2));

    const rootButton = [...screen.getByTestId('picker-roots').querySelectorAll('button')]
      .find((b) => b.textContent === 'G') as HTMLElement;
    fireEvent.click(rootButton);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('picker-apply')).toBeDefined();
    expect(selectChords(store.getState())).toHaveLength(0);
  });

  it('switching family resets template to the first template of that family (§3.20)', () => {
    const { store } = setup();
    store.dispatch(selectRangeCmd(0, CHORD_GRID * 2));

    // Family: basic (default), pick a non-first template "min".
    const minButton = [...screen.getByTestId('picker-templates').querySelectorAll('button')]
      .find((b) => b.textContent === 'm') as HTMLElement;
    expect(minButton).toBeDefined();
    fireEvent.click(minButton);

    // Switch to color family: no explicit template click afterwards.
    const colorFamilyButton = [...screen.getByTestId('picker-family').querySelectorAll('button')]
      .find((b) => b.textContent === 'Колор') as HTMLElement;
    expect(colorFamilyButton).toBeDefined();
    fireEvent.click(colorFamilyButton);

    // First template of the new family is highlighted; stale 'maj' is not.
    const templates = [...screen.getByTestId('picker-templates').querySelectorAll('button')];
    expect(templates[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(templates[0]?.textContent).toBe('7b9');

    fireEvent.click(screen.getByTestId('picker-apply'));

    const chords = selectChords(store.getState());
    expect(chords[0]?.chord.templateId).toBe('7b9');
  });

  it('replaces the spec of an edited chord via setChordSpecCmd', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
    );
    const id = selectChords(store.getState())[0]?.id as string;
    store.dispatch(selectChordCmd(id));

    render(
      <Provider store={store}>
        <ChordPicker open onClose={vi.fn()} editingChordId={id} />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('picker-apply'));
    const chords = selectChords(store.getState());
    expect(chords).toHaveLength(1);
    expect(chords[0]?.id).toBe(id); // same event replaced, not duplicated
  });

  it('disables Apply without a range selection or edited chord', () => {
    setup();

    expect(screen.getByTestId<HTMLButtonElement>('picker-apply').disabled).toBe(true);
  });

  it('labels degree chips tonic-first; clicking one sets that root (§3.20)', () => {
    const store = makeStore();
    const D = parseSpelled('D')!;
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: D, mode: 'ionian' })));
    store.dispatch(selectRangeCmd(0, CHORD_GRID * 2));
    render(
      <Provider store={store}>
        <ChordPicker open onClose={vi.fn()} />
      </Provider>,
    );

    // Degree chips live in the row after the «Ступень» caption.
    const rootSection = screen.getByTestId('picker-root');
    const degreeRow = [...rootSection.querySelectorAll('div')].find((el) =>
      (el.textContent ?? '').startsWith('Ступень'),
    ) as HTMLElement;
    const chips = [...degreeRow.querySelectorAll('button')] as HTMLElement[];
    // D ionian: D=1 … C#=7 (tonic-first), not absolute C-based letter numbers.
    expect(chips.map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    // Parity with the root/family/template grids: chips expose pressed state.
    // The default root is the tonic, so chip «1» starts pressed.
    expect(chips.map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'true', 'false', 'false', 'false', 'false', 'false', 'false',
    ]);
    fireEvent.click(chips[6] as HTMLElement);
    expect(chips[6]?.getAttribute('aria-pressed')).toBe('true');
    expect(chips[2]?.getAttribute('aria-pressed')).toBe('false');

    // Clicking the leading-tone chip («7» = C#) selects C# as the root…
    fireEvent.click(chips[6] as HTMLElement);
    expect(screen.getByTestId('picker-preview').textContent).toMatch(/^C#/);

    // …and applying inserts a chord with that spelled root.
    fireEvent.click(screen.getByTestId('picker-apply'));
    const chords = selectChords(store.getState());
    expect(chords).toHaveLength(1);
    expect(chords[0]?.chord.root).toEqual({ letter: 'C', accidental: 1 });
  });
});

describe('ChordPicker regressions (RevUI-2 / RevUI-3)', () => {
  type WindowKeydownListener = (event: KeyboardEvent) => void;

  type ShortcutStore = { dispatch: AppDispatch; getState: () => RootState };

  let shortcutTransport: ShortcutTransport;
  let shortcutHandler: WindowKeydownListener | null = null;

  // Installs a real window-level shortcut listener with inert transport deps.
  // afterEach ALWAYS removes it, so a failing expect cannot leak a live
  // Delete/Escape/Space handler into later tests of this file.
  const installWindowShortcuts = (store: ShortcutStore) => {
    shortcutTransport = { toggle: vi.fn() };
    shortcutHandler = createEditorShortcutHandler({
      dispatch: store.dispatch,
      getState: store.getState,
      transport: shortcutTransport,
    });
    window.addEventListener('keydown', shortcutHandler);
  };

  afterEach(() => {
    if (shortcutHandler !== null) {
      window.removeEventListener('keydown', shortcutHandler);
      shortcutHandler = null;
    }
  });
  it('reflects the CURRENT prefillRoot on every open (RevUI-2)', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: parseSpelled('E')!, templateId: 'maj' } }),
    );
    store.dispatch(
      addChordRangeCmd({ startTick: CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: parseSpelled('D')!, templateId: 'maj' } }),
    );
    const [xId, yId] = selectChords(store.getState()).map((c) => c.id);

    const onClose = vi.fn();
    const view = render(
      <Provider store={store}>
        <ChordPicker open onClose={onClose} editingChordId={xId ?? null} prefillRoot={parseSpelled('E')} />
      </Provider>,
    );
    expect(screen.getByTestId('picker-preview').textContent).toMatch(/^E/);

    // Close, then reopen on a different chord — the SAME wrapper instance.
    // The session must remount and show D immediately, not the stale E.
    view.rerender(
      <Provider store={store}>
        <ChordPicker open={false} onClose={onClose} editingChordId={xId ?? null} prefillRoot={null} />
      </Provider>,
    );
    view.rerender(
      <Provider store={store}>
        <ChordPicker open onClose={onClose} editingChordId={yId ?? null} prefillRoot={parseSpelled('D')} />
      </Provider>,
    );
    expect(screen.getByTestId('picker-preview').textContent).toMatch(/^D/);
  });

  it('Escape closes the picker; keys inside never reach shortcuts (RevUI-3)', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });
    render(
      <Provider store={store}>
        <ChordLane />
      </Provider>,
    );
    const id = selectChords(store.getState())[0]!.id;
    store.dispatch(selectChordCmd(id));
    installWindowShortcuts(store);

    fireEvent.doubleClick(document.querySelector(`[data-chord-id="${id}"]`) as HTMLElement);
    expect(screen.getByTestId('chord-picker')).toBeTruthy();

    // Delete while the picker is open must NOT delete the selected chord.
    const dialog = screen.getByTestId('chord-picker').querySelector('[data-modal]') as HTMLElement;
    fireEvent.keyDown(dialog, { key: 'Delete' });
    expect(selectChords(store.getState())).toHaveLength(1);
    expect(shortcutTransport.toggle).not.toHaveBeenCalled();

    // Escape (dialog-level handler) closes the picker.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByTestId('chord-picker')).toBeNull();

  });

  it('Escape with focus OUTSIDE the dialog closes the picker and keeps the selection (RevUI-3)', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    act(() => {
      store.dispatch(selectRangeCmd(0, CHORD_GRID));
    });
    expect(selectSelection(store.getState())).not.toBeNull();
    installWindowShortcuts(store);

    const onClose = vi.fn();
    render(
      <Provider store={store}>
        <ChordPicker open onClose={onClose} />
      </Provider>,
    );
    expect(screen.getByTestId('chord-picker')).toBeTruthy();

    // Focus sits on body (e.g. blurred after an inner click): the event never
    // passes through the dialog, so only the document-level interception can
    // keep it away from the window shortcut handler.
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1); // modal still closes
    expect(selectSelection(store.getState())).not.toBeNull(); // selection survives

  });
});

describe('ChordPicker prefill from the edited chord (CP-1)', () => {
  afterEach(cleanup);

  it('opening the picker on Dm7 selects the seventh family and m7 template; Apply is a no-op', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(
      addChordRangeCmd({
        startTick: 0,
        durationTicks: CHORD_GRID,
        chord: { root: parseSpelled('D')!, templateId: 'min7' },
      }),
    );
    const id = selectChords(store.getState())[0]?.id as string;

    render(
      <Provider store={store}>
        <ChordLane />
      </Provider>,
    );

    const block = document.querySelector(`[data-chord-id="${id}"]`) as HTMLElement;
    expect(block).toBeTruthy();
    fireEvent.dblClick(block);

    // Family 'Септаккорды' (seventh) is pressed, template 'm7' is selected.
    const familyButton = [...screen.getByTestId('picker-family').querySelectorAll('button')]
      .find((b) => b.textContent === 'Септаккорды') as HTMLElement;
    expect(familyButton).toBeDefined();
    expect(familyButton.getAttribute('aria-pressed')).toBe('true');

    const templateButton = [...screen.getByTestId('picker-templates').querySelectorAll('button')]
      .find((b) => b.textContent === 'm7') as HTMLElement;
    expect(templateButton).toBeDefined();
    expect(templateButton.getAttribute('aria-pressed')).toBe('true');

    // Apply with no changes: silent no-op — no new history entry.
    const pastBefore = store.getState().projectHistory.past.length;
    fireEvent.click(screen.getByTestId('picker-apply'));
    expect(store.getState().projectHistory.past.length).toBe(pastBefore);
    expect(selectChords(store.getState())).toHaveLength(1);
  });
});

describe('ChordPicker keyboard grid navigation', () => {
  /** Layout stub: place each button of `container` on a `cols`-column grid. */
  function stubGrid(container: HTMLElement, cols: number, w = 40, h = 30): void {
    container.querySelectorAll('button').forEach((b, i) => {
      Object.defineProperty(b, 'offsetLeft', { value: (i % cols) * w, configurable: true });
      Object.defineProperty(b, 'offsetTop', { value: Math.floor(i / cols) * h, configurable: true });
    });
  }

  it('moves focus with arrow keys across the roots grid', () => {
    setup();
    const grid = screen.getByTestId('picker-roots');
    stubGrid(grid, 6);
    const buttons = [...grid.querySelectorAll('button')];
    buttons[0]!.focus(); // C
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]); // C#
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[7]); // G — directly below C#
  });

  it('clamps at row edges and jumps with Home/End', () => {
    setup();
    const grid = screen.getByTestId('picker-roots');
    stubGrid(grid, 6);
    const buttons = [...grid.querySelectorAll('button')];
    buttons[0]!.focus();
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(buttons[0]); // clamped at row start
    fireEvent.keyDown(grid, { key: 'End' });
    expect(document.activeElement).toBe(buttons[11]); // B
  });

  it('ArrowUp from the top row stays put; chips navigate within their row', () => {
    setup();
    const grid = screen.getByTestId('picker-roots');
    stubGrid(grid, 6);
    const buttons = [...grid.querySelectorAll('button')];
    buttons[0]!.focus();
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[0]); // no row above

    const chips = screen.getByText('Ступень:').parentElement as HTMLElement;
    stubGrid(chips, 7);
    const chipButtons = [...chips.querySelectorAll('button')];
    chipButtons[0]!.focus();
    fireEvent.keyDown(chips, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chipButtons[1]);
  });
});
