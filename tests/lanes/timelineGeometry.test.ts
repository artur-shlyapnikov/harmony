/**
 * Pinned-value tests for timeline geometry (§3.20 Timeline viewport).
 */

import { describe, expect, it } from 'vitest';

import { TICKS_PER_BAR, TICKS_PER_BEAT } from '@domain/timeline/constants';
import {
  B4_ROW,
  DEFAULT_ROW_HEIGHT_PX,
  LANE_BOTTOM_ROW,
  LANE_TOP_ROW,
  MAX_ZOOM_PX_PER_BEAT,
  MELODY_ROW_MAX_MIDI,
  MELODY_ROW_MIN_MIDI,
  MIN_ZOOM_PX_PER_BEAT,
  STAFF_LINE_ROWS,
  clampZoomPxPerBeat,
  diatonicRowForMidi,
  diatonicRowOf,
  ledgerRowsForRow,
  measureWidthPx,
  midiToRow,
  naturalMidiOfRow,
  pitchRowY,
  soundingMidiForRow,
  tickToX,
  xToTick,
  yToMidiRow,
} from '@features/editor/timelineGeometry';
import { parseSpelled } from '@domain/model/pitch';

describe('tick <-> px', () => {
  it('maps ticks to document-space pixels', () => {
    // zoom 40 px/beat: one quarter note = 40px, one bar = 160px.
    expect(tickToX(0, 40)).toBe(0);
    expect(tickToX(TICKS_PER_BEAT, 40)).toBe(40);
    expect(measureWidthPx(40)).toBeCloseTo(4 * 40, 10);
    expect(measureWidthPx(80)).toBeCloseTo(TICKS_PER_BAR / TICKS_PER_BEAT * 80, 10);
  });

  it('inverts exactly and never bakes in scroll', () => {
    for (const zoom of [20, 40, 96.5, 200]) {
      for (const tick of [0, 240, 960, 3840, 12345]) {
        expect(xToTick(tickToX(tick, zoom), zoom)).toBeCloseTo(tick, 6);
      }
    }
  });

  it('clamps zoom to 20..200 px per beat', () => {
    expect(clampZoomPxPerBeat(10)).toBe(MIN_ZOOM_PX_PER_BEAT);
    expect(clampZoomPxPerBeat(64)).toBe(64);
    expect(clampZoomPxPerBeat(1000)).toBe(MAX_ZOOM_PX_PER_BEAT);
  });
});

describe('diatonic rows', () => {
  it('anchors staff lines around B4 as the middle line', () => {
    expect(B4_ROW).toBe(diatonicRowOf('B', 4));
    expect(STAFF_LINE_ROWS).toEqual([
      diatonicRowOf('E', 4),
      diatonicRowOf('G', 4),
      B4_ROW,
      diatonicRowOf('D', 5),
      diatonicRowOf('F', 5),
    ]);
  });

  it('covers MIDI 36..96 with C2..C7 natural rows', () => {
    expect(LANE_BOTTOM_ROW).toBe(diatonicRowOf('C', 2));
    expect(LANE_TOP_ROW).toBe(diatonicRowOf('C', 7));
    expect(naturalMidiOfRow(diatonicRowOf('C', 2))).toBe(36);
    expect(naturalMidiOfRow(diatonicRowOf('C', 7))).toBe(96);
    expect(MELODY_ROW_MIN_MIDI).toBe(36);
    expect(MELODY_ROW_MAX_MIDI).toBe(96);
  });

  it('snaps chromatic midis to the nearest natural row, ties downward', () => {
    expect(midiToRow(60)).toBe(diatonicRowOf('C', 4));
    // F#4 (66) is equidistant from F4 (65) and G4 (67): lower wins.
    expect(midiToRow(66)).toBe(diatonicRowOf('F', 4));
    expect(midiToRow(68)).toBe(diatonicRowOf('G', 4)); // G#4 -> G4? 68-67=1 vs 69(A4)=1 -> tie -> G4
  });

  it('places B#3 on the B3 row and Cb4 on the C4 row', () => {
    // B#3 sounds like C4 = 60.
    expect(diatonicRowForMidi(60, 'B')).toBe(diatonicRowOf('B', 3));
    // Cb4 sounds like B3 = 59.
    expect(diatonicRowForMidi(59, 'C')).toBe(diatonicRowOf('C', 4));
  });
});

describe('y axis', () => {
  const opts = { topMidi: 96, rowHeight: DEFAULT_ROW_HEIGHT_PX };

  it('puts topMidi at y=0 and grows downward one rowHeight per step', () => {
    expect(pitchRowY(96, opts)).toBe(0);
    expect(pitchRowY(95, opts)).toBe(DEFAULT_ROW_HEIGHT_PX); // C7 -> B6 row
    expect(pitchRowY(84, opts)).toBe(pitchRowY(96, opts) + 7 * DEFAULT_ROW_HEIGHT_PX);
  });

  it('round-trips y back to a clamped natural midi row', () => {
    const y = pitchRowY(72, opts);
    expect(yToMidiRow(y, opts)).toBe(72);
    // Far above/below clamps into range.
    expect(yToMidiRow(-9999, opts)).toBeLessThanOrEqual(96);
    expect(yToMidiRow(99999, opts)).toBeGreaterThanOrEqual(36);
  });
});

describe('ledger lines', () => {
  it('gives none inside the staff', () => {
    expect(ledgerRowsForRow(B4_ROW)).toEqual([]);
    expect(ledgerRowsForRow(STAFF_LINE_ROWS[0] as number)).toEqual([]);
    expect(ledgerRowsForRow(STAFF_LINE_ROWS[4] as number)).toEqual([]);
  });

  it('derives descending lines below the staff', () => {
    const bottomStaff = STAFF_LINE_ROWS[0] as number;
    expect(ledgerRowsForRow(bottomStaff - 1)).toEqual([]);
    expect(ledgerRowsForRow(bottomStaff - 3)).toEqual([bottomStaff - 2]);
    expect(ledgerRowsForRow(bottomStaff - 5)).toEqual([bottomStaff - 2, bottomStaff - 4]);
  });

  it('derives ascending lines above the staff', () => {
    const topStaff = STAFF_LINE_ROWS[4] as number;
    expect(ledgerRowsForRow(topStaff + 2)).toEqual([topStaff + 2]);
    expect(ledgerRowsForRow(topStaff + 4)).toEqual([topStaff + 2, topStaff + 4]);
  });
});

describe('context-aware helpers', () => {
  const dMajor = { tonic: parseSpelled('D')!, mode: 'ionian' as const };
  const cMajor = { tonic: parseSpelled('C')!, mode: 'ionian' as const };

  it('applies mode accidentals to clicked rows (F-row in D major -> F#)', () => {
    const f5 = naturalMidiOfRow(diatonicRowOf('F', 5)); // 77
    expect(soundingMidiForRow(f5, dMajor)).toBe(f5 + 1);
    expect(soundingMidiForRow(f5, cMajor)).toBe(f5);
  });

  it('keeps tonic rows unaltered', () => {
    const d5 = naturalMidiOfRow(diatonicRowOf('D', 5));
    expect(soundingMidiForRow(d5, dMajor)).toBe(d5);
  });
});
