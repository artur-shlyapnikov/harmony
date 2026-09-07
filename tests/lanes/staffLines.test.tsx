/**
 * @vitest-environment jsdom
 *
 * GEO-1: pitch rows render as DEFAULT_ROW_HEIGHT_PX-px bands and rowToY
 * returns the band TOP. Staff and ledger lines must be drawn at the band
 * CENTER — the same y the note heads (rowToY + height/2) and click mapping
 * use — so a note sitting on a staff-line row is crossed by its line and
 * ledger lines cross the heads they belong to.
 */

import { describe, expect, it } from 'vitest';
import { Provider } from 'react-redux';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { INITIAL_BARS, TICKS_PER_BAR } from '@domain/timeline/constants';
import {
  addNoteCmd,
  openProjectCmd,
  setActiveToolCmd,
} from '@state/commands';
import { selectMelodyNotes } from '@state/selectors';
import { MelodyLane } from '@features/editor/MelodyLane';
import {
  DEFAULT_ROW_HEIGHT_PX,
  MELODY_ROW_MAX_MIDI,
  STAFF_LINE_ROWS,
  ledgerRowsForRow,
  midiToRow,
  rowToY,
} from '@features/editor/timelineGeometry';

const C = parseSpelled('C')!;

// Mirrors MelodyLane's local ROW_AXIS.
const AXIS = { topMidi: MELODY_ROW_MAX_MIDI, rowHeight: DEFAULT_ROW_HEIGHT_PX } as const;

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

/** Horizontal #454d5c pitch lines; grid lines are vertical. */
function horizontalPitchLines(svg: Element): SVGLineElement[] {
  return Array.from(svg.querySelectorAll('line')).filter((line) => {
    const y1 = Number(line.getAttribute('y1'));
    return line.getAttribute('stroke') === '#454d5c' && y1 === Number(line.getAttribute('y2'));
  });
}

/** Y values of the horizontal segments in the ledger path (`M x y H x'`). */
function ledgerPathYs(svg: Element): number[] {
  const d = svg.querySelector('path[stroke="#454d5c"]')?.getAttribute('d') ?? '';
  return Array.from(
    d.matchAll(/M\s*-?[\d.]+\s+([\d.]+)H/g),
    (m) => Number(m[1]),
  ).sort((a, b) => a - b);
}

describe('MelodyLane staff/ledger line geometry (GEO-1)', () => {
  it('draws the five staff lines at row band centers', () => {
    renderLane();
    const svg = screen.getByTestId('melody-lane');

    const expected = STAFF_LINE_ROWS.map(
      (row) => rowToY(row, AXIS) + DEFAULT_ROW_HEIGHT_PX / 2,
    );
    const ys = horizontalPitchLines(svg)
      .map((line) => Number(line.getAttribute('y1')))
      .sort((a, b) => a - b);
    expect(horizontalPitchLines(svg).length).toBe(STAFF_LINE_ROWS.length);
    expect(ys).toEqual([...expected].sort((a, b) => a - b));
  });

  it('draws ledger lines at row band centers', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    // Top lane row (C7): every line down to the staff top is a ledger line.
    store.dispatch(
      addNoteCmd({ startTick: 0, durationTicks: 960, midi: MELODY_ROW_MAX_MIDI, velocity: 90 }),
    );
    render(
      <Provider store={store}>
        <MelodyLane />
      </Provider>,
    );
    const svg = screen.getByTestId('melody-lane');

    const topRow = midiToRow(MELODY_ROW_MAX_MIDI);
    const expectedLedger = ledgerRowsForRow(topRow).map(
      (row) => rowToY(row, AXIS) + DEFAULT_ROW_HEIGHT_PX / 2,
    );
    expect(expectedLedger.length).toBeGreaterThan(0);

    const ys = ledgerPathYs(svg);
    // Over-draw guard: every OBSERVED line must sit on a staff row or an
    // expected ledger row — `toContain` above can't catch extra lines.
    const staffYs = STAFF_LINE_ROWS.map(
      (row) => rowToY(row, AXIS) + DEFAULT_ROW_HEIGHT_PX / 2,
    );
    const allowed = new Set([...staffYs, ...expectedLedger]);
    for (const y of ys) {
      expect(allowed.has(y)).toBe(true);
    }
    for (const y of expectedLedger) {
      expect(ys).toContain(y);
    }
  });

  it('clamps the draw ghost to the lane end when dragging past project end', () => {
    const store = renderLane();
    const svg = screen.getByTestId('melody-lane');

    // Default zoom 40 px/beat → 1 beat = 40px; project is INITIAL_BARS bars.
    const width = Number(svg.getAttribute('width'));
    expect(width).toBe((INITIAL_BARS * TICKS_PER_BAR * 40) / 960);
    const lastBeatX = width - 40;

    fireEvent.pointerDown(svg, { clientX: lastBeatX, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: lastBeatX + 80, buttons: 1, pointerId: 1 });

    // Draw ghost must not extend beyond the lane while dragging…
    const ghost = svg.querySelector('rect[fill="rgba(37,99,235,0.35)"]')!;
    expect(ghost).not.toBeNull();
    const rightEdge = Number(ghost.getAttribute('x')) + Number(ghost.getAttribute('width'));
    expect(rightEdge).toBeLessThanOrEqual(width);

    // …and the committed note must end within the project length too.
    fireEvent.pointerUp(svg, { clientX: lastBeatX + 80, pointerId: 1 });
    const notes = selectMelodyNotes(store.getState());
    expect(notes).toHaveLength(1);
    expect(notes[0]!.startTick + notes[0]!.durationTicks).toBeLessThanOrEqual(
      INITIAL_BARS * TICKS_PER_BAR,
    );
  });
});
