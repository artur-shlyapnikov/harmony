/**
 * ChordBlock (§3.20 Chord lane): symbol + roman numeral + pattern-override
 * icon, with left/right resize edge handles. Purely presentational;
 * interactions are delegated via callbacks.
 */

import { memo } from 'react';

import type { Tick } from '@domain/model/project';
import { tickToX } from './timelineGeometry';

const EDGE_HANDLE_PX = 6;

export type ChordBlockProps = {
  chordId: string;
  startTick: Tick;
  durationTicks: Tick;
  zoomPxPerBeat: number;
  laneHeightPx: number;
  symbol: string;
  roman: string;
  hasPatternOverride: boolean;
  selected: boolean;
  onSelect: (chordId: string) => void;
  onOpenPicker: (chordId: string) => void;
  onBodyPointerDown: (event: React.PointerEvent, chordId: string) => void;
  onEdgePointerDown: (event: React.PointerEvent, chordId: string, edge: 'l' | 'r') => void;
};

function ChordBlockImpl({
  chordId,
  startTick,
  durationTicks,
  zoomPxPerBeat,
  laneHeightPx,
  symbol,
  roman,
  hasPatternOverride,
  selected,
  onSelect,
  onOpenPicker,
  onBodyPointerDown,
  onEdgePointerDown,
}: ChordBlockProps) {
  const x = tickToX(startTick, zoomPxPerBeat);
  const width = tickToX(durationTicks, zoomPxPerBeat);
  // Slim handles on narrow blocks keep a grab zone between them (a 1-beat
  // block is 40px at the default zoom; 6px handles would cover 30% of it).
  const handleW = Math.min(EDGE_HANDLE_PX, width / 3);
  return (
    <div
      data-chord-id={chordId}
      className={`chord-block${selected ? ' chord-block-selected' : ''}`}
      // §3.20: the roman numeral must stay reachable even when
      // @container (max-width:64px) hides .chord-block-roman — expose both
      // via the native tooltip instead.
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      // Explicit name with separators: the subtree concatenates
      // symbol+roman («Csus4Isus4») plus the ♪ override glyph — letter soup
      // for screen readers without this.
      aria-label={`${symbol} (${roman})`}
      title={`${symbol} (${roman})`}
      style={{
        position: 'absolute',
        left: x,
        top: 4,
        width,
        height: laneHeightPx - 8,
        cursor: 'pointer',
      }}
      onClick={() => onSelect(chordId)}
      onDoubleClick={() => onOpenPicker(chordId)}
      onPointerDown={(event) => onBodyPointerDown(event, chordId)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        // Enter = button activation (select). Space is deliberately NOT
        // handled here: it must bubble to the global play/pause shortcut —
        // a focused chord must not silence the transport toggle. The global
        // handler's preventDefault cancels native Space activation.
        event.preventDefault();
        event.stopPropagation();
        onSelect(chordId);
      }}
    >
      <span className="chord-block-symbol">{symbol}</span>
      <span className="chord-block-roman">{roman}</span>
      {hasPatternOverride && (
        <span className="chord-block-pattern" title="Переопределён паттерн">
          ♪
        </span>
      )}
      <div
        data-role="chord-edge-l"
        onPointerDown={(event) => {
          event.stopPropagation();
          onEdgePointerDown(event, chordId, 'l');
        }}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: handleW,
          cursor: 'ew-resize',
        }}
        className="chord-block-edge"
      />
      <div
        data-role="chord-edge-r"
        onPointerDown={(event) => {
          event.stopPropagation();
          onEdgePointerDown(event, chordId, 'r');
        }}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: handleW,
          cursor: 'ew-resize',
        }}
        className="chord-block-edge"
      />
    </div>
  );
}

/** Memoized per §3.20 "measure components memoized". */
export const ChordBlock = memo(ChordBlockImpl);

