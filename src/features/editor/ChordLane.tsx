/**
 * ChordLane (§3.20 Chord lane, §3.7 chord rules).
 *
 * Empty-area press-drag-release creates a range selection snapped to
 * CHORD_GRID (min one bar) and opens the suggestions panel (the panel keys
 * off a 'range' selection). Clicking a block selects it for the
 * ChordInspector; double-clicking opens ChordPicker prefilled with the
 * chord's root. Move/resize keep local previews and dispatch ONE canonical
 * command on pointerup.
 */

import { useCallback, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import type { SpelledPitchClass } from '@domain/model/pitch';
import type { ChordTemplateId } from '@domain/model/chord';
import { CHORD_GRID, TICKS_PER_BAR } from '@domain/timeline/constants';
import { quantizeTick } from '@domain/timeline/quantize';
import {
  planChordLeftResizePreview,
  planChordMovePreview,
  planChordRightResizePreview,
  planRangeSelectionGeometry,
} from '@domain/editing/planners';
import {
  moveChordCmd,
  moveResizeChordCmd,
  resizeChordCmd,
  selectChordCmd,
  selectRangeCmd,
} from '@state/commands';
import {
  selectChords,
  selectChordLabels,
  selectLengthTicks,
  selectSelection,
  selectViewport,
} from '@state/selectors';
import { measureWidthPx, tickToX, xToTick } from './timelineGeometry';
import { ChordBlock } from './ChordBlock';
import { ChordPicker } from '@features/chords/ChordPicker';

export const LANE_HEIGHT = 56;


type DragState =
  | { kind: 'range'; anchorTick: number; currentTick: number }
  | { kind: 'move'; id: string; grabOffsetTicks: number; previewStart: number }
  | {
      kind: 'resize';
      id: string;
      edge: 'l' | 'r';
      previewStart: number;
      previewDuration: number;
    };

type PickerState = {
  open: boolean;
  /** Chord being replaced; null = create in the current range selection. */
  editingChordId: string | null;
  prefillRoot: SpelledPitchClass | null;
  prefillTemplateId: ChordTemplateId | null;
};


export function ChordLane({
  className,
  visibleRange,
}: {
  className?: string;
  visibleRange?: { fromTick: number; toTick: number };
}) {
  const dispatch = useAppDispatch();
  const chords = useAppSelector(selectChords);
  const labels = useAppSelector(selectChordLabels);
  const selection = useAppSelector(selectSelection);
  const { zoomPxPerBeat } = useAppSelector(selectViewport);
  const lengthTicks = useAppSelector(selectLengthTicks);

  const laneRef = useRef<HTMLDivElement | null>(null);
  // Capture EAGERLY at pointerdown, on the pressed ELEMENT (lane root /
  // block / edge) — not the lane root. Element-scoped capture keeps
  // compatibility click/dblclick targeting the pressed element (select-on-
  // click and double-click-to-open-picker keep working, §3.20) while
  // guaranteeing the drag's pointerup/pointercancel reach the lane handlers
  // via bubbling even when the pointer leaves the lane mid-gesture. The old
  // lazy capture (first move) missed drags whose first move already exited
  // the 60px-tall lane: the pointerup was lost, the drag state stuck, and
  // hover moves then poisoned dragMovedRef — block clicks stopped selecting
  // until the next lane press. Capture releases implicitly on pointerup.
  const capturedPointerRef = useRef<{ id: number; el: Element } | null>(null);

  const ensurePointerCapture = (event: React.PointerEvent): void => {
    const el = event.currentTarget;
    const id = event.pointerId;
    const captured = capturedPointerRef.current;
    if (captured === null || captured.id !== id || captured.el !== el) {
      el.setPointerCapture?.(id);
      capturedPointerRef.current = { id, el };
    }
  };
  const [drag, setDrag] = useState<DragState | null>(null);
  const [picker, setPicker] = useState<PickerState>({
    open: false,
    editingChordId: null,
    prefillRoot: null,
    prefillTemplateId: null,
  });

  const width = tickToX(Math.max(lengthTicks, TICKS_PER_BAR), zoomPxPerBeat);
  const range = visibleRange ?? { fromTick: 0, toTick: Math.max(lengthTicks, TICKS_PER_BAR) };
  // Measures, not beats: one barline per TICKS_PER_BAR, clamped to the
  // project's bar count so a buffered visible range never paints barlines
  // past the end of the content.
  const firstBar = Math.max(0, Math.floor(range.fromTick / TICKS_PER_BAR));
  const lastBar = Math.min(
    Math.ceil(range.toTick / TICKS_PER_BAR),
    Math.ceil(lengthTicks / TICKS_PER_BAR),
  );
  // §3.20: visibleRange is already buffered (visible ± two measures) by
  // TimelineViewport — the single expansion point; only chords
  // intersecting it are rendered, boundary-crossing chords stay in.
  const visibleChords = chords.filter(
    (chord) =>
      chord.startTick < range.toTick &&
      chord.startTick + chord.durationTicks > range.fromTick,
  );

  const pointToTick = useCallback(
    (clientX: number): number => {
      const rect = laneRef.current?.getBoundingClientRect();
      const x = clientX - (rect?.left ?? 0);
      return xToTick(x, zoomPxPerBeat);
    },
    [zoomPxPerBeat],
  );

  const dragMovedRef = useRef(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // Presses inside a mounted dialog (ChordPicker renders as a child of
      // this lane) must not start lane drags — with eager capture they would
      // also retarget the dialog's click events to the lane root, dead-zoning
      // every button in the modal. Same [data-modal] convention as the
      // keyboard-shortcut guard.
      if ((event.target as Element).closest?.('[data-modal]') !== null) return;
      // Block-internal handles stop propagation, so reaching here means the
      // empty lane background was pressed.
      const tick = pointToTick(event.clientX);
      dragMovedRef.current = false;
      // Capture EAGERLY: a drag whose first move already exits the lane (a
      // fast flick across the 60px-tall lane) never engages a lazily-set
      // capture, so its pointerup lands on another element and the drag
      // state sticks — ghost preview lingers and hover moves poison
      // dragMovedRef, silently killing block-click selection. Capture is
      // released implicitly on pointerup.
      ensurePointerCapture(event);
      setDrag({ kind: 'range', anchorTick: quantizeTick(tick, CHORD_GRID), currentTick: tick });
    },
    [pointToTick],
  );
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Capture is established eagerly at pointerdown (all three press
      // paths), so moves keep arriving here even when the pointer leaves
      // the lane mid-drag; nothing to do per-move. The old lazy capture
      // missed drags whose FIRST move already exited the lane.
      setDrag((current) => {
        if (current === null) return current;
        dragMovedRef.current = true;
        const tick = pointToTick(event.clientX);
        if (current.kind === 'range') {
          // Guard in highlight-geometry space: the range preview depends
          // only on planRangeSelectionGeometry(anchor, current), so skip
          // re-rendering until the quantized start/duration step a
          // CHORD_GRID cell — raw sub-pixel tick jitter no longer
          // re-renders the lane at pointermove rate. The commit below
          // shares this exact math (same as the ghost), so committed
          // geometry is unchanged.
          const next = planRangeSelectionGeometry(current.anchorTick, tick);
          const prev = planRangeSelectionGeometry(
            current.anchorTick,
            current.currentTick,
          );
          if (
            next.startTick === prev.startTick &&
            next.durationTicks === prev.durationTicks
          ) {
            return current;
          }
          return { ...current, currentTick: tick };
        }
        const chord = chords.find((c) => c.id === current.id);
        if (chord === undefined) return null;
        if (current.kind === 'move') {
          const { previewStart } = planChordMovePreview({
            chords,
            chord,
            grabOffsetTicks: current.grabOffsetTicks,
            tick,
            lengthTicks,
          });
          // Quantized preview unchanged → skip the render entirely.
          if (previewStart === current.previewStart) return current;
          return { ...current, previewStart };
        }
        if (current.edge === 'r') {
          const previewDuration = planChordRightResizePreview({ chord, tick, lengthTicks });
          if (previewDuration === current.previewDuration) return current;
          return { ...current, previewDuration };
        }
        // Duration derives from the quantized edge position here, so one
        // field decides.
        const { previewStart, previewDuration } = planChordLeftResizePreview({
          chords,
          chord,
          tick,
          lengthTicks,
        });
        if (previewStart === current.previewStart) return current;
        return { ...current, previewStart, previewDuration };
      });
    },
    [chords, pointToTick, lengthTicks],
  );

  /** Shared teardown for pointerup AND pointercancel (§3.20). Resetting
   * dragMovedRef here too: after a cancelled mid-move gesture the flag must
   * not stay true, or the next click / keyboard Enter-select on a block is
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
  // pointerdown. Abort WITHOUT committing the half-finished gesture. Only
  // the drag OWNER's pointer may cancel: a pointercancel for a second
  // concurrent touch must not abort a mid-flight gesture owned by another,
  // still-active pointer.
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (drag === null) return;
      if (
        capturedPointerRef.current !== null &&
        event.pointerId !== capturedPointerRef.current.id
      ) {
        return;
      }
      endDrag();
    },
    [drag, endDrag],
  );

  const onPointerUp = useCallback(
    (_event: React.PointerEvent<HTMLDivElement>) => {
      const current = drag;
      // Snapshot BEFORE endDrag(): the teardown now resets dragMovedRef, and
      // the move commit below must still see this gesture's moved state.
      const moved = dragMovedRef.current;
      endDrag();
      if (current === null) return;

      if (current.kind === 'range') {
        // §3.20: empty click → range selection (min one bar) + suggestions.
        // Same math as the drag ghost (rangeDragGeometry), so what the user
        // sees is exactly what commits.
        const { startTick, durationTicks } = planRangeSelectionGeometry(
          current.anchorTick,
          current.currentTick,
        );
        dispatch(selectRangeCmd(startTick, durationTicks));
        return;
      }

      const chord = chords.find((c) => c.id === current.id);
      if (chord === undefined) return;
      if (current.kind === 'move') {
        if (moved && current.previewStart !== chord.startTick) {
          dispatch(moveChordCmd({ id: chord.id, newStartTick: current.previewStart }));
        }
        return;
      }
      if (current.edge === 'r') {
        if (current.previewDuration !== chord.durationTicks) {
          dispatch(resizeChordCmd({ id: chord.id, newDurationTicks: current.previewDuration }));
        }
        return;
      }
      if (
        current.previewStart !== chord.startTick ||
        current.previewDuration !== chord.durationTicks
      ) {
        // Atomic left-edge resize: BOTH fields in ONE command → ONE history
        // entry (§3.7/§3.8). A separate resize+move pair would clamp each
        // half against stale neighbor geometry and can reject valid drags.
        dispatch(
          moveResizeChordCmd({
            id: chord.id,
            newStartTick: current.previewStart,
            newDurationTicks: current.previewDuration,
          }),
        );
      }
    },
    [drag, chords, dispatch, endDrag],
  );

  // Stable per-chord press handlers: inline closures inside visibleChords.map
  // gave every render a fresh prop pair, defeating ChordBlock's memo — each
  // guarded range-drag move re-rendered every block instead of diffing zero
  // children. useCallback keeps identity across renders where `chords` (and
  // the other deps) are unchanged, so memo holds.
  const handleBodyPointerDown = useCallback(
    (event: React.PointerEvent, chordId: string) => {
      const chordEvent = chords.find((c) => c.id === chordId);
      if (chordEvent === undefined) return;
      event.stopPropagation();
      // Eager capture: see onPointerDown — a first move that exits the lane
      // must not orphan this drag.
      ensurePointerCapture(event);
      dragMovedRef.current = false;
      setDrag({
        kind: 'move',
        id: chordId,
        grabOffsetTicks: pointToTick(event.clientX) - chordEvent.startTick,
        previewStart: chordEvent.startTick,
      });
    },
    [chords, pointToTick],
  );

  const handleEdgePointerDown = useCallback(
    (event: React.PointerEvent, chordId: string, edge: 'l' | 'r') => {
      const chordEvent = chords.find((c) => c.id === chordId);
      if (chordEvent === undefined) return;
      // Pressing an edge selects the chord too — resize handles must not be
      // a selection dead zone (§3.15 consistency with MelodyLane edges).
      dispatch(selectChordCmd(chordId));
      // Eager capture: see onPointerDown.
      ensurePointerCapture(event);
      dragMovedRef.current = false;
      setDrag({
        kind: 'resize',
        id: chordId,
        edge,
        previewStart: chordEvent.startTick,
        previewDuration: chordEvent.durationTicks,
      });
    },
    [chords, dispatch],
  );

  const handleSelect = useCallback(
    (chordId: string) => {
      if (dragMovedRef.current) return;
      dispatch(selectChordCmd(chordId));
    },
    [dispatch],
  );

  const handleOpenPicker = useCallback((chordId: string) => {
    const chord = chords.find((c) => c.id === chordId);
    setPicker({
      open: true,
      editingChordId: chordId,
      prefillRoot: chord ? chord.chord.root : null,
      prefillTemplateId: chord ? chord.chord.templateId : null,
    });
  }, [chords]);

  return (
    <div
      ref={laneRef}
      className={className === undefined ? 'chord-lane' : `${className} chord-lane`}
      data-testid="chord-lane"
      tabIndex={-1}
      aria-label="Дорожка гармонии"
      style={{
        position: 'relative',
        height: LANE_HEIGHT,
        width: Math.max(width, measureWidthPx(zoomPxPerBeat)),
        overflow: 'hidden',
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* Barlines */}
      {Array.from({ length: lastBar - firstBar + 1 }, (_, index) => firstBar + index).map((bar) => (
        <div
          key={bar}
          style={{
            position: 'absolute',
            left: tickToX(bar * TICKS_PER_BAR, zoomPxPerBeat),
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--color-border-strong, #4a5260)',
            opacity: 0.9,
          }}
        />
      ))}
      {/* Persistent highlight of the committed range selection. */}
      {selection?.kind === 'range' && (
        <div
          data-testid="chord-range-highlight"
          style={{
            position: 'absolute',
            left: tickToX(selection.startTick, zoomPxPerBeat),
            top: 0,
            width: Math.max(
              1,
              tickToX(selection.durationTicks, zoomPxPerBeat),
            ),
            height: LANE_HEIGHT,
            background: 'rgba(91,140,255,0.14)',
            borderLeft: '2px solid var(--color-accent)',
            borderRight: '2px solid var(--color-accent)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Empty-state hint: where to click and drag. Suppressed while a
          range is actively selected — the highlight plus the suggestion
          panel already tell the user their gesture landed. */}
      {chords.length === 0 && selection?.kind !== 'range' && (
        <span className="chord-lane-hint">
          Кликните и потяните, чтобы выбрать диапазон
        </span>
      )}
      {visibleChords.map((chord) => {
        const label = labels.get(chord.id);
        return (
          <div key={chord.id}>
            <ChordBlock
              chordId={chord.id}
              startTick={chord.startTick}
              durationTicks={chord.durationTicks}
              zoomPxPerBeat={zoomPxPerBeat}
              laneHeightPx={LANE_HEIGHT}
              symbol={label?.symbol ?? '?'}
              roman={label?.roman ?? ''}
              hasPatternOverride={chord.patternOverride !== undefined}
              selected={selection?.kind === 'chord' && selection.id === chord.id}
              onSelect={handleSelect}
              onOpenPicker={handleOpenPicker}
              onBodyPointerDown={handleBodyPointerDown}
              onEdgePointerDown={handleEdgePointerDown}
            />
          </div>
        );
      })}

      {/* Range-selection ghost */}
      {drag?.kind === 'range' &&
        (() => {
          const { startTick, durationTicks } = planRangeSelectionGeometry(
            drag.anchorTick,
            drag.currentTick,
          );
          return (
            <div
              style={{
                position: 'absolute',
                left: tickToX(startTick, zoomPxPerBeat),
                top: 0,
                width: tickToX(durationTicks, zoomPxPerBeat),
                height: LANE_HEIGHT,
                background: 'rgba(37,99,235,0.2)',
                border: '1px dashed #1d4ed8',
                boxSizing: 'border-box',
                pointerEvents: 'none',
              }}
            />
          );
        })()}

      {/* Move/resize preview ghost */}
      {(drag?.kind === 'move' || drag?.kind === 'resize') &&
        (() => {
          const chord = chords.find((c) => c.id === drag.id);
          if (chord === undefined) return null;
          const label = labels.get(chord.id);
          const width =
            drag.kind === 'move'
              ? chord.durationTicks
              : drag.previewDuration;
          return (
            <div
              style={{
                position: 'absolute',
                left: tickToX(drag.previewStart, zoomPxPerBeat),
                top: 4,
                width: tickToX(width, zoomPxPerBeat),
                height: LANE_HEIGHT - 8,
                border: '1px dashed #1d4ed8',
                borderRadius: 4,
                background: 'rgba(37,99,235,0.15)',
                boxSizing: 'border-box',
                fontSize: 12,
                padding: '2px 4px',
                pointerEvents: 'none',
              }}
            >
              {label?.symbol ?? ''}
            </div>
          );
        })()}

      <ChordPicker
        open={picker.open}
        onClose={() =>
          setPicker({ open: false, editingChordId: null, prefillRoot: null, prefillTemplateId: null })
        }
        editingChordId={picker.editingChordId}
        prefillTemplateId={picker.prefillTemplateId}
        prefillRoot={picker.prefillRoot}
      />
    </div>
  );
}
