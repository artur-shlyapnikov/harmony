/**
 * @vitest-environment jsdom
 *
 * MelodyLane draw interaction (§3.7, §3.20): a pointer drag with the draw
 * tool produces exactly ONE canonical addNoteCmd with grid-quantized ticks.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';

import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { NOTE_GRID, TICKS_PER_BEAT } from '@domain/timeline/constants';
import {
  addChordRangeCmd,
  addNoteCmd,
  clearSelectionCmd,
  openProjectCmd,
  selectChordCmd,
  selectNoteCmd,
  selectRangeCmd,
  setActiveToolCmd,
} from '@state/commands';
import { selectMelodyNotes } from '@state/selectors';
import { MelodyLane } from '@features/editor/MelodyLane';
import { tickToX } from '@features/editor/timelineGeometry';

const C = parseSpelled('C')!;

function renderLane() {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
  store.dispatch(setActiveToolCmd('drawNote'));
  render(
    <Provider store={store}>
      <MelodyLane />
    </Provider>,
  );
  return store;
}

// Default zoom 40 px/beat → 1 beat = 40px.
describe('MelodyLane draw tool', () => {
  it('creates one quantized note per drag gesture', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    // Press at x=40 (beat 1), drag to x=100 (beat 2.5), release.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });

    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(1);
    expect(notes[0]?.startTick).toBe(960); // 1 beat, NOTE_GRID-quantized
    expect(notes[0]!.durationTicks % NOTE_GRID).toBe(0);
    expect(notes[0]!.durationTicks).toBe(1440); // 1.5 beats
    expect(notes[0]!.midi).toBeGreaterThanOrEqual(36);
    expect(notes[0]!.midi).toBeLessThanOrEqual(96);

    // ONE canonical mutation → exactly one undo step (§3.8).
    expect(store.getState().projectHistory.past).toHaveLength(1);
  });

  it('draw selects the fresh note so Delete/Alt+Arrow work immediately (DAW convention)', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });

    const [note] = selectMelodyNotes(store.getState());
    expect(store.getState().session.selection).toEqual({ kind: 'note', id: note!.id });
    // Selection is session state: the draw stays ONE undoable mutation.
    expect(store.getState().projectHistory.past).toHaveLength(1);
  });

  it('draw preserves an active harmony selection (range -> suggestions panel stays open)', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');
    store.dispatch(selectRangeCmd(0, TICKS_PER_BEAT * 2));
    expect(store.getState().session.selection?.kind).toBe('range');

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });

    // The note is added, but the range (and with it the suggestions panel)
    // survives the draw.
    expect(selectMelodyNotes(store.getState())).toHaveLength(1);
    expect(store.getState().session.selection?.kind).toBe('range');
  });

  it('draw preserves an active chord selection (chord inspector stays open)', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');
    store.dispatch(addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } }));
    const chord = store.getState().projectHistory.present!.harmony.chords[0]!;
    store.dispatch(selectChordCmd(chord.id));

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });

    expect(selectMelodyNotes(store.getState())).toHaveLength(1);
    expect(store.getState().session.selection).toEqual({ kind: 'chord', id: chord.id });
  });

  it('selects a note on plain click (press-release without drag)', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    const noteId = selectMelodyNotes(store.getState())[0]!.id;
    // A plain click on the note body must select it (§3.20). A real click
    // is always preceded by a pointer press, which resets the drag flag.
    const bodyRect = svg.querySelector(`[data-note-id="${noteId}"] [data-role="note-body"]`)!;
    fireEvent.pointerDown(bodyRect, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(bodyRect, { pointerId: 1 });
    fireEvent.click(bodyRect);
    expect(store.getState().session.selection).toEqual({ kind: 'note', id: noteId });
  });

  it('selects a note when pressing its resize edge without dragging', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    const noteId = selectMelodyNotes(store.getState())[0]!.id;

    // On a 1-grid-step note (10px at the default zoom) the edge handles
    // cover the whole body: pressing an edge must still select the note,
    // otherwise minimal notes are unreachable for selection.
    const edge = svg.querySelector(`[data-note-id="${noteId}"] [data-role="note-edge-l"]`)!;
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });

    expect(store.getState().session.selection).toEqual({ kind: 'note', id: noteId });
  });

  it('snaps a sub-grid click drag to exactly one grid step', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 41, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 41, clientY: 200, pointerId: 1 });

    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(1);
    expect(notes[0]?.durationTicks).toBe(NOTE_GRID);
  });

  it('creates a minimal note on a bare click without movement (§3.7)', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    // Press and release at x=40 (beat 1) without any move: still a note act.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 40, clientY: 200, pointerId: 1 });

    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(1);
    expect(notes[0]?.startTick).toBe(960); // 1 beat, grid-quantized
    expect(notes[0]?.durationTicks).toBe(NOTE_GRID); // minimum 1/16 duration
    expect(notes[0]!.midi).toBeGreaterThanOrEqual(36);
    expect(notes[0]!.midi).toBeLessThanOrEqual(96);
  });
});

describe('MelodyLane move drag', () => {
  /** Draws one note at (40, 200), then returns its id and midi. */
  function drawNote() {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 40, clientY: 200, pointerId: 1 });
    const [note] = selectMelodyNotes(store.getState());
    return { store, svg, note: note! };
  }

  it('vertical body drag changes pitch in whole diatonic rows', () => {
    const { store, svg, note } = drawNote();
    const body = svg.querySelector(`[data-note-id="${note.id}"] [data-role="note-body"]`)!;

    // 24px up = exactly 2 diatonic rows (12px each). Rows are staff
    // positions, not semitones: G4 → A4 → B4 = +4 semitones.
    fireEvent.pointerDown(body, { button: 0, clientX: 40, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 40, clientY: 176, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 40, clientY: 176, pointerId: 1 });

    const [moved] = selectMelodyNotes(store.getState());
    expect(note.midi).toBe(67); // G4 — the deterministic draw position
    expect(moved!.midi).toBe(71); // B4
    expect(moved!.startTick).toBe(note.startTick); // horizontal position kept
  });

  it('a diagonal drag commits position and pitch as ONE undo step', () => {
    const { store, svg, note } = drawNote();
    const body = svg.querySelector(`[data-note-id="${note.id}"] [data-role="note-body"]`)!;

    fireEvent.pointerDown(body, { button: 0, clientX: 40, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 80, clientY: 176, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 80, clientY: 176, pointerId: 1 });

    const [moved] = selectMelodyNotes(store.getState());
    expect(moved!.midi).toBe(71); // two diatonic rows up: G4 → B4
    expect(moved!.startTick).toBe(note.startTick + 960); // +1 beat, quantized
    expect(store.getState().projectHistory.past).toHaveLength(2); // draw + move
  });

  it('clamps the preview at the lane bounds instead of relying on rejection', () => {
    const { store, svg, note } = drawNote();
    const body = svg.querySelector(`[data-note-id="${note.id}"] [data-role="note-body"]`)!;

    // Drag far above the lane: the UI clamp lands the note exactly on the
    // top boundary, so the command succeeds instead of being rejected.
    fireEvent.pointerDown(body, { button: 0, clientX: 40, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 40, clientY: -400, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 40, clientY: -400, pointerId: 1 });

    const [moved] = selectMelodyNotes(store.getState());
    expect(moved!.midi).toBe(96);
    expect(moved!.midi).toBeGreaterThan(note.midi);
  });
});

describe('MelodyLane pointer capture', () => {
  it('captures only on a pressed drag, never on plain hover', () => {
    renderLane();
    const svg = screen.getByTestId('melody-lane') as unknown as SVGSVGElement;
    const setPointerCapture = vi.fn();
    svg.setPointerCapture = setPointerCapture;

    // Hover with no buttons pressed must NOT capture: a mouse is an active
    // pointer per Pointer Events L3, so a hover capture would retarget every
    // later pointerdown to the lane root and break block hit-testing.
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 200, pointerId: 1, buttons: 0 });
    expect(setPointerCapture).not.toHaveBeenCalled();

    // A pressed draw drag captures lazily on the first move.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1, buttons: 1 });
    expect(setPointerCapture).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
  });
  it('never captures a pressed gesture that started outside a lane drag', () => {
    renderLane();
    const svg = screen.getByTestId('melody-lane') as unknown as SVGSVGElement;
    const setPointerCapture = vi.fn();
    svg.setPointerCapture = setPointerCapture;

    // A press that started elsewhere (e.g. a velocity slider drag) crossing
    // the lane must not be stolen: capture only applies to drags active in
    // THIS lane.
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 200, pointerId: 1, buttons: 1 });
    expect(setPointerCapture).not.toHaveBeenCalled();

    // Pen barrel-button hover reports buttons=2 without contact, and
    // right/middle mouse drags are not lane gestures either.
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 200, pointerId: 1, buttons: 2 });
    expect(setPointerCapture).not.toHaveBeenCalled();
  });
  it('pointercancel aborts the drag: ghost cleared, nothing committed, next drag starts fresh', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane') as unknown as SVGSVGElement;
    const setPointerCapture = vi.fn();
    svg.setPointerCapture = setPointerCapture;

    // Start a draw drag and extend it: the ghost preview appears.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(svg, { clientX: 160, clientY: 200, pointerId: 1, buttons: 1 });
    const ghost = 'rect[fill="rgba(37,99,235,0.35)"]';
    expect(document.querySelector(ghost)).not.toBeNull();

    // Touch interrupted / browser gesture takeover: no pointerup will come.
    fireEvent.pointerCancel(svg, { pointerId: 1 });

    // Ghost cleared and NOTHING committed (cancel ≠ commit).
    expect(document.querySelector(ghost)).toBeNull();
    expect(selectMelodyNotes(store.getState())).toHaveLength(0);

    // A later move with the button held must NOT resume the stale drag…
    fireEvent.pointerMove(svg, { clientX: 300, clientY: 200, pointerId: 1, buttons: 1 });
    expect(document.querySelector(ghost)).toBeNull();

    // …and its release must not commit anything either.
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(selectMelodyNotes(store.getState())).toHaveLength(0);

    // A brand-new press-drag-release works from scratch.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 2, buttons: 1 });
    fireEvent.pointerMove(svg, { clientX: 80, clientY: 200, pointerId: 2, buttons: 1 });
    fireEvent.pointerUp(svg, { pointerId: 2 });
    expect(selectMelodyNotes(store.getState())).toHaveLength(1);
  });
  it('pointercancel before any pointermove aborts an unmoved draw drag', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane') as unknown as SVGSVGElement;
    const setPointerCapture = vi.fn();
    svg.setPointerCapture = setPointerCapture;
    const ghost = 'rect[fill="rgba(37,99,235,0.35)"]';

    // Press starting a draw drag: the ghost appears immediately and
    // capture is taken EAGERLY on the pressed element (the svg root for a
    // draw press), so a first move that exits the lane cannot orphan it.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1, buttons: 1 });
    expect(document.querySelector(ghost)).not.toBeNull();
    expect(setPointerCapture).toHaveBeenCalledWith(1);

    // Touch gesture takeover cancels BEFORE any pointermove: the unmoved
    // drag must still abort cleanly.
    fireEvent.pointerCancel(svg, { pointerId: 1 });

    // Ghost cleared and NOTHING committed.
    expect(document.querySelector(ghost)).toBeNull();

    // A stale move with the button held must NOT resume the aborted drag,
    // and its release must not commit anything either.
    fireEvent.pointerMove(svg, { clientX: 300, clientY: 200, pointerId: 1, buttons: 1 });
    expect(document.querySelector(ghost)).toBeNull();
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(selectMelodyNotes(store.getState())).toHaveLength(0);
  });
  it('after a pre-move pointercancel a plain click selects instead of dragging', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane') as unknown as SVGSVGElement;

    // Create one note to interact with.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    const noteId = selectMelodyNotes(store.getState())[0]!.id;

    const pastCount = store.getState().projectHistory.past.length;
    const edge = svg.querySelector(`[data-note-id="${noteId}"] [data-role="note-edge-l"]`)!;
    fireEvent.pointerDown(edge, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    expect(svg.querySelector('rect[fill="rgba(37,99,235,0.25)"]')).not.toBeNull();
    expect(svg.isConnected).toBe(true);
    fireEvent.pointerCancel(svg, { pointerId: 1 });
    expect(svg.querySelector('rect[fill="rgba(37,99,235,0.25)"]')).toBeNull();
    // The canceled gesture leaves the store untouched.
    expect(store.getState().projectHistory.past).toHaveLength(pastCount);
    // Click semantics restored: a plain click selects instead of leaving a
    // live drag behind.
    const bodyRect = svg.querySelector(`[data-note-id="${noteId}"] [data-role="note-body"]`)!;
    fireEvent.click(bodyRect);
    expect(store.getState().session.selection).toEqual({ kind: 'note', id: noteId });
  });
  it('ignores pointercancel for a foreign pointer: an active drag survives', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane') as unknown as SVGSVGElement;
    const setPointerCapture = vi.fn();
    svg.setPointerCapture = setPointerCapture;

    // Start a draw drag owned by pointer 1 and extend it: the ghost preview
    // appears and capture is taken for pointer 1.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(svg, { clientX: 160, clientY: 200, pointerId: 1, buttons: 1 });
    const ghost = 'rect[fill="rgba(37,99,235,0.35)"]';
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.querySelector(ghost)).not.toBeNull();

    // A SECOND concurrent touch pointer is canceled by OS gesture takeover;
    // it does NOT own the drag, so the owner's gesture must survive.
    fireEvent.pointerCancel(svg, { pointerId: 2 });
    expect(document.querySelector(ghost)).not.toBeNull();

    // The owner's drag is still live: further moves keep updating it…
    fireEvent.pointerMove(svg, { clientX: 300, clientY: 200, pointerId: 1, buttons: 1 });
    expect(document.querySelector(ghost)).not.toBeNull();

    // …and its pointerup still commits EXACTLY ONE note.
    fireEvent.pointerUp(svg, { pointerId: 1 });
    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(1);
    expect(notes[0]!.startTick).toBe(960); // 1 beat, NOTE_GRID-quantized
    expect(notes[0]!.durationTicks).toBe(6240); // 40px → 300px at 24px/beat
  });
});


describe('MelodyLane left-edge resize', () => {
  it('dispatches ONE atomic command → exactly one undo entry (§3.7/§3.8)', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    // Create a note: start 960, duration 1440 (end 2400).
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 200, pointerId: 1 });
    expect(selectMelodyNotes(store.getState())).toHaveLength(1);
    const pastAfterAdd = store.getState().projectHistory.past.length;

    // Drag the left edge from x=40 (tick 960) to x=70 (tick 1680).
    const edge = svg.querySelector('[data-role="note-edge-l"]');
    expect(edge).not.toBeNull();
    fireEvent.pointerDown(edge!, { clientX: 40, clientY: 200, button: 0, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 70, clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: 70, clientY: 200, pointerId: 2 });

    const notes = selectMelodyNotes(store.getState());
    expect(notes[0]!.startTick).toBe(1680);
    expect(notes[0]!.durationTicks).toBe(720); // right edge stays at 2400

    // The whole drag is ONE mutation → exactly one new undo entry.
    expect(store.getState().projectHistory.past).toHaveLength(pastAfterAdd + 1);

    // One undo restores the pre-drag note exactly.
    store.dispatch({ type: 'history/undo' });
    const restored = selectMelodyNotes(store.getState());
    expect(restored[0]!.startTick).toBe(960);
    expect(restored[0]!.durationTicks).toBe(1440);
  });
});


describe('MelodyLane resize-handle press', () => {
  it('pressing either resize handle SELECTS the note before any drag move', () => {
    // Same idiom as the §3.10 colors test: build the store state BEFORE
    // rendering, so the initial render already contains the note blocks.
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(setActiveToolCmd('drawNote'));
    store.dispatch(
      addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID * 4, midi: 60, velocity: 90 }),
    );
    store.dispatch(
      addNoteCmd({
        startTick: NOTE_GRID * 8,
        durationTicks: NOTE_GRID * 4,
        midi: 62,
        velocity: 90,
      }),
    );

    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );
    const svg = screen.getByTestId('melody-lane');

    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(2);
    const [firstId, secondId] = [notes[0]!.id, notes[1]!.id];

    const pastBefore = store.getState().projectHistory.past.length;

    for (const role of ['note-edge-l', 'note-edge-r'] as const) {
      // Pre-select the OTHER note: the edge press must REPLACE the selection.
      act(() => {
        store.dispatch(selectNoteCmd(secondId));
      });
      expect(store.getState().session.selection).toEqual({ kind: 'note', id: secondId });

      const edge = svg.querySelector(`[data-note-id="${firstId}"] [data-role="${role}"]`);
      expect(edge).not.toBeNull();
      fireEvent.pointerDown(edge!, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });

      expect(store.getState().session.selection).toEqual({ kind: 'note', id: firstId });
      // Selecting via the handle is not a mutation: no undo entry appeared.
      expect(store.getState().projectHistory.past).toHaveLength(pastBefore);

      // Release the armed resize drag without moving: still no mutation.
      fireEvent.pointerUp(svg, { clientX: 40, clientY: 200, pointerId: 1 });
      expect(store.getState().projectHistory.past).toHaveLength(pastBefore);
    }
  });

  it('handles shrink to at most a third of the body on a 1-grid-step note', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 }));
    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(1);

    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );
    const svg = screen.getByTestId('melody-lane');

    const group = svg.querySelector(`[data-note-id="${notes[0]!.id}"]`);
    const body = group?.querySelector('[data-role="note-body"]');
    const edgeL = group?.querySelector('[data-role="note-edge-l"]');
    const edgeR = group?.querySelector('[data-role="note-edge-r"]');
    expect(body).not.toBeNull();
    expect(edgeL).not.toBeNull();
    expect(edgeR).not.toBeNull();

    // Exact float equality is safe here: min and /3 ARE the production
    // expressions evaluated over the same width double (§1.7).
    const x = Number(body!.getAttribute('x'));
    const w = Number(body!.getAttribute('width'));
    expect(Number(edgeL!.getAttribute('width'))).toBe(Math.min(6, w / 3));
    expect(Number(edgeR!.getAttribute('x'))).toBe(x + w - Math.min(6, w / 3));
  });
});

describe('MelodyLane §3.10 classification colors', () => {
  it('paints a long note across two chords as TWO differently-filled underlays', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    // C major then G major; E4 (midi 64) spans both:
    // over C → chordTone (green), over G → 13th = availableTension (amber).
    store.dispatch(addChordRangeCmd({ startTick: 0, durationTicks: 960, chord: { root: C, templateId: 'maj' } }));
    store.dispatch(addChordRangeCmd({ startTick: 960, durationTicks: 960, chord: { root: parseSpelled('G')!, templateId: 'maj' } }));
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: 1920, midi: 64, velocity: 90 }));

    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );

    const group = document.querySelector('g[data-note-id]');
    expect(group).not.toBeNull();
    // Underlays carry a classification fill; outline/body/handles are
    // transparent or marked with a data-role.
    const underlays = Array.from(group!.querySelectorAll('rect')).filter(
      (rect) => !rect.hasAttribute('data-role') && rect.getAttribute('fill') !== 'transparent',
    );
    expect(underlays).toHaveLength(2);
    expect(underlays[0]!.getAttribute('fill')).toBe('#16a34a'); // chordTone
    expect(underlays[1]!.getAttribute('fill')).toBe('#d97706'); // availableTension
  });
});

describe('MelodyLane §3.20 viewport culling', () => {
  it('renders only notes intersecting the already-buffered visible range', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    // Project is 8 bars (8 × 3840 ticks). TimelineViewport passes the
    // render window already expanded by two buffer measures per side, so
    // a visible window [3, 5] bars arrives as [1, 7] bars. Notes form a
    // contiguous chain so no reducer-side neighbor clamping alters geometry.
    const BAR = 3840;
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: 2400, midi: 64, velocity: 90 })); // ends before the window
    store.dispatch(addNoteCmd({ startTick: 2400, durationTicks: 2880, midi: 65, velocity: 90 })); // crosses the left buffer edge
    store.dispatch(addNoteCmd({ startTick: 5280, durationTicks: 3840, midi: 67, velocity: 90 }));
    store.dispatch(addNoteCmd({ startTick: 9120, durationTicks: 3840, midi: 69, velocity: 90 }));
    store.dispatch(addNoteCmd({ startTick: 12960, durationTicks: 3840, midi: 71, velocity: 90 }));
    store.dispatch(addNoteCmd({ startTick: 16800, durationTicks: 3840, midi: 72, velocity: 90 })); // spans the visible end
    store.dispatch(addNoteCmd({ startTick: 20640, durationTicks: 3840, midi: 74, velocity: 90 })); // invisible, inside the right buffer
    store.dispatch(addNoteCmd({ startTick: 24480, durationTicks: 2400, midi: 76, velocity: 90 }));
    store.dispatch(addNoteCmd({ startTick: 7 * BAR, durationTicks: 960, midi: 77, velocity: 90 })); // starts exactly at the window end
    const byStart = new Map(selectMelodyNotes(store.getState()).map((n) => [n.startTick, n.id]));

    // Buffered range exactly as TimelineViewport computes it.
    const { unmount } = render(
      <Provider store={store}>
        <MelodyLane visibleRange={{ fromTick: BAR, toTick: 7 * BAR }} />
      </Provider>,
    );

    const rendered = new Set(
      Array.from(document.querySelectorAll('g[data-note-id]')).map((el) =>
        el.getAttribute('data-note-id'),
      ),
    );
    expect(rendered).toEqual(
      new Set([
        byStart.get(2400),
        byStart.get(5280),
        byStart.get(9120),
        byStart.get(12960),
        byStart.get(16800),
        byStart.get(20640),
        byStart.get(24480),
      ]),
    );
    unmount();
  });
});

describe('MelodyLane §3.7 melody replacement through a real draw gesture', () => {
  function renderLaneWithSeed(startTick: number, durationTicks: number) {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(setActiveToolCmd('drawNote'));
    store.dispatch(addNoteCmd({ startTick, durationTicks, midi: 64, velocity: 90 }));
    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );
    return store;
  }

  it('drawing over the middle third of a long note splits it into three distinct ids; one undo restores the original', () => {
    // Seed beats 1–4 (x = 40..160 at 40 px/beat); draw over beats 2–3.
    const store = renderLaneWithSeed(960, 2880);
    const svg = screen.getByTestId('melody-lane');
    const original = selectMelodyNotes(store.getState())[0]!;
    const pastBefore = store.getState().projectHistory.past.length;

    fireEvent.pointerDown(svg, { clientX: 80, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 120, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 120, clientY: 200, pointerId: 1 });

    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(3);
    expect(new Set(notes.map((n) => n.id)).size).toBe(3);
    expect(notes.map((n) => n.id)).not.toContain(original.id);

    // Sorted by startTick: left fragment | new note | right fragment,
    // contiguous coverage of the original span preserved.
    const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
    expect([sorted[0]!.startTick, sorted[0]!.durationTicks]).toEqual([960, 960]);
    expect([sorted[1]!.startTick, sorted[1]!.durationTicks]).toEqual([1920, 960]);
    expect(sorted[2]!.startTick).toBe(2880);
    expect(sorted[2]!.durationTicks).toBe(960);
    expect(sorted[0]!.startTick + sorted[0]!.durationTicks).toBe(sorted[1]!.startTick);
    expect(sorted[1]!.startTick + sorted[1]!.durationTicks).toBe(sorted[2]!.startTick);

    // ONE canonical mutation → one new undo entry (§3.8).
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore + 1);

    store.dispatch({ type: 'history/undo' });
    expect(selectMelodyNotes(store.getState())).toEqual([original]);
  });

  it('drawing fully over an existing shorter note removes the old event entirely', () => {
    // Seed beats 1–2; draw exactly over x = 40..80 (ticks 960..1920).
    const store = renderLaneWithSeed(960, 960);
    const svg = screen.getByTestId('melody-lane');
    const oldId = selectMelodyNotes(store.getState())[0]!.id;
    const pastBefore = store.getState().projectHistory.past.length;

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 80, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 80, clientY: 200, pointerId: 1 });

    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).not.toBe(oldId);
    expect(notes[0]!.startTick).toBe(960);
    expect(notes[0]!.durationTicks).toBe(960);
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore + 1);
  });
});

describe('NoteBlock keyboard selection (a11y)', () => {
  it('Enter on a focused note body selects the note; Space bubbles to transport; other keys do nothing', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 }));
    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );
    const svg = screen.getByTestId('melody-lane');
    const body = svg.querySelector('[data-role="note-body"]') as SVGRectElement;
    expect(body.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(body, { key: 'Enter' });
    expect(store.getState().session.selection).toMatchObject({ kind: 'note' });

    act(() => {
      store.dispatch(clearSelectionCmd());
    });
    expect(store.getState().session.selection).toBeNull();

    // Space is NOT select: it must bubble to the global play/pause shortcut
    // (a focused note must not silence the transport toggle). In this lane-
    // only render nothing handles it, so the selection stays untouched.
    fireEvent.keyDown(body, { key: ' ' });
    expect(store.getState().session.selection).toBeNull();

    fireEvent.keyDown(body, { key: 'a' });
    expect(store.getState().session.selection).toBeNull();
  });
});

describe('MelodyLane pointercancel then keyboard select (dragMovedRef reset)', () => {
  it('a cancelled mid-move gesture does not swallow the next Enter-select on a note', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 90 }));
    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );
    const svg = screen.getByTestId('melody-lane');
    const body = svg.querySelector('[data-role="note-body"]') as SVGRectElement;

    // Start a move drag on the note body and actually move it —
    // dragMovedRef flips true.
    fireEvent.pointerDown(body, { clientX: 20, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 120, clientY: 200, pointerId: 1 });

    // Gesture cancelled mid-move; no pointerup will come.
    fireEvent.pointerCancel(svg, { pointerId: 1 });

    // endDrag() resets dragMovedRef → Enter still selects. With the stale
    // flag this dispatch was silently dropped.
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(store.getState().session.selection).toMatchObject({ kind: 'note' });
  });
});

// Default zoom 40 px/beat → 1 tick = 1/24 px, so NOTE_GRID (240) = 10px.
describe('MelodyLane draw ghost quantization', () => {
  /** The draw ghost is the only lane rect painted rgba(37,99,235,0.35). */
  function drawGhostRect(svg: Element): SVGRectElement {
    const rect = Array.from(svg.querySelectorAll('rect')).find(
      (candidate) => candidate.getAttribute('fill') === 'rgba(37,99,235,0.35)',
    );
    expect(rect).toBeDefined();
    return rect!;
  }

  it('ghost steps in NOTE_GRID units: sub-grid pointer jitter leaves it put', () => {
    renderLane();
    const svg = screen.getByTestId('melody-lane');

    // Anchor at 40px = 960 ticks; the ghost starts as one 1/16 cell.
    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    const ghost = drawGhostRect(svg);
    expect(ghost.getAttribute('x')).toBe(String(tickToX(960, 40)));
    expect(ghost.getAttribute('width')).toBe(String(tickToX(NOTE_GRID, 40)));

    // A few pixels of raw movement stay inside the same grid cell —
    // the preview must not move until the quantized geometry steps.
    fireEvent.pointerMove(svg, { clientX: 44, clientY: 200, pointerId: 1 });
    expect(drawGhostRect(svg).getAttribute('x')).toBe(String(tickToX(960, 40)));
    expect(drawGhostRect(svg).getAttribute('width')).toBe(String(tickToX(NOTE_GRID, 40)));

    // Crossing into the next duration cell grows the ghost by exactly one
    // grid step (65px = 1560 ticks → quantized duration 480).
    fireEvent.pointerMove(svg, { clientX: 65, clientY: 200, pointerId: 1 });
    expect(drawGhostRect(svg).getAttribute('width')).toBe(String(tickToX(2 * NOTE_GRID, 40)));
    expect(drawGhostRect(svg).getAttribute('x')).toBe(String(tickToX(960, 40)));
  });

  it('dragging left of the anchor snaps the ghost start down to the grid', () => {
    renderLane();
    const svg = screen.getByTestId('melody-lane');

    fireEvent.pointerDown(svg, { clientX: 40, clientY: 200, button: 0, pointerId: 1 });
    // 30px = 720 ticks → quantized start 720, one grid cell wide.
    fireEvent.pointerMove(svg, { clientX: 30, clientY: 200, pointerId: 1 });
    const ghost = drawGhostRect(svg);
    expect(ghost.getAttribute('x')).toBe(String(tickToX(720, 40)));
    expect(ghost.getAttribute('width')).toBe(String(tickToX(NOTE_GRID, 40)));
  });
});
