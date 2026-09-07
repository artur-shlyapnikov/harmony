/**
 * NoteBlock (§3.10, §3.20 Melody lane): one SVG group per MelodyNoteEvent.
 *
 * Width = duration. The harmonic-classification underlay is painted per
 * analysis span, so a long note crossing several chords shows multiple hue
 * segments while remaining ONE block/event. Note head sits in the left part,
 * accidental label beside it.
 */

import { memo } from 'react';

import type { NoteClassification, NoteHarmonySpan } from '@domain/theory/noteAnalysis';
import type { Tick } from '@domain/model/project';
import { tickToX } from './timelineGeometry';

/** Distinct hue per §3.10 classification; neutral gray for unscored. */
export const CLASSIFICATION_FILL: Record<NoteClassification, string> = {
  chordTone: '#16a34a',
  availableTension: '#d97706',
  scaleTone: '#2563eb',
  chromatic: '#dc2626',
  unscored: '#9ca3af',
};

export const CLASSIFICATION_TITLE: Record<NoteClassification, string> = {
  chordTone: 'Аккордовый тон',
  availableTension: 'Доступное напряжение',
  scaleTone: 'Ступень лада',
  chromatic: 'Хроматика',
  unscored: 'Вне гармонии',
};

export type NoteBlockProps = {
  noteId: string;
  startTick: Tick;
  /** Document-space geometry (already includes zoom, not scroll). */
  x: number;
  y: number;
  width: number;
  height: number;
  zoomPxPerBeat: number;
  selected: boolean;
  accidentalLabel: string;
  spans: readonly NoteHarmonySpan[];
  /** Accessible name for the note button: «F#5, 2 доли». */
  label: string;
  /** Engraving stem rule: notes at/above the staff middle line (B4) take
   * down-stems, lower notes up-stems. Also keeps top-row stems inside the
   * lane viewport instead of clipping at the SVG edge. */
  stemUp: boolean;
  onSelect: (noteId: string) => void;
};

const EDGE_HANDLE_PX = 6;

function NoteBlockImpl({
  noteId,
  startTick,
  x,
  y,
  width,
  height,
  zoomPxPerBeat,
  selected,
  stemUp,
  accidentalLabel,
  spans,
  label,
  onSelect,
}: NoteBlockProps) {
  const handleW = Math.min(EDGE_HANDLE_PX, width / 3);

  return (
    <g data-note-id={noteId} data-selected={selected || undefined}>
      {/* Classification underlays, one per analysis span (§3.10). */}
      {spans.map((span, index) => {
        const offset = Math.max(0, tickToX(span.fromTick - startTick, zoomPxPerBeat));
        const rawWidth = tickToX(span.toTick - span.fromTick, zoomPxPerBeat);
        const clippedWidth = Math.max(
          0,
          Math.min(offset + rawWidth, width) - Math.max(offset, 0),
        );
        if (clippedWidth === 0) return null;
        return (
          <rect
            key={`${span.fromTick}-${span.toTick}-${index}`}
            x={x + offset}
            y={y}
            width={clippedWidth}
            height={height}
            fill={CLASSIFICATION_FILL[span.classification]}
            opacity={selected ? 0.85 : 0.45}
          >
            <title>
              {CLASSIFICATION_TITLE[span.classification]}
              {span.label ? ` (${span.label})` : ''}
            </title>
          </rect>
        );
      })}

      {/* Block outline */}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="transparent"
        stroke={selected ? '#5b8cff' : '#6b7484'}
        strokeWidth={selected ? 2 : 1}
        rx={2}
      />

      {/* Note head + stem in the left part of the block */}
      <ellipse cx={x + height * 0.6} cy={y + height / 2} rx={height * 0.42} ry={height * 0.3} fill="#e8eaee" />
      <line
        x1={stemUp ? x + height * 1.02 : x + height * 0.18}
        y1={y + height / 2}
        x2={stemUp ? x + height * 1.02 : x + height * 0.18}
        y2={stemUp ? y - height * 0.5 : y + height * 1.5}
        stroke="#e8eaee"
        strokeWidth={1.2}
      />
      {accidentalLabel !== '' && (
        <text x={x + height * 1.15} y={y + height / 2 + 4} fontSize={11} fill="#e8eaee">
          {accidentalLabel}
        </text>
      )}

      {/* Interaction surfaces */}
      <rect
        data-role="note-body"
        x={x}
        y={y}
        width={width}
        height={height}
        fill="transparent"
        style={{ cursor: 'grab' }}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={selected}
        onClick={() => onSelect(noteId)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          // Enter = button activation (select). Space is deliberately NOT
          // handled here: it must bubble to the global play/pause shortcut,
          // otherwise a focused note silences the transport toggle right
          // after the user has been editing notes. The global handler's
          // preventDefault cancels native Space activation.
          event.preventDefault();
          event.stopPropagation();
          onSelect(noteId);
        }}
      />
      <rect
        data-role="note-edge-l"
        x={x}
        y={y}
        width={handleW}
        height={height}
        fill="transparent"
        style={{ cursor: 'ew-resize' }}
      />
      <rect
        data-role="note-edge-r"
        x={x + width - handleW}
        y={y}
        width={handleW}
        height={height}
        fill="transparent"
        style={{ cursor: 'ew-resize' }}
      />
    </g>
  );
}

/**
 * Memoized: geometry/spans are primitives or store-derived arrays that stay
 * referentially stable unless the document actually changed.
 */
export const NoteBlock = memo(NoteBlockImpl);
