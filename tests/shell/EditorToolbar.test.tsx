// @vitest-environment jsdom
/**
 * Toolbar §3.14 rejection UX: a key change whose transposition would push
 * notes out of the 36..96 range is rejected wholesale and surfaces an error
 * toast listing the offending notes count.
 */

import { MemoryRouter, useLocation } from 'react-router-dom';

import { Provider } from 'react-redux';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeStore } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import { REPLACED_FROM_LOAD } from '../../src/state/projectDocumentSlice';
import { EditorToolbar } from '../../src/features/editor/EditorToolbar';
import { TOAST_AUTO_DISMISS_MS, ToastHost } from '../../src/shared/ToastHost';
import { setDependenciesForTesting, type AppDependencies } from '../../src/app/dependencies';
import { ProjectTransport } from '../../src/audio/projectTransport';

function documentWithHighNotes() {
  const document = createProjectDocument({
    title: 'Высокие ноты',
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });
  document.melody.notes = [
    { id: 'n1', startTick: 0, durationTicks: 480, midi: 96, velocity: 80 },
    { id: 'n2', startTick: 960, durationTicks: 480, midi: 96, velocity: 80 },
  ];
  return document;
}

function fakeDependencies(
  downloadMidi: AppDependencies['downloadMidi'],
): AppDependencies {
  return {
    projects: {
      list: async () => [],
      create: async () => {},
      open: async () => ({ kind: 'notFound' }),
      scheduleSave() {},
      retrySave() {},
      duplicate: async () => ({ kind: 'notFound' }),
      delete: async () => {},
      flushBeforeUnload: async () => true,
      flushOnProjectSwitch: async () => true,
      subscribe: () => () => {},
    },
    transport: new ProjectTransport(),
    downloadBackup() {},
    downloadMidi,
  };
}
describe('EditorToolbar transpose rejection', () => {
  it('shows an error toast with the offending note count', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: { project: documentWithHighNotes() },
    });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
          <ToastHost />
        </MemoryRouter>
      </Provider>,
    );

    // +1 semitone to C# would push both midi-96 notes above the 96 ceiling.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Тональность' }), 'C#');

    await screen.findByRole('alert');
    expect(store.getState().session.toasts[0]?.message).toContain('2 ноты выйдут');
    // The whole operation was rejected — the document is unchanged.
    expect(store.getState().projectHistory.present?.harmonyContext.tonic.letter).toBe('C');
    expect(store.getState().projectHistory.past).toHaveLength(0);
  });
});

describe('EditorToolbar MIDI export failure', () => {

  afterEach(() => {
    setDependenciesForTesting(null);
  });

  it('wraps a failed download result in the Russian toast prefix', async () => {
    const user = userEvent.setup();
    setDependenciesForTesting(
      fakeDependencies(async () => ({ ok: false, error: 'disk full' })),
    );
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: { project: documentWithHighNotes() },
    });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
          <ToastHost />
        </MemoryRouter>
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Экспортировать MIDI' }));
    // The !result.ok path must use the same Russian wrapper as .catch.
    const toast = await screen.findByRole('alert');
    expect(toast.querySelector('.toast-message')?.textContent).toBe(
      'Не удалось экспортировать MIDI: disk full',
    );
  });

  it('maps a failed lazy-chunk fetch to a humane offline message', async () => {
    const user = userEvent.setup();
    setDependenciesForTesting(
      fakeDependencies(async () => {
        throw new Error('Failed to fetch dynamically imported module: http://x/src/midi/downloadMidi.ts');
      }),
    );
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: { project: documentWithHighNotes() },
    });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
          <ToastHost />
        </MemoryRouter>
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Экспортировать MIDI' }));
    // A raw module URL means nothing to a musician offline on the first export.
    const toast = await screen.findByRole('alert');
    expect(toast.querySelector('.toast-message')?.textContent).toBe(
      'Не удалось загрузить модуль экспорта — проверьте соединение и попробуйте снова',
    );
  });
});

describe('EditorToolbar MIDI export pending', () => {
  afterEach(() => {
    setDependenciesForTesting(null);
  });

  it('labels the in-flight export and restores the button afterwards', async () => {
    const user = userEvent.setup();
    let resolveExport: (result: { ok: true; filename: string }) => void = () => {};
    const exportPromise = new Promise<{ ok: true; filename: string }>((resolve) => {
      resolveExport = resolve;
    });
    setDependenciesForTesting(fakeDependencies(() => exportPromise));
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: { project: documentWithHighNotes() },
    });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
        </MemoryRouter>
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Экспортировать MIDI' }));
    // The first export fetches the lazy exporter chunk; while it is in
    // flight the button must name the work instead of reading as dead.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Экспорт…' }).disabled).toBe(true);

    await act(async () => {
      resolveExport({ ok: true, filename: 'x.mid' });
    });
    expect(
      await screen.findByRole<HTMLButtonElement>('button', { name: 'Экспортировать MIDI' }),
    ).toHaveProperty('disabled', false);
  });
});

describe('EditorToolbar undo/redo', () => {
  it('после undo кнопка Redo активна', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: {
        project: createProjectDocument({
          title: 'История',
          tonic: { letter: 'C', accidental: 0 },
          mode: 'ionian',
        }),
      },
    });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
        </MemoryRouter>
      </Provider>,
    );

    const redo = screen.getByRole<HTMLButtonElement>('button', { name: 'Повторить' });
    expect(redo.disabled).toBe(true);

    // Successful transpose = one undoable edit.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Тональность' }), 'D');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Отменить' }).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Отменить' }));

    // After one undo the redo stack holds the undone state → Redo enabled.
    expect(store.getState().projectHistory.future).toHaveLength(1);
    expect(redo.disabled).toBe(false);
  });
});

describe('EditorToolbar BPM input (§3.5 via UI seam)', () => {
  function renderToolbar() {
    const user = userEvent.setup();
    const store = makeStore();
    const project = createProjectDocument({
      title: 'Темп',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    project.timing.bpm = 120;
    store.dispatch({ type: REPLACED_FROM_LOAD, payload: { project } });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
          <ToastHost />
        </MemoryRouter>
      </Provider>,
    );
    return { user, store };
  }

  it('commits an in-range bpm and rejects an out-of-range entry with the Russian error toast, keeping the previous bpm', async () => {
    const { user, store } = renderToolbar();
    const input = screen.getByRole('spinbutton', { name: 'Темп BPM' });

    await user.clear(input);
    await user.type(input, '150');
    await user.keyboard('{Enter}');

    expect(store.getState().projectHistory.present?.timing.bpm).toBe(150);

    await user.clear(input);
    await user.type(input, '999');
    await user.keyboard('{Enter}');

    const toast = await screen.findByRole('alert');
    expect(toast.querySelector('.toast-message')?.textContent).toBe(
      'Темп должен быть от 40 до 240',
    );
    // The out-of-range entry left the committed tempo untouched.
    expect(store.getState().projectHistory.present?.timing.bpm).toBe(150);
  });
});

// TOOL-P1 (round 5): §3.20 tool selection surfaced accessibly — the pressed
// tool is exposed via aria-pressed on the group's buttons and clicking moves
// both the pressed state and the session activeTool. renderToolbar mirrors
// the BPM describe's factory verbatim.
describe('EditorToolbar tools group (§3.20 tool selection)', () => {
  function renderToolbar() {
    const user = userEvent.setup();
    const store = makeStore();
    const project = createProjectDocument({
      title: 'Темп',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    project.timing.bpm = 120;
    store.dispatch({ type: REPLACED_FROM_LOAD, payload: { project } });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
          <ToastHost />
        </MemoryRouter>
      </Provider>,
    );
    return { user, store };
  }

  it('buttons reflect the active tool via aria-pressed and clicking moves the pressed state', async () => {
    const { user, store } = renderToolbar();

    // Initial state: «Выбор» is the pressed tool.
    const group = screen.getByRole('group', { name: 'Инструменты' });
    expect(within(group).getByTestId('tool-select').getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByTestId('tool-draw-note').getAttribute('aria-pressed')).toBe('false');
    expect(within(group).getByTestId('tool-draw-chord').getAttribute('aria-pressed')).toBe(
      'false',
    );

    await user.click(within(group).getByTestId('tool-draw-note'));

    // The press moved to «Нота»; the other two buttons unpressed.
    expect(within(group).getByTestId('tool-select').getAttribute('aria-pressed')).toBe('false');
    expect(within(group).getByTestId('tool-draw-note').getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByTestId('tool-draw-chord').getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(store.getState().session.activeTool).toBe('drawNote');
  });
});


describe('EditorToolbar mode selector (§3.14/§3.15 via UI seam)', () => {
  function renderToolbarWithMelody() {
    const user = userEvent.setup();
    const store = makeStore();
    const project = createProjectDocument({
      title: 'Лад',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    project.melody.notes = [
      { id: 'n1', startTick: 0, durationTicks: 480, midi: 60, velocity: 80 },
      { id: 'n2', startTick: 960, durationTicks: 480, midi: 64, velocity: 80 },
      { id: 'n3', startTick: 1920, durationTicks: 480, midi: 67, velocity: 80 },
    ];
    store.dispatch({ type: REPLACED_FROM_LOAD, payload: { project } });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
          <ToastHost />
        </MemoryRouter>
      </Provider>,
    );
    return { user, store };
  }

  it('changing Лад updates harmonyContext.mode and reinterprets labels without moving any melody midi', async () => {
    const { user, store } = renderToolbarWithMelody();
    const midisBefore = store
      .getState()
      .projectHistory.present!.melody.notes.map((note) => note.midi);

    await user.selectOptions(screen.getByLabelText('Лад'), 'dorian');

    expect(store.getState().projectHistory.present?.harmonyContext.mode).toBe('dorian');
    // Reinterpretation is label-level only: every melody midi is byte-equal.
    expect(store.getState().projectHistory.present!.melody.notes.map((note) => note.midi)).toEqual(
      midisBefore,
    );
    // The select reflects the new mode and no error toast was pushed.
    expect(screen.getByLabelText<HTMLSelectElement>('Лад').value).toBe('dorian');
    expect(store.getState().session.toasts.some((toast) => toast.kind === 'error')).toBe(false);
  });
});

describe('EditorToolbar empty-project export (§3.21 «Пустой проект»)', () => {
  afterEach(() => {
    setDependenciesForTesting(null);
  });

  it('an empty project shows the «Проект пуст…» info toast AND still downloads the correct empty MIDI', async () => {
    const user = userEvent.setup();
    const downloadMidi = vi.fn(async () => ({ ok: true as const, filename: 'empty.mid' }));
    setDependenciesForTesting(fakeDependencies(downloadMidi));
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: {
        project: createProjectDocument({
          title: 'Пустой',
          tonic: { letter: 'C', accidental: 0 },
          mode: 'ionian',
        }),
      },
    });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
          <ToastHost />
        </MemoryRouter>
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Экспортировать MIDI' }));

    // Both the info toast and the follow-up success toast surface (neither is
    // an error, so neither carries a per-item role under the new contract).
    await screen.findByText('Проект пуст — будет экспортирован корректный пустой MIDI-файл');
    expect(screen.getByText('MIDI экспортирован')).toBeTruthy();
    // The download itself went through exactly once.
    expect(downloadMidi).toHaveBeenCalledTimes(1);
  });
});

// TST-D10: toast surface lifecycle. Fake timers + dispatch-driven toasts +
// fireEvent for the manual close — userEvent is deliberately NOT mixed with
// fake timers (flakiness; local://test-design-4.md §4.3). Importing
// fireEvent into this file is the sanctioned convention delta.
describe('ToastHost lifecycle (§3.15 session.toasts surface)', () => {
  it('a pushed toast auto-dismisses after TOAST_AUTO_DISMISS_MS and can be dismissed manually via its close button inside a polite live region', () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      render(
        <Provider store={store}>
          <MemoryRouter>
            <ToastHost />
          </MemoryRouter>
        </Provider>,
      );

      // Act 1: push a toast through the public session action.
      act(() => {
        store.dispatch({
          type: 'session/toastPushed',
          payload: { toast: { id: 't1', kind: 'error', message: 'Проверка тостов' } },
        });
      });

      // The host is a polite live region; an error item announces assertively
      // via role="alert" under the new ToastHost contract.
      const status = screen.getByRole('alert');
      expect(status.querySelector('.toast-message')?.textContent).toBe('Проверка тостов');
      const host = status.closest('.toast-host');
      expect(host?.getAttribute('aria-live')).toBe('polite');
      expect(screen.getByRole('button', { name: 'Закрыть уведомление' })).toBeTruthy();

      // Act 2: exactly the auto-dismiss delay removes it (timer path).
      act(() => {
        vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS);
      });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(store.getState().session.toasts).toHaveLength(0);

      // Act 3: a second toast goes away instantly via its close button.
      act(() => {
        store.dispatch({
          type: 'session/toastPushed',
          payload: { toast: { id: 't2', kind: 'info', message: 'Второй тост' } },
        });
      });
      expect(screen.getByText('Второй тост')).toBeTruthy();
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Закрыть уведомление' }));
      });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.querySelector('.toast')).toBeNull();
      expect(store.getState().session.toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EditorToolbar back navigation', () => {
  it('«← Проекты» navigates to the project list route', () => {
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: { project: documentWithHighNotes() },
    });

    let pathname = '/project/abc';
    function LocationProbe(): null {
      const location = useLocation();
      pathname = location.pathname;
      return null;
    }

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/project/abc']}>
          <EditorToolbar />
          <LocationProbe />
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '← Проекты' }));
    expect(pathname).toBe('/');
  });
});

describe('EditorToolbar rename input', () => {
  const TITLE_BUTTON = 'Название проекта — нажмите, чтобы переименовать';

  it('Escape cancels the rename and restores focus to the title button', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: { project: documentWithHighNotes() },
    });

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EditorToolbar />
        </MemoryRouter>
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: TITLE_BUTTON }));
    const input = screen.getByRole('textbox', { name: 'Название проекта' });
    expect(document.activeElement).toBe(input);

    // Escape drops the input; without focus restoration it fell to <body>
    // and keyboard flow left the toolbar entirely.
    await user.keyboard('{Escape}');

    const titleButton = screen.getByRole('button', { name: TITLE_BUTTON });
    expect(document.activeElement).toBe(titleButton);
    // The draft was discarded, not committed.
    expect(store.getState().projectHistory.present?.title).toBe('Высокие ноты');
  });
});
