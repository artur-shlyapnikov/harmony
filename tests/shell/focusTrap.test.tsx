// @vitest-environment jsdom
/**
 * Modal focus trap (§4 shared UI): ChordPicker, NewProjectDialog and
 * ConfirmDialog all trap Tab inside the dialog and restore focus to the
 * trigger on close.
 */

import { type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeStore, type AppDispatch, type RootState } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import {
  addNoteCmd,
  openProjectCmd,
  selectNoteCmd,
} from '../../src/state/commands';
import { NOTE_GRID } from '../../src/domain/timeline/constants';
import { createEditorShortcutHandler } from '../../src/features/editor/useEditorShortcuts';
import { ChordPicker } from '../../src/features/chords/ChordPicker';
import { NewProjectDialog } from '../../src/features/projects/NewProjectDialog';
import { useFocusTrap } from '../../src/shared/focusTrap';
import { ConfirmDialog } from '../../src/shared/ConfirmDialog';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';


function focusablesIn(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** Renders a focusable trigger plus the dialog under test. */
function Harness({ children }: { children: (onClose: () => void) => ReactNode }) {
  return (
    <>
      <button type="button" data-testid="trigger" autoFocus>
        Открыть
      </button>
      {children(() => undefined)}
    </>
  );
}

function renderWithDialog(
  makeDialog: (open: boolean, onClose: () => void) => ReactNode,
  selector: string,
) {
  const store = makeStore();
  store.dispatch(
    openProjectCmd(createProjectDocument({ title: 't', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' })),
  );
  const view = render(
    <Provider store={store}>
      <MemoryRouter>
        <Harness>{(onClose) => makeDialog(true, onClose)}</Harness>
      </MemoryRouter>
    </Provider>,
  );
  const trigger = screen.getByTestId('trigger');
  const dialog = () => document.querySelector(selector)!;
  return { view, trigger, dialog, store };
}

describe('modal focus trap', () => {
  it('ChordPicker: focus lands inside, Tab cycles, close restores the trigger', () => {
    const { view, trigger, dialog } = renderWithDialog(
      (open, onClose) => <ChordPicker open={open} onClose={onClose} />,
      '[data-testid="chord-picker"]',
    );

    // Focus lands inside on open.
    expect(dialog().contains(document.activeElement)).toBe(true);

    // Tab from the LAST focusable wraps to the FIRST without leaving.
    const items = focusablesIn(dialog());
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);

    // Shift+Tab from the FIRST wraps back to the LAST.
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);

    // Close → focus returns to the trigger.
    view.rerender(
      <Provider store={makeStore()}>
        <MemoryRouter>
          <Harness>
            {(onClose) => <ChordPicker open={false} onClose={onClose} />}
          </Harness>
        </MemoryRouter>
      </Provider>,
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('NewProjectDialog: focus lands inside, Tab cycles, close restores the trigger', () => {
    const { view, trigger, dialog } = renderWithDialog(
      (open, onClose) => <NewProjectDialog open={open} onClose={onClose} />,
      '[role="dialog"]',
    );

    expect(dialog().contains(document.activeElement)).toBe(true);

    const items = focusablesIn(dialog());
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);

    view.rerender(
      <Provider store={makeStore()}>
        <MemoryRouter>
          <Harness>
            {(onClose) => <NewProjectDialog open={false} onClose={onClose} />}
          </Harness>
        </MemoryRouter>
      </Provider>,
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('ConfirmDialog: focus lands inside, Tab cycles, close restores the trigger', () => {
    const options = { title: 'Удаление проекта', message: 'Удалить?' };
    const { view, trigger, dialog } = renderWithDialog(
      (open, onClose) => <ConfirmDialog open={open} onClose={onClose} options={options} />,
      '[role="dialog"]',
    );

    expect(dialog().contains(document.activeElement)).toBe(true);

    const items = focusablesIn(dialog());
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);

    view.rerender(
      <Provider store={makeStore()}>
        <MemoryRouter>
          <Harness>
            {(onClose) => <ConfirmDialog open={false} onClose={onClose} options={options} />}
          </Harness>
        </MemoryRouter>
      </Provider>,
    );
    expect(document.activeElement).toBe(trigger);
  });
/** Dialog whose first focusable element is display:none (jsdom: no layout). */
function HiddenFirstDialog() {
  const ref = useFocusTrap<HTMLDivElement>(true);
  return (
    <div ref={ref} data-testid="hidden-first-dialog">
      <button type="button" data-testid="ghost" style={{ display: 'none' }}>
        скрытая
      </button>
      <button type="button" data-testid="visible">видимая</button>
    </div>
  );
}

  it('hidden first focusable is skipped: focus lands on the first VISIBLE one and stays trappable', () => {
    // .focus() no-ops on display:none elements; without the visibility
    // filter focus would stay on <body> and the container keydown listener
    // would never fire.
    render(
      <Provider store={makeStore()}>
        <MemoryRouter>
          <Harness>{() => <HiddenFirstDialog />}</Harness>
        </MemoryRouter>
      </Provider>,
    );
    const dialog = () => document.querySelector('[data-testid="hidden-first-dialog"]')!;

    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('visible'));

    // Tab cycles over visible candidates only (the single visible button wraps).
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('visible'));
  });
});

describe('dialog data-modal shortcut guard (RevUI-3)', () => {
  type WindowKeydownListener = (event: KeyboardEvent) => void;
  type ShortcutStore = { dispatch: AppDispatch; getState: () => RootState };

  let shortcutHandler: WindowKeydownListener | null = null;

  // Installs a real window-level shortcut listener with inert transport deps.
  // afterEach ALWAYS removes it, so a failing expect cannot leak a live
  // Delete/Escape/Space handler into later tests of this file.
  const installWindowShortcuts = (store: ShortcutStore) => {
    const transport = { toggle: vi.fn() };
    shortcutHandler = createEditorShortcutHandler({
      dispatch: store.dispatch,
      getState: store.getState,
      transport,
    });
    window.addEventListener('keydown', shortcutHandler);
  };

  afterEach(() => {
    if (shortcutHandler !== null) {
      window.removeEventListener('keydown', shortcutHandler);
      shortcutHandler = null;
    }
  });

  it('Delete inside ConfirmDialog never deletes the selected note', () => {
    const options = { title: 'Удаление проекта', message: 'Удалить?' };
    const { store } = renderWithDialog(
      (open, onClose) => <ConfirmDialog open={open} onClose={onClose} options={options} />,
      '[role="dialog"]',
    );
    installWindowShortcuts(store);

    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 }));
    const id = store.getState().projectHistory.present!.melody.notes[0]!.id;
    store.dispatch(selectNoteCmd(id));
    const pastBefore = store.getState().projectHistory.past.length;

    const present = store.getState().projectHistory.present!;
    expect(present.melody.notes).toHaveLength(1);
    expect(present.melody.notes[0]!.id).toBe(id);
    expect(store.getState().session.selection).toEqual({ kind: 'note', id });
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore);
  });

  it('Delete inside NewProjectDialog never deletes the selected note', () => {
    const { store } = renderWithDialog(
      (open, onClose) => <NewProjectDialog open={open} onClose={onClose} />,
      '[role="dialog"]',
    );
    installWindowShortcuts(store);

    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 }));
    const id = store.getState().projectHistory.present!.melody.notes[0]!.id;
    store.dispatch(selectNoteCmd(id));
    const pastBefore = store.getState().projectHistory.past.length;

    const present = store.getState().projectHistory.present!;
    expect(present.melody.notes).toHaveLength(1);
    expect(present.melody.notes[0]!.id).toBe(id);
    expect(store.getState().session.selection).toEqual({ kind: 'note', id });
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore);
  });
});
