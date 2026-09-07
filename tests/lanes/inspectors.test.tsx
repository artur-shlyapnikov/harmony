/**
 * @vitest-environment jsdom
 *
 * Inspector edits dispatch commands (§3.20): NoteInspector velocity +
 * spelling override; ChordInspector pattern override + template.
 */

import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';

import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID, NOTE_GRID, PPQ } from '@domain/timeline/constants';
import {
  addChordRangeCmd,
  addNoteCmd,
  deleteChordCmd,
  openProjectCmd,
  selectChordCmd,
  selectNoteCmd,
} from '@state/commands';
import { selectChords, selectMelodyNotes } from '@state/selectors';
import { NoteInspector } from '@features/notes/NoteInspector';
import { ChordInspector } from '@features/chords/ChordInspector';

const C = parseSpelled('C')!;

function setupStore() {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
  return store;
}

describe('NoteInspector', () => {
  it('commits velocity on slider release', () => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 40 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    const slider = screen.getByTestId<HTMLInputElement>('inspector-velocity');
    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.pointerUp(slider);

    expect(selectMelodyNotes(store.getState())[0]?.velocity).toBe(100);
  });

  it('resets the velocity draft when selection moves to another note', async () => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 40 }));
    store.dispatch(
      addNoteCmd({ startTick: NOTE_GRID, durationTicks: NOTE_GRID, midi: 64, velocity: 70 }),
    );
    const notesBefore = selectMelodyNotes(store.getState());
    const a = notesBefore[0]!;
    const b = notesBefore[1]!;
    store.dispatch(selectNoteCmd(a.id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    const slider = screen.getByTestId<HTMLInputElement>('inspector-velocity');
    // Start a drag on A: the draft (100) is local-only until pointerup.
    fireEvent.change(slider, { target: { value: '100' } });
    expect(slider.value).toBe('100');

    // Selection switches to B BEFORE the commit.
    await act(async () => {
      store.dispatch(selectNoteCmd(b.id));
    });

    // B's slider must show B's own velocity, not A's stale draft.
    expect(screen.getByTestId<HTMLInputElement>('inspector-velocity').value).toBe('70');

    // Releasing on B must not commit A's draft against B's id.
    fireEvent.pointerUp(screen.getByTestId('inspector-velocity'));
    const notesAfter = selectMelodyNotes(store.getState());
    expect(notesAfter.find((note) => note.id === b.id)?.velocity).toBe(70);
    expect(notesAfter.find((note) => note.id === a.id)?.velocity).toBe(40);
  });

  it('writes an explicit accidental spelling override', () => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 61, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    fireEvent.change(screen.getByTestId('inspector-accidental'), {
      target: { value: '1' },
    });

    expect(selectMelodyNotes(store.getState())[0]?.spellingOverride).toEqual({
      letter: 'C',
      accidental: 1,
    });
  });

  it('shows «— по ладу» when no explicit spelling override is set', () => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    const select = screen.getByTestId<HTMLSelectElement>('inspector-accidental');
    expect(select.value).toBe('');
    expect(selectMelodyNotes(store.getState())[0]?.spellingOverride).toBeUndefined();
  });

  it('restores focus to the inspector container after «Удалить ноту»', () => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    const deleteButton = screen.getByRole('button', { name: 'Удалить ноту' });
    deleteButton.focus();
    expect(document.activeElement).toBe(deleteButton);

    fireEvent.click(deleteButton);

    const container = screen.getByTestId('note-inspector');
    expect(container.textContent).toContain('Нота не выбрана');
    expect(document.activeElement).toBe(container);
  });

  it('formats the duration with a Russian comma and the musical note value', () => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    expect(screen.getByTestId('inspector-duration').textContent).toBe('0,25');
    expect(screen.getByTestId('note-inspector').textContent).toContain('(шестнадцатая)');
  });

  it('names longer standard durations without fractional padding', () => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: PPQ, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    expect(screen.getByTestId('inspector-duration').textContent).toBe('1');
    expect(screen.getByTestId('note-inspector').textContent).toContain('1 доля (четверть)');
  });

  it.each([
    [1920, '2 доли'],
    [4800, '5 долей'],
    [720, '0,75 доли'],
  ])('agrees the beats noun with the beat count for %i ticks', (durationTicks, expected) => {
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    expect(screen.getByTestId('note-inspector').textContent).toContain(expected);
  });

  it('keeps the duration line bare when the length is off the note-value table', () => {
    // Negative arm: 1200 ticks = 1.25 beats is not in NOTE_VALUE_NAMES — the muted
    // line must end at «1,25 доли» with no parenthesized note-value fragment.
    const store = setupStore();
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: 1200, midi: 60, velocity: 80 }));
    const id = selectMelodyNotes(store.getState())[0]?.id as string;
    store.dispatch(selectNoteCmd(id));

    const { unmount } = render(
      <Provider store={store}>
        <NoteInspector />
      </Provider>,
    );

    const mutedLine = screen.getByTestId('inspector-duration').parentElement!;
    expect(mutedLine.textContent).toContain('Длительность: 1,25 доли');
    expect(mutedLine.textContent).not.toContain('(');
    unmount();

    // Positive control: dotted-fractional 1440 ticks = 1.5 beats keeps the annotation.
    const dottedStore = setupStore();
    dottedStore.dispatch(addNoteCmd({ startTick: 0, durationTicks: 1440, midi: 60, velocity: 80 }));
    const dottedId = selectMelodyNotes(dottedStore.getState())[0]?.id as string;
    dottedStore.dispatch(selectNoteCmd(dottedId));

    render(
      <Provider store={dottedStore}>
        <NoteInspector />
      </Provider>,
    );

    const container = screen.getByTestId('note-inspector').textContent ?? '';
    expect(container).toContain('1,5 доли (четверть с точкой)');
  });
});

describe('ChordInspector', () => {
  it('sets and clears a pattern override', () => {
    const store = setupStore();
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj7' } }),
    );
    const id = selectChords(store.getState())[0]?.id as string;
    store.dispatch(selectChordCmd(id));

    render(
      <Provider store={store}>
        <ChordInspector />
      </Provider>,
    );

    fireEvent.change(screen.getByTestId('inspector-pattern'), {
      target: { value: 'upDown' },
    });
    expect(selectChords(store.getState())[0]?.patternOverride?.kind).toBe('upDown');

    fireEvent.change(screen.getByTestId('inspector-pattern'), {
      target: { value: '' },
    });
    expect(selectChords(store.getState())[0]?.patternOverride).toBeUndefined();
  });

  it('restores focus to the inspector container when the focused chord is deleted', () => {
    const store = setupStore();
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
    );
    const id = selectChords(store.getState())[0]?.id as string;
    store.dispatch(selectChordCmd(id));

    const { rerender } = render(
      <Provider store={store}>
        <ChordInspector />
      </Provider>,
    );

    // Keyboard user has focus inside the inspector when the chord is removed
    // from elsewhere (e.g. Delete shortcut): the empty state must catch focus.
    screen.getByTestId('inspector-symbol').focus();
    act(() => {
      store.dispatch(deleteChordCmd({ id }));
    });
    rerender(
      <Provider store={store}>
        <ChordInspector />
      </Provider>,
    );

    const container = screen.getByTestId('chord-inspector');
    expect(container.textContent).toContain('Аккорд не выбран');
    expect(document.activeElement).toBe(container);
  });

  it('changes the chord template via setChordSpecCmd', () => {
    const store = setupStore();
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
    );
    const id = selectChords(store.getState())[0]?.id as string;
    store.dispatch(selectChordCmd(id));

    render(
      <Provider store={store}>
        <ChordInspector />
      </Provider>,
    );

    fireEvent.change(screen.getByTestId('inspector-template'), {
      target: { value: 'min7' },
    });
    expect(selectChords(store.getState())[0]?.chord.templateId).toBe('min7');
  });

  it('shows the omitted-tones tooltip for a 13th chord with four voices', () => {
    const store = setupStore();
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: '13' } }),
    );
    const id = selectChords(store.getState())[0]?.id as string;
    store.dispatch(selectChordCmd(id));

    render(
      <Provider store={store}>
        <ChordInspector />
      </Provider>,
    );

    // C13 formula has optional 5/9/11 beyond the four selected voices.
    expect(screen.getByTestId('omitted-tones').textContent).toMatch(/опущены/);
  });
});
