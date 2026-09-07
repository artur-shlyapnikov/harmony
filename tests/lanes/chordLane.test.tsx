/**
 * @vitest-environment jsdom
 *
 * ChordLane interactions (§3.20): empty-area click sets a range selection
 * snapped to CHORD_GRID (min one bar); block click selects the chord.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';

import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID, TICKS_PER_BAR } from '@domain/timeline/constants';
import {
  addChordRangeCmd,
  clearSelectionCmd,
  openProjectCmd,
  selectChordCmd,
  selectRangeCmd,
  setChordPatternOverrideCmd,
} from '@state/commands';
import { ChordLane } from '@features/editor/ChordLane';
import { tickToX } from '@features/editor/timelineGeometry';
import { selectSelection, selectToasts, selectViewport } from '@state/selectors';

const C = parseSpelled('C')!;

function setup() {
  const store = makeStore();
  store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
  render(
    <Provider store={store}>
      <ChordLane />
    </Provider>,
  );
  return store;
}

describe('ChordLane empty-area range selection', () => {
  it('creates a one-bar range selection on a plain click', () => {
    const store = setup();
    const lane = screen.getByTestId('chord-lane');

    fireEvent.pointerDown(lane, { clientX: 0, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 0, clientY: 20, pointerId: 1 });

    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: 0,
      durationTicks: CHORD_GRID,
    });
  });

  it('snaps a drag to the chord grid', () => {
    const store = setup();
    const lane = screen.getByTestId('chord-lane');

    // 40px = 1 beat; drag to 200px = 5 beats → [960..4800] quantized.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 200, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 200, clientY: 20, pointerId: 1 });

    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: 960,
      durationTicks: 3840,
    });
  });
});

describe('ChordLane pointer capture', () => {
  it('captures only on a pressed drag, never on plain hover', () => {
    setup();
    const lane = screen.getByTestId('chord-lane') as unknown as HTMLDivElement;
    const setPointerCapture = vi.fn();
    lane.setPointerCapture = setPointerCapture;

    // Hover with no buttons pressed must NOT capture: a mouse is an active
    // pointer per Pointer Events L3, so a hover capture would retarget every
    // later pointerdown to the lane root and break block hit-testing.
    fireEvent.pointerMove(lane, { clientX: 60, clientY: 20, pointerId: 1, buttons: 0 });
    expect(setPointerCapture).not.toHaveBeenCalled();

    // A pressed range drag captures lazily on the first move.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(lane, { clientX: 200, clientY: 20, pointerId: 1, buttons: 1 });
    expect(setPointerCapture).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
  });
  it('never captures a pressed gesture that started outside a lane drag', () => {
    setup();
    const lane = screen.getByTestId('chord-lane') as unknown as HTMLDivElement;
    const setPointerCapture = vi.fn();
    lane.setPointerCapture = setPointerCapture;

    // A press that started elsewhere (e.g. a velocity slider drag) crossing
    // the lane must not be stolen: capture only applies to drags active in
    // THIS lane.
    fireEvent.pointerMove(lane, { clientX: 60, clientY: 20, pointerId: 1, buttons: 1 });
    expect(setPointerCapture).not.toHaveBeenCalled();

    // Pen barrel-button hover reports buttons=2 without contact, and
    // right/middle mouse drags are not lane gestures either.
    fireEvent.pointerMove(lane, { clientX: 60, clientY: 20, pointerId: 1, buttons: 2 });
    expect(setPointerCapture).not.toHaveBeenCalled();
  });
  it('pointercancel aborts the range drag: nothing committed, next drag starts fresh', () => {
    const store = setup();
    const lane = screen.getByTestId('chord-lane') as unknown as HTMLDivElement;
    const setPointerCapture = vi.fn();
    lane.setPointerCapture = setPointerCapture;

    // Start a range drag and extend it.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(lane, { clientX: 240, clientY: 20, pointerId: 1, buttons: 1 });

    // Touch interrupted / browser gesture takeover: no pointerup will come.
    fireEvent.pointerCancel(lane, { pointerId: 1 });

    // A stale move with the button held must NOT resume the aborted drag,
    // and its release must not commit a range selection.
    fireEvent.pointerMove(lane, { clientX: 320, clientY: 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(lane, { pointerId: 1 });
    expect(selectSelection(store.getState())).toBeNull();

    // A brand-new press-drag-release still selects a range normally.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 2, buttons: 1 });
    fireEvent.pointerMove(lane, { clientX: 240, clientY: 20, pointerId: 2, buttons: 1 });
    fireEvent.pointerUp(lane, { pointerId: 2 });
    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: 960,
      durationTicks: 4800,
    });
  });
  it('pointercancel before any pointermove aborts an unmoved range drag', () => {
    const store = setup();
    const lane = screen.getByTestId('chord-lane') as unknown as HTMLDivElement;
    const setPointerCapture = vi.fn();
    lane.setPointerCapture = setPointerCapture;
    const ghost = (): HTMLDivElement | null =>
      Array.from(lane.querySelectorAll<HTMLDivElement>('div')).find(
        (el) => el.style.background.replaceAll(' ', '') === 'rgba(37,99,235,0.2)',
      ) ?? null;

    // Press starting a range drag: the ghost appears immediately and
    // capture is taken EAGERLY on the pressed element (lane root), so a
    // first move that exits the lane cannot orphan the drag.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1, buttons: 1 });
    expect(ghost()).not.toBeNull();
    expect(setPointerCapture).toHaveBeenCalledWith(1);

    // Touch gesture takeover cancels BEFORE any pointermove: the unmoved
    // drag must still abort cleanly.
    fireEvent.pointerCancel(lane, { pointerId: 1 });

    // Ghost cleared.
    expect(ghost()).toBeNull();

    // A stale move with the button held must NOT resume the aborted drag,
    // and its release must not commit a range selection.
    fireEvent.pointerMove(lane, { clientX: 320, clientY: 20, pointerId: 1, buttons: 1 });
    expect(ghost()).toBeNull();
    fireEvent.pointerUp(lane, { pointerId: 1 });
    expect(selectSelection(store.getState())).toBeNull();

    // Plain click semantics restored: press-release selects a one-bar range.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 40, clientY: 20, pointerId: 1 });
    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: 960,
      durationTicks: CHORD_GRID,
    });
  });
  it('ignores pointercancel for a foreign pointer: an active drag survives', () => {
    const store = setup();
    const lane = screen.getByTestId('chord-lane') as unknown as HTMLDivElement;
    const setPointerCapture = vi.fn();
    lane.setPointerCapture = setPointerCapture;

    // Start a range drag owned by pointer 1 and extend it: the ghost preview
    // appears and capture is taken for pointer 1.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(lane, { clientX: 240, clientY: 20, pointerId: 1, buttons: 1 });
    // The range ghost is the only lane child painted rgba(37,99,235,0.2).
    const ghost = (): HTMLDivElement | null =>
      Array.from(lane.querySelectorAll<HTMLDivElement>('div')).find(
        (el) => el.style.background.replaceAll(' ', '') === 'rgba(37,99,235,0.2)',
      ) ?? null;
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(ghost()).not.toBeNull();

    // A SECOND concurrent touch pointer is canceled by OS gesture takeover;
    // it does NOT own the drag, so the owner's gesture must survive.
    fireEvent.pointerCancel(lane, { pointerId: 2 });
    expect(ghost()).not.toBeNull();

    // The owner's drag is still live: further moves keep updating it…
    fireEvent.pointerMove(lane, { clientX: 320, clientY: 20, pointerId: 1, buttons: 1 });
    expect(ghost()).not.toBeNull();

    // …and its pointerup still commits EXACTLY ONE range selection.
    fireEvent.pointerUp(lane, { pointerId: 1 });
    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: 960,
      durationTicks: 6720,
    });
  });
});


describe('ChordLane block selection', () => {
  it('clicking a block selects its chord id', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj7' } }),
      );
    });
    const id = store.getState().projectHistory.present?.harmony.chords[0]?.id as string;
    const lane = screen.getByTestId('chord-lane');

    fireEvent.click(lane.querySelector(`[data-chord-id="${id}"]`) as HTMLElement);

    expect(selectSelection(store.getState())).toEqual({ kind: 'chord', id });
  });

  it('selects the chord when pressing its resize edge without dragging', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj7' } }),
      );
    });
    const id = store.getState().projectHistory.present?.harmony.chords[0]?.id as string;
    const lane = screen.getByTestId('chord-lane');
    const edge = lane.querySelector(
      `[data-chord-id="${id}"] [data-role="chord-edge-l"]`,
    ) as HTMLElement;

    fireEvent.pointerDown(edge, { clientX: 0, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 0, clientY: 20, pointerId: 1 });

    expect(selectSelection(store.getState())).toEqual({ kind: 'chord', id });
  });

  it('dispatches move when a block is dragged horizontally', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });
    const id = store.getState().projectHistory.present?.harmony.chords[0]?.id as string;
    store.dispatch(selectChordCmd(id));
    const lane = screen.getByTestId('chord-lane');
    const block = lane.querySelector(`[data-chord-id="${id}"]`) as HTMLElement;
    // Press at x=40 (tick 960) → grab offset = 960; release at x=240
    // (tick 5760) → new start = 5760 - 960 = 4800, grid-aligned.
    // (The block's own left edge stays under the cursor.)
    fireEvent.pointerDown(block, { clientX: 40, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 240, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 240, clientY: 20, pointerId: 1 });

    expect(
      store.getState().projectHistory.present?.harmony.chords[0]?.startTick,
    ).toBe(4800);
 
  });
});


describe('ChordLane pattern-override marker (§3.20)', () => {
  it('shows the ♪ marker iff the chord carries a patternOverride, and drops it when the override is cleared', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });
    const id = store.getState().projectHistory.present?.harmony.chords[0]?.id as string;
    const lane = screen.getByTestId('chord-lane');

    // No override → no marker.
    expect(lane.querySelector('.chord-block-pattern')).toBeNull();

    const pattern = {
      kind: 'up' as const,
      subdivisionTicks: 480 as const,
      gate: 0.8,
      octaveSpan: 1 as const,
      velocity: 80,
    };
    act(() => {
      setChordPatternOverrideCmd({ id, pattern })(store.dispatch, store.getState);
    });
    const marker = lane.querySelector('.chord-block-pattern');
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute('title')).toBe('Переопределён паттерн');

    // Clearing the override removes the marker again.
    act(() => {
      setChordPatternOverrideCmd({ id, pattern: null })(store.dispatch, store.getState);
    });
    expect(lane.querySelector('.chord-block-pattern')).toBeNull();
  });
});


describe('ChordBlock keyboard selection (a11y)', () => {
  it('Enter on a focused block selects its chord; Space bubbles to transport; other keys do nothing', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });

    const block = document.querySelector('.chord-block') as HTMLElement;
    expect(block.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(block, { key: 'Enter' });
    expect(selectSelection(store.getState())).toMatchObject({ kind: 'chord' });

    act(() => {
      store.dispatch(clearSelectionCmd());
    });
    expect(selectSelection(store.getState())).toBeNull();

    // Space bubbles to the global play/pause shortcut — never select.
    fireEvent.keyDown(block, { key: ' ' });
    expect(selectSelection(store.getState())).toBeNull();

    fireEvent.keyDown(block, { key: 'a' });
    expect(selectSelection(store.getState())).toBeNull();
  });
});

describe('ChordBlock native tooltip (§3.20)', () => {
  it('carries symbol + roman numeral as a title so the info stays accessible at any container width', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });

    const block = document.querySelector('.chord-block') as HTMLElement;
    expect(block).not.toBeNull();
    const symbol = block.querySelector('.chord-block-symbol')!.textContent;
    const roman = block.querySelector('.chord-block-roman')!.textContent;
    // §3.20: every chord block keeps its roman numeral reachable even when
    // @container (max-width:64px) hides .chord-block-roman.
    expect(block.getAttribute('title')).toBe(`${symbol} (${roman})`);
  });
});

describe('ChordLane left-edge atomic resize (RevUI-1)', () => {
  it('a left-edge drag produces ONE history entry with correct geometry', () => {
    const store = setup();
    act(() => {
      // A=[0..960], B=[1920..2880], C=[2880..3840]; distinct roots so
      // flush neighbors do not merge.
      store.dispatch(addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }));
      store.dispatch(addChordRangeCmd({ startTick: 2 * CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: parseSpelled('D')!, templateId: 'maj' } }));
      store.dispatch(addChordRangeCmd({ startTick: 3 * CHORD_GRID, durationTicks: CHORD_GRID, chord: { root: parseSpelled('E')!, templateId: 'maj' } }));
    });

    const chordsBefore = store.getState().projectHistory.present?.harmony.chords ?? [];
    expect(chordsBefore).toHaveLength(3);
    const middleId = chordsBefore[1]!.id;
    const pastBefore = store.getState().projectHistory.past.length;
    const toastsBefore = selectToasts(store.getState()).length;

    const lane = screen.getByTestId('chord-lane');
    const edge = lane.querySelector(
      `[data-chord-id="${middleId}"] [data-role="chord-edge-l"]`,
    ) as HTMLElement;

    // Drag B's left edge to x=40 (tick 960 at the default zoom).
    fireEvent.pointerDown(edge, { clientX: 200, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 40, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 40, clientY: 20, pointerId: 1 });

    const chords = store.getState().projectHistory.present?.harmony.chords ?? [];
    expect(chords).toHaveLength(3);
    expect(chords[1]!.startTick).toBe(CHORD_GRID); // B = [960..2880]
    expect(chords[1]!.durationTicks).toBe(2 * CHORD_GRID);
    expect(chords[0]!.startTick).toBe(0);
    expect(chords[2]!.startTick).toBe(3 * CHORD_GRID);
    // Exactly ONE undo entry for the whole drag; no error toast.
    expect(store.getState().projectHistory.past).toHaveLength(pastBefore + 1);
    expect(selectToasts(store.getState())).toHaveLength(toastsBefore);
  });
});

describe('ChordLane §3.20 viewport culling', () => {
  it('renders only chords intersecting the already-buffered visible range', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    // Project is 8 bars (1 bar = 4 × CHORD_GRID). Contiguous one-bar
    // chords tile bars 0..7. TimelineViewport passes the render window
    // already expanded by two buffer measures per side, so a visible
    // window [3, 5] bars arrives as [1, 7] bars.
    const BAR = 4 * CHORD_GRID;
    const roots = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'];
    act(() => {
      for (let bar = 0; bar < 8; bar++) {
        store.dispatch(
          addChordRangeCmd({
            startTick: bar * BAR,
            durationTicks: BAR,
            chord: { root: parseSpelled(roots[bar]!)!, templateId: 'maj' },
          }),
        );
      }
    });
    const byStart = new Map(
      (store.getState().projectHistory.present?.harmony.chords ?? []).map((c) => [c.startTick, c.id]),
    );

    // Buffered range exactly as TimelineViewport computes it.
    const { unmount } = render(
      <Provider store={store}>
        <ChordLane visibleRange={{ fromTick: BAR, toTick: 7 * BAR }} />
      </Provider>,
    );

    const rendered = new Set(
      Array.from(document.querySelectorAll('[data-chord-id]')).map((el) =>
        el.getAttribute('data-chord-id'),
      ),
    );
    // Bars 0 and 7 are outside the buffered window; bars 1..6 render
    // (bars 1 and 6 only via the two-measure buffer).
    const expected = new Set(
      [1, 2, 3, 4, 5, 6].map((bar) => byStart.get(bar * BAR)),
    );
    expect(rendered).toEqual(expected);
    unmount();
  });
});

// LANE-H2 (round 5): the empty-lane affordance is a conditional render on
// chords.length === 0 — copy verbatim from ChordLane.tsx. Position/stickiness
// is CSS and deliberately not asserted.
describe('ChordLane empty-state hint', () => {
  it('shows the drag hint only while the lane has no chords, hiding it once a chord exists', () => {
    const store = setup();
    expect(screen.getByText('Кликните и потяните, чтобы выбрать диапазон')).toBeTruthy();

    act(() => {
      store.dispatch(
        addChordRangeCmd({
          startTick: 0,
          durationTicks: CHORD_GRID,
          chord: { root: C, templateId: 'maj' },
        }),
      );
    });

    expect(screen.queryByText('Кликните и потяните, чтобы выбрать диапазон')).toBeNull();
  });

  it('hides the hint while a range selection is active — the highlight and suggestion panel already acknowledge the gesture', () => {
    const store = setup();
    act(() => {
      store.dispatch(selectRangeCmd(0, CHORD_GRID));
    });

    expect(screen.queryByText('Кликните и потяните, чтобы выбрать диапазон')).toBeNull();
  });
});

describe('ChordLane barlines (CHORD-GEOM-1)', () => {
  const barlines = (lane: HTMLElement): HTMLElement[] =>
    Array.from(lane.children).filter(
      (el) => (el as HTMLElement).style.opacity === '0.9',
    ) as HTMLElement[];

  it('draws one barline per MEASURE at measure positions, not one per beat', () => {
    const store = setup();
    const lane = screen.getByTestId('chord-lane');
    const zoom = selectViewport(store.getState()).zoomPxPerBeat;

    // Project is 8 bars: bars 0..7 plus the closing line at the project end.
    const lines = barlines(lane);
    expect(lines).toHaveLength(8 + 1);
    const lefts = lines.map((line) => parseFloat(line.style.left));
    expect(lefts[0]).toBe(0);
    const spacing = tickToX(TICKS_PER_BAR, zoom);
    lefts.slice(1).forEach((left, index) => {
      expect(left - lefts[index]!).toBeCloseTo(spacing);
    });
  });

  it('clamps barlines to the project bar count when the buffered range overshoots the end', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    render(
      <Provider store={store}>
        <ChordLane visibleRange={{ fromTick: 6 * TICKS_PER_BAR, toTick: 12 * TICKS_PER_BAR }} />
      </Provider>,
    );
    const lane = screen.getByTestId('chord-lane');
    const zoom = selectViewport(store.getState()).zoomPxPerBeat;

    // Bars 6..8 only — nothing past the end of the 8-bar project.
    const lefts = barlines(lane).map((line) => parseFloat(line.style.left));
    expect(lefts).toHaveLength(3);
    expect(Math.max(...lefts)).toBeCloseTo(tickToX(8 * TICKS_PER_BAR, zoom));
  });
});

describe('ChordLane range-drag ghost (CHORD-GEOM-2)', () => {
  it('previews the exact quantized geometry the pointerup commit dispatches — no snap on release', () => {
    const store = setup();
    const lane = screen.getByTestId('chord-lane');
    const zoom = selectViewport(store.getState()).zoomPxPerBeat;

    // Anchor at x=40 (tick 960); drag to x=210 → tick 5040. The commit
    // floors the duration to 4 beats; the ghost must show [960..4800]
    // BEFORE release, i.e. width 160px, not the raw 170px.
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 210, clientY: 20, pointerId: 1 });

    const ghost = Array.from(lane.querySelectorAll<HTMLElement>('div')).find(
      (el) => el.style.background.replaceAll(' ', '') === 'rgba(37,99,235,0.2)',
    );
    expect(ghost).not.toBeNull();
    expect(parseFloat(ghost!.style.left)).toBe(tickToX(CHORD_GRID, zoom));
    expect(parseFloat(ghost!.style.width)).toBe(tickToX(4 * CHORD_GRID, zoom));

    // Release lands on exactly the previewed geometry.
    fireEvent.pointerUp(lane, { clientX: 210, clientY: 20, pointerId: 1 });
    expect(selectSelection(store.getState())).toEqual({
      kind: 'range',
      startTick: CHORD_GRID,
      durationTicks: 4 * CHORD_GRID,
    });
  });
});

describe('ChordLane edge-handle double-click (CHORD-GEOM-3)', () => {
  it('never captures eagerly on edge press, so double-clicking an edge still opens the picker', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });
    const id = store.getState().projectHistory.present?.harmony.chords[0]?.id as string;
    const lane = screen.getByTestId('chord-lane') as unknown as HTMLDivElement;
    const setPointerCapture = vi.fn();
    lane.setPointerCapture = setPointerCapture;
    const edge = lane.querySelector(
      `[data-chord-id="${id}"] [data-role="chord-edge-r"]`,
    ) as HTMLElement;

    // Pressing a resize edge starts a resize drag but must NOT capture yet:
    // an eager capture retargets the compatibility click/dblclick away from
    // the chord block and the picker could never open. Capture stays lazy
    // (first drag move), matching the lane-wide convention.
    fireEvent.pointerDown(edge, { clientX: 39, clientY: 20, button: 0, pointerId: 1 });
    expect(setPointerCapture).not.toHaveBeenCalled();

    fireEvent.doubleClick(edge);
    expect(screen.getByTestId('chord-picker')).toBeTruthy();
  });
});

describe('ChordLane picker overlay press guard (data-modal)', () => {
  it('pressing the dimmed picker backdrop does NOT start a lane range-drag', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });

    // Open the picker via the block's double-click (§3.20 edit flow).
    fireEvent.doubleClick(document.querySelector('.chord-block') as HTMLElement);
    const overlay = screen.getByTestId('chord-picker');

    // A fresh selection state: only a press leaking past the guard could
    // create a range here.
    act(() => {
      store.dispatch(clearSelectionCmd());
    });

    // The picker renders INSIDE the lane div, so this pointerdown bubbles to
    // the lane handler — exactly the production path the [data-modal] guard
    // must short-circuit.
    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 20, button: 0, pointerId: 1 });
    expect(selectSelection(store.getState())).toBeNull();

    // The matching release must not commit a range either.
    fireEvent.pointerUp(overlay, { clientX: 10, clientY: 20, pointerId: 1 });
    expect(selectSelection(store.getState())).toBeNull();
  });
});

describe('ChordLane pointercancel then keyboard select (dragMovedRef reset)', () => {
  it('a cancelled mid-move gesture does not swallow the next Enter-select on a block', () => {
    const store = setup();
    act(() => {
      store.dispatch(
        addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
      );
    });
    const id = store.getState().projectHistory.present?.harmony.chords[0]?.id as string;
    const block = document.querySelector(
      `[data-chord-id="${id}"].chord-block`,
    ) as HTMLElement;

    // Start a move drag and actually move it — dragMovedRef flips true.
    fireEvent.pointerDown(block, { clientX: 20, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(screen.getByTestId('chord-lane'), {
      clientX: 200,
      clientY: 20,
      pointerId: 1,
    });

    // Gesture cancelled mid-move; no pointerup will come.
    fireEvent.pointerCancel(screen.getByTestId('chord-lane'), { pointerId: 1 });

    // endDrag() resets dragMovedRef → Enter still selects. With the stale
    // flag this dispatch was silently dropped.
    fireEvent.keyDown(block, { key: 'Enter' });
    expect(selectSelection(store.getState())).toEqual({ kind: 'chord', id });
  });
});

// Default zoom 40 px/beat → CHORD_GRID (960) = 40px.
describe('ChordLane range ghost grid stepping', () => {
  /** The range ghost is the only lane child painted rgba(37,99,235,0.2). */
  function rangeGhost(lane: Element): HTMLDivElement {
    const div = Array.from(lane.querySelectorAll('div')).find(
      (candidate) =>
        (candidate as HTMLElement).style.background.replaceAll(' ', '') ===
        'rgba(37,99,235,0.2)',
    );
    expect(div).toBeDefined();
    return div as HTMLDivElement;
  }

  it('range highlight steps in CHORD_GRID units: sub-grid jitter leaves it put', () => {
    setup();
    const lane = screen.getByTestId('chord-lane');

    // Anchor press at 40px → quantized anchor 960; the ghost starts as one
    // bar cell (min duration = CHORD_GRID).
    fireEvent.pointerDown(lane, { clientX: 40, clientY: 20, button: 0, pointerId: 1 });
    expect(rangeGhost(lane).style.left).toBe(`${tickToX(960, 40)}px`);
    expect(rangeGhost(lane).style.width).toBe(`${tickToX(CHORD_GRID, 40)}px`);

    // A few pixels of raw movement stay inside the same grid cell — the
    // highlight must not move until the quantized geometry steps.
    fireEvent.pointerMove(lane, { clientX: 60, clientY: 20, pointerId: 1 });
    expect(rangeGhost(lane).style.left).toBe(`${tickToX(960, 40)}px`);
    expect(rangeGhost(lane).style.width).toBe(`${tickToX(CHORD_GRID, 40)}px`);

    // Crossing into the next duration cell grows the highlight by exactly
    // one grid step (121px = 2904 ticks → quantized duration 1920).
    fireEvent.pointerMove(lane, { clientX: 121, clientY: 20, pointerId: 1 });
    expect(rangeGhost(lane).style.width).toBe(`${tickToX(2 * CHORD_GRID, 40)}px`);
    expect(rangeGhost(lane).style.left).toBe(`${tickToX(960, 40)}px`);

    // Dragging left of the anchor snaps the start down to the grid.
    fireEvent.pointerMove(lane, { clientX: 30, clientY: 20, pointerId: 1 });
    expect(rangeGhost(lane).style.left).toBe(`${tickToX(0, 40)}px`);
    expect(rangeGhost(lane).style.width).toBe(`${tickToX(CHORD_GRID, 40)}px`);
  });
});