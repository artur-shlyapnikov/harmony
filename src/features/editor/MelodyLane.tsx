/**
 * MelodyLane (§3.20 Melody lane, §3.7 mutation rules, §3.10 analysis colors).
 *
 * Staff-like interactive timeline: five staff lines, ledger lines, diatonic
 * pitch rows. Draw tool creates notes quantized to NOTE_GRID via ONE
 * canonical addNoteCmd on pointerup (replaceRange semantics live in the
 * ProjectEditor); drags/resizes preview through the shared gesture planners
 * and commit once.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import { type Tick } from '@domain/model/project';
import { formatNoteNameWithOctave, spellMelodyMidi } from '@domain/theory/spelling';
import { beatsNounRu, formatBeatsRu } from '@shared/labels';
import { NOTE_GRID, PPQ } from '@domain/timeline/constants';
import {
  midiPitchClass,
  planNoteDrawGeometry,
  planNoteLeftResizePreview,
  planNoteMovePreview,
  planNoteRightResizePreview,
} from '@domain/editing/planners';
import {
  addNoteCmd,
  moveNoteCmd,
  moveResizeNoteCmd,
  resizeNoteCmd,
  selectNoteCmd,
} from '@state/commands';
import {
  selectActiveTool,
  selectHarmonyContext,
  selectLengthTicks,
  selectMelodyNotes,
  selectNoteAnalysisMap,
  selectSelection,
  selectViewport,
} from '@state/selectors';
import {
  B4_ROW,
  DEFAULT_ROW_HEIGHT_PX,
  MELODY_ROW_MAX_MIDI,
  STAFF_LINE_ROWS,
  laneHeightPx,
  ledgerRowsForRow,
  midiToRow,
  rowToY,
  soundingMidiForRow,
  spelledRowOfMidi,
  tickToX,
  xToTick,
  yToMidiRow,
} from './timelineGeometry';
import { NoteBlock } from './NoteBlock';

const ROW_AXIS = { topMidi: MELODY_ROW_MAX_MIDI, rowHeight: DEFAULT_ROW_HEIGHT_PX } as const;

/** Rows render as DEFAULT_ROW_HEIGHT_PX-px bands and rowToY returns the band
 * TOP; staff and ledger lines belong at the band CENTER — the same y the note
 * heads and click mapping use — so notes sit ON their lines (GEO-1). */
function pitchLineY(row: number): number {
  return rowToY(row, ROW_AXIS) + ROW_AXIS.rowHeight / 2;
}



type DragState =
  | { kind: 'draw'; anchorTick: number; anchorRowMidi: number; currentTick: number }
  | {
      kind: 'move';
      id: string;
      grabOffsetTicks: number;
      previewStart: number;
      grabMidiOffset: number;
      previewMidi: number;
    }
  | {
      kind: 'resize';
      id: string;
      edge: 'l' | 'r';
      previewStart: number;
      previewDuration: number;
    };

function accidentalSuffix(accidental: number): string {
  if (accidental === 0) return '';
  return accidental > 0 ? '#'.repeat(accidental) : 'b'.repeat(-accidental);
}

export function MelodyLane({
  className,
  visibleRange,
}: {
  className?: string;
  visibleRange?: { fromTick: Tick; toTick: Tick };
}) {
  const dispatch = useAppDispatch();
  const notes = useAppSelector(selectMelodyNotes);
  const analysisMap = useAppSelector(selectNoteAnalysisMap);
  const selection = useAppSelector(selectSelection);
  const activeTool = useAppSelector(selectActiveTool);
  const context = useAppSelector(selectHarmonyContext);
  const { zoomPxPerBeat } = useAppSelector(selectViewport);
  const lengthTicks = useAppSelector(selectLengthTicks);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragMovedRef = useRef(false);
  // Capture EAGERLY at pointerdown, on the pressed ELEMENT (event.target:
  // note body/edge or the svg root for draw presses) — not the svg root
  // for note gestures. Element-scoped capture keeps compatibility
  // click/dblclick targeting the pressed note (select-on-click keeps
  // working, §3.20) while guaranteeing the drag's pointerup/pointercancel
  // reach the lane handlers via bubbling even when the pointer leaves the
  // lane mid-gesture. The old lazy capture (first move) missed drags whose
  // first move already exited the lane: the pointerup was lost and the
  // drag state stuck until the next lane press. Capture releases
  // implicitly on pointerup.
  const capturedPointerRef = useRef<{ id: number; el: Element } | null>(null);

  const ensurePointerCapture = (event: React.PointerEvent): void => {
    const el = event.target as Element;
    const id = event.pointerId;
    const captured = capturedPointerRef.current;
    if (captured === null || captured.id !== id || captured.el !== el) {
      el.setPointerCapture?.(id);
      capturedPointerRef.current = { id, el };
    }
  };

  const width = tickToX(lengthTicks, zoomPxPerBeat);
  const height = laneHeightPx(DEFAULT_ROW_HEIGHT_PX);
  const range = visibleRange ?? { fromTick: 0, toTick: Math.max(lengthTicks, 1) };
  // §3.20: visibleRange is already buffered (visible ± two measures) by
  // TimelineViewport — the single expansion point; only events
  // intersecting it are rendered, boundary-crossing events stay in.
  const visibleNotes = notes.filter(
    (note) =>
      note.startTick < range.toTick && note.startTick + note.durationTicks > range.fromTick,
  );

  const pointToTick = useCallback(
    (clientX: number): number => {
      const rect = svgRef.current?.getBoundingClientRect();
      const x = clientX - (rect?.left ?? 0);
      return xToTick(x, zoomPxPerBeat);
    },
    [zoomPxPerBeat],
  );

  const pointToRowMidi = useCallback((clientY: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    const y = clientY - (rect?.top ?? 0);
    return yToMidiRow(y, ROW_AXIS);
  }, []);


  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      const target = event.target as Element;
      const role = target.getAttribute?.('data-role');
      const noteGroup = target.closest?.('[data-note-id]');
      const noteId = noteGroup?.getAttribute('data-note-id') ?? null;
      const tick = pointToTick(event.clientX);
      const rowMidi = pointToRowMidi(event.clientY);

      if (role === 'note-edge-l' || role === 'note-edge-r') {
        const note = notes.find((n) => n.id === noteId);
        if (note === undefined) return;
        const edge = role === 'note-edge-l' ? 'l' : 'r';
        event.stopPropagation();
        // Pressing anywhere on a note selects it — including the resize
        // handles, which otherwise swallow clicks on 1-grid-step notes
        // (10px at default zoom) where handles cover the whole body.
        dispatch(selectNoteCmd(note.id));
        ensurePointerCapture(event);
        dragMovedRef.current = false;
        setDrag({
          kind: 'resize',
          id: note.id,
          edge,
          previewStart: note.startTick,
          previewDuration: note.durationTicks,
        });
        return;
      }

      if (role === 'note-body') {
        const note = notes.find((n) => n.id === noteId);
        if (note === undefined) return;
        event.stopPropagation();
        ensurePointerCapture(event);
        dragMovedRef.current = false;
        setDrag({
          kind: 'move',
          id: note.id,
          grabOffsetTicks: tick - note.startTick,
          grabMidiOffset: note.midi - rowMidi,
          previewStart: note.startTick,
          previewMidi: note.midi,
        });
        return;
      }

      if (activeTool === 'drawNote') {
        dragMovedRef.current = false;
        ensurePointerCapture(event);
        setDrag({ kind: 'draw', anchorTick: tick, anchorRowMidi: rowMidi, currentTick: tick });
      }
    },
    [activeTool, dispatch, notes, pointToTick, pointToRowMidi],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      // Capture is established eagerly at pointerdown (all three press
      // branches), so moves keep arriving here even when the pointer leaves
      // the lane mid-drag; nothing to do per-move. The old lazy capture
      // missed drags whose FIRST move already exited the lane.
      setDrag((current) => {
        if (current === null) return current;
        dragMovedRef.current = true;
        const tick = pointToTick(event.clientX);
        const rowMidi = pointToRowMidi(event.clientY);
        if (current.kind === 'draw') {
          // Guard in ghost-geometry space: the preview rect depends only on
          // planNoteDrawGeometry(anchor, current), so skip re-rendering until
          // the quantized start/duration step a grid cell — raw sub-pixel
          // tick jitter no longer re-renders the lane at pointermove rate.
          // The commit below still reads the raw ticks, so committed
          // geometry is byte-identical.
          const next = planNoteDrawGeometry(current.anchorTick, tick, lengthTicks);
          const prev = planNoteDrawGeometry(
            current.anchorTick,
            current.currentTick,
            lengthTicks,
          );
          if (
            next !== null &&
            prev !== null &&
            next.startTick === prev.startTick &&
            next.durationTicks === prev.durationTicks
          ) {
            return current;
          }
          return { ...current, currentTick: tick };
        }
        const note = notes.find((n) => n.id === current.id);
        if (note === undefined) return null;
        if (current.kind === 'move') {
          const { previewStart, previewMidi } = planNoteMovePreview({
            notes,
            note,
            grabOffsetTicks: current.grabOffsetTicks,
            grabMidiOffset: current.grabMidiOffset,
            tick,
            rowMidi,
            lengthTicks,
          });
          // Quantized preview unchanged → skip the render entirely: pointer
          // events arrive far faster than grid cells change (§3.20).
          if (previewStart === current.previewStart && previewMidi === current.previewMidi) {
            return current;
          }
          return { ...current, previewStart, previewMidi };
        }
        // Resize
        if (current.edge === 'r') {
          const previewDuration = planNoteRightResizePreview({ note, tick, lengthTicks });
          if (previewDuration === current.previewDuration) return current;
          return { ...current, previewDuration };
        }
        // Duration derives from the quantized edge position here, so one
        // field decides.
        const { previewStart, previewDuration } = planNoteLeftResizePreview({
          notes,
          note,
          tick,
          lengthTicks,
        });
        if (previewStart === current.previewStart) return current;
        return { ...current, previewStart, previewDuration };
      });
    },
    [notes, pointToTick, pointToRowMidi, lengthTicks],
  );
  /** Shared teardown for pointerup AND pointercancel (§3.20). Resetting
   * dragMovedRef here too: after a cancelled mid-move gesture the flag must
   * not stay true, or the next click / keyboard Enter-select on a note is
   * silently dropped by handleSelect. */
  const endDrag = useCallback(() => {
    setDrag(null);
    dragMovedRef.current = false;
    const captured = capturedPointerRef.current;
    if (captured !== null && captured.el.hasPointerCapture?.(captured.id)) {
      captured.el.releasePointerCapture(captured.id);
    }
    capturedPointerRef.current = null;
  }, []);

  // pointercancel (touch interrupted, browser gesture takeover) never fires
  // pointerup: without this the ghost preview lingers until the next
  // pointerdown. Abort WITHOUT committing the half-finished gesture. Capture
  // is established eagerly at pointerdown, so a cancel always has an owner:
  // only the drag OWNER's pointer may cancel — a pointercancel for a second
  // concurrent touch must not abort a mid-flight gesture owned by another,
  // still-active pointer.
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (
        capturedPointerRef.current !== null &&
        event.pointerId !== capturedPointerRef.current.id
      ) {
        return;
      }
      endDrag();
    },
    [endDrag],
  );

  const onPointerUp = useCallback(
    (_event: React.PointerEvent<SVGSVGElement>) => {
      const current = drag;
      // Snapshot BEFORE endDrag(): the teardown now resets dragMovedRef, and
      // the move commit below must still see this gesture's moved state.
      const moved = dragMovedRef.current;
      endDrag();
      if (current === null) return;

      if (current.kind === 'draw') {
        // The ghost preview and this dispatch share planNoteDrawGeometry, so
        // what the user saw is exactly what addNoteCmd commits.
        const geometry = planNoteDrawGeometry(
          current.anchorTick,
          current.currentTick,
          lengthTicks,
        );
        if (geometry === null) return;
        // Draw selects the fresh note (DAW convention): the advertised
        // Delete / Alt+Arrow shortcuts must work immediately after a draw
        // without forcing an extra click. Skipped when the edit is rejected
        // (e.g. melody limit) so the failure toast is the only feedback,
        // and skipped when a harmony selection (chord range -> suggestions
        // panel, chord -> inspector) is active: stealing it would close the
        // harmony workspace mid-flow, a pre-r74 behavior regression.
        const stealsHarmonySelection =
          selection !== null && (selection.kind === 'chord' || selection.kind === 'range');
        const noteId = crypto.randomUUID();
        const added = dispatch(
          addNoteCmd({
            id: noteId,
            startTick: geometry.startTick,
            durationTicks: geometry.durationTicks,
            midi: soundingMidiForRow(current.anchorRowMidi, context),
            velocity: 80,
          }),
        );
        if (added && !stealsHarmonySelection) dispatch(selectNoteCmd(noteId));
        return;
      }

      const note = notes.find((n) => n.id === current.id);
      if (note === undefined) return;
      if (current.kind === 'move') {
        if (
          moved &&
          (current.previewStart !== note.startTick || current.previewMidi !== note.midi)
        ) {
          dispatch(
            moveNoteCmd({
              id: note.id,
              newStartTick: current.previewStart,
              newMidi: current.previewMidi,
            }),
          );
        }
        return;
      }
      // Resize
      if (current.edge === 'r') {
        if (current.previewDuration !== note.durationTicks) {
          dispatch(resizeNoteCmd({ id: note.id, newDurationTicks: current.previewDuration }));
        }
        return;
      }
      if (
        current.previewStart !== note.startTick ||
        current.previewDuration !== note.durationTicks
      ) {
        // Left-edge resize = ONE atomic command → one undo entry (§3.7/§3.8);
        // grid-quantized and neighbor-clamped by the ProjectEditor.
        dispatch(
          moveResizeNoteCmd({
            id: note.id,
            newStartTick: current.previewStart,
            newDurationTicks: current.previewDuration,
          }),
        );
      }
    },
    [drag, notes, context, dispatch, endDrag, lengthTicks, selection],
  );

  /** Grid geometry as three path-data strings (note/chord/bar): one <path>
   * per kind instead of one <line> per grid step. A zoom or scroll flip then
   * diffs 3 nodes and rewrites 3 `d` attributes instead of reconciling
   * hundreds of <line> elements (schema-max doc: ~430 per render). */
  const gridPaths = useMemo(() => {
    const build = (stepTicks: number): string => {
      let d = '';
      for (
        let tick = Math.ceil(range.fromTick / stepTicks) * stepTicks;
        tick <= range.toTick;
        tick += stepTicks
      ) {
        d += `M${tickToX(tick, zoomPxPerBeat)} 0V${height}`;
      }
      return d;
    };
    return {
      note: tickToX(NOTE_GRID, zoomPxPerBeat) >= 6 ? build(NOTE_GRID) : '',
      chord: build(NOTE_GRID * 4),
      bar: build(NOTE_GRID * 16),
    };
  }, [range.fromTick, range.toTick, zoomPxPerBeat, height]);

  const handleSelect = useCallback((noteId: string): void => {
    if (dragMovedRef.current) return;
    dispatch(selectNoteCmd(noteId));
  }, [dispatch]);

  // Ledger lines as one path: segments accumulate during the note map below
  // (so a drag ghost moves with the same geometry), rendered once under the
  // blocks. A zoom step or drag frame then rewrites a single `d` attribute
  // instead of reconciling one <line> per ledger row per visible note.
  const ledgerSegments: string[] = [];
  const noteNodes = visibleNotes.map((note) => {
        const dragging = drag?.kind === 'move' && drag.id === note.id;
        const midi = dragging ? drag.previewMidi : note.midi;
        // A pitch-class change invalidates a spelling override mid-drag the
        // same way the reducer drops it on commit (§3.5).
        const overrideSurvives =
          note.spellingOverride !== undefined && midiPitchClass(note.midi) === midiPitchClass(midi);
        const spelling =
          note.spellingOverride !== undefined && overrideSurvives
            ? note.spellingOverride
            : spellMelodyMidi(midi, context);
        const startTick = dragging ? drag.previewStart : note.startTick;
        const row = spelledRowOfMidi(midi, spelling);
        const y = rowToY(row, ROW_AXIS);
        const x = tickToX(startTick, zoomPxPerBeat);
        const blockWidth = tickToX(note.durationTicks, zoomPxPerBeat);
        for (const ledgerRow of ledgerRowsForRow(row)) {
          const ledgerY = pitchLineY(ledgerRow);
          ledgerSegments.push(`M${x - 4} ${ledgerY}H${x + blockWidth + 4}`);
        }
        const beats = note.durationTicks / PPQ;
        // Spoken name for the note button: «F#5, 2 доли» (screen readers).
        const label = `${formatNoteNameWithOctave(midi, context)}, ${formatBeatsRu(beats)} ${beatsNounRu(beats)}`;
        return (
          <g key={note.id}>
            <NoteBlock
              noteId={note.id}
              startTick={startTick}
              x={x}
              y={y}
              width={blockWidth}
              height={DEFAULT_ROW_HEIGHT_PX}
              zoomPxPerBeat={zoomPxPerBeat}
              label={label}
              stemUp={row < B4_ROW}
              selected={
                (selection?.kind === 'note' && selection.id === note.id) || dragging
              }
              accidentalLabel={accidentalSuffix(spelling.accidental)}
              spans={analysisMap.get(note.id) ?? []}
              onSelect={handleSelect}
            />
          </g>
        );
  });

  return (
    <svg
      ref={svgRef}
      className={className === undefined ? 'melody-lane' : `${className} melody-lane`}
      data-testid="melody-lane"
      width={Math.max(width, 1)}
      height={height}
      style={{ display: 'block', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* Grid: faint note grid, stronger chord grid, strongest barlines.
       * Paint order preserved (bar on top); empty `d` renders nothing, which
       * keeps the >=6px note-grid visibility rule. */}
      <path d={gridPaths.note} stroke="#2c313a" strokeWidth={1} opacity={0.4} fill="none" />
      <path d={gridPaths.chord} stroke="#4a5260" strokeWidth={1} opacity={0.7} fill="none" />
      <path d={gridPaths.bar} stroke="#9aa1ad" strokeWidth={1.5} opacity={0.7} fill="none" />

      {/* Staff lines */}
      {STAFF_LINE_ROWS.map((row) => (
        <line
          key={row}
          x1={0}
          x2={Math.max(width, 1)}
          y1={pitchLineY(row)}
          y2={pitchLineY(row)}
          stroke="#454d5c"
          strokeWidth={1}
        />
      ))}

      {/* Empty-state hint: where to click and drag. Suppressed mid-draw - the
       * preview ghost already confirms the gesture landed. Mirrors the chord
       * lane's empty-state hint (the melody is the natural first gesture, yet
       * was the only empty surface with no guidance). */}
      {notes.length === 0 && drag?.kind !== 'draw' && (
        <text className="melody-lane-hint" x={12} y={height / 2} dominantBaseline="central">
          Кликните и потяните, чтобы нарисовать ноту
        </text>
      )}

      {/* Ledger lines: one path for all visible notes. */}
      {ledgerSegments.length > 0 && (
        <path d={ledgerSegments.join('')} stroke="#454d5c" strokeWidth={1} fill="none" />
      )}

      {/* Notes */}
      {noteNodes}

      {drag?.kind === 'draw' &&
        (() => {
          const geometry = planNoteDrawGeometry(
            drag.anchorTick,
            drag.currentTick,
            lengthTicks,
          );
          if (geometry === null) return null;
          const y = rowToY(midiToRow(drag.anchorRowMidi), ROW_AXIS);
          const beats = geometry.durationTicks / PPQ;
          const labelY = y < 24 ? y + DEFAULT_ROW_HEIGHT_PX + 14 : y - 6;
          return (
            <g pointerEvents="none">
              <rect
                x={tickToX(geometry.startTick, zoomPxPerBeat)}
                y={y}
                width={tickToX(geometry.durationTicks, zoomPxPerBeat)}
                height={DEFAULT_ROW_HEIGHT_PX}
                fill="rgba(37,99,235,0.35)"
                stroke="#1d4ed8"
              />
              {/* Duration readout: sizing is blind without it (the ruler
               * only covers the horizontal axis). */}
              <text
                x={Math.min(tickToX(geometry.startTick, zoomPxPerBeat) + 2, Math.max(width - 68, 2))}
                y={labelY}
                fontSize={11}
                fill="#93c5fd"
              >
                {formatBeatsRu(beats)} {beatsNounRu(beats)}
              </text>
            </g>
          );
        })()}

      {drag?.kind === 'move' &&
        (() => {
          const note = notes.find((n) => n.id === drag.id);
          if (note === undefined) return null;
          const spelling =
            note.spellingOverride !== undefined &&
            midiPitchClass(note.midi) === midiPitchClass(drag.previewMidi)
              ? note.spellingOverride
              : spellMelodyMidi(drag.previewMidi, context);
          const y = rowToY(spelledRowOfMidi(drag.previewMidi, spelling), ROW_AXIS);

          return (
            <g pointerEvents="none">
              {/* Border lifted to blue-300: the old #1d4ed8 dashed line was
               * near-invisible on the dark lane at 12px row height. */}
              <rect
                x={tickToX(drag.previewStart, zoomPxPerBeat)}
                y={y}
                width={tickToX(note.durationTicks, zoomPxPerBeat)}
                height={DEFAULT_ROW_HEIGHT_PX}
                fill="rgba(37,99,235,0.25)"
                stroke="#60a5fa"
                strokeDasharray="4 2"
              />
              {/* Pitch readout: 12px semitone rows give no feedback about
               * which note the drag will land on (the chord ghost shows its
               * symbol; parity here). */}
              <text
                x={Math.min(tickToX(drag.previewStart, zoomPxPerBeat) + 2, Math.max(width - 68, 2))}
                y={y < 24 ? y + DEFAULT_ROW_HEIGHT_PX + 14 : y - 6}
                fontSize={11}
                fill="#93c5fd"
              >
                {formatNoteNameWithOctave(drag.previewMidi, context)}
              </text>
            </g>
          );
        })()}

      {/* Resize preview ghost */}
      {drag?.kind === 'resize' &&
        (() => {
          const note = notes.find((n) => n.id === drag.id);
          if (note === undefined) return null;
          const spelling = note.spellingOverride ?? spellMelodyMidi(note.midi, context);
          const y = rowToY(spelledRowOfMidi(note.midi, spelling), ROW_AXIS);
          return (
            <g pointerEvents="none">
              <rect
                x={tickToX(drag.previewStart, zoomPxPerBeat)}
                y={y}
                width={tickToX(drag.previewDuration, zoomPxPerBeat)}
                height={DEFAULT_ROW_HEIGHT_PX}
                fill="rgba(37,99,235,0.25)"
                stroke="#60a5fa"
                strokeDasharray="4 2"
              />
              <text
                x={Math.min(tickToX(drag.previewStart, zoomPxPerBeat) + 2, Math.max(width - 68, 2))}
                y={y < 24 ? y + DEFAULT_ROW_HEIGHT_PX + 14 : y - 6}
                fontSize={11}
                fill="#93c5fd"
              >
                {formatBeatsRu(drag.previewDuration / PPQ)}{' '}
                {beatsNounRu(drag.previewDuration / PPQ)}
              </text>
            </g>
          );
        })()}
    </svg>
  );
}
