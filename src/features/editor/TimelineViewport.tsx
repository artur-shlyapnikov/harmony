/**
 * TimelineViewport (§3.20): shared horizontal scroller for MelodyLane +
 * ChordLane + bar-number ruler. Zoom (+/-) writes session.viewport.zoomPxPerBeat
 * clamped to 20..200 px/beat. Only visible measures plus two buffer measures
 * per side are rendered; measure labels are memoized. `children` render in an
 * absolute overlay INSIDE the scrolled content layer (Playhead mounts there;
 * its x is document-space and the scroller supplies the offset).
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { getDependencies } from '@app/dependencies';
import type { ProjectTransport } from '@audio/projectTransport';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import { selectLengthTicks, selectViewport } from '@state/selectors';
import { CHORD_GRID, TICKS_PER_BAR, TICKS_PER_BEAT } from '@domain/timeline/constants';
import {
  MAX_ZOOM_PX_PER_BEAT,
  MIN_ZOOM_PX_PER_BEAT,
  clampZoomPxPerBeat,
  DEFAULT_ROW_HEIGHT_PX,
  LANE_BOTTOM_ROW,
  LANE_TOP_ROW,
  laneHeightPx,
  measureWidthPx,
  MELODY_ROW_MAX_MIDI,
  rowLetter,
  rowOctave,
  rowToY,
  tickToX,
  xToTick,
} from './timelineGeometry';
import { MelodyLane } from './MelodyLane';
import { ChordLane, LANE_HEIGHT as CHORD_LANE_HEIGHT } from './ChordLane';

const BUFFER_MEASURES = 2;

const RULER_HEIGHT_PX = 16;
/** Minimum horizontal room for one ruler label (3 digits at font-size 11);
 * beat steps narrower than this thin their labels to multiples. */
const RULER_MIN_LABEL_PX = 24;

const ROW_AXIS = {
  topMidi: MELODY_ROW_MAX_MIDI,
  rowHeight: DEFAULT_ROW_HEIGHT_PX,
} as const;

/** Letter+octave caption per diatonic row (§3.20 y-axis: C4, D4, …). */
const ROW_LABELS = (() => {
  const labels: Array<{ top: number; label: string }> = [];
  for (let row = LANE_BOTTOM_ROW; row <= LANE_TOP_ROW; row += 1) {
    labels.push({
      top: rowToY(row, ROW_AXIS) + DEFAULT_ROW_HEIGHT_PX / 2,
      label: `${rowLetter(row)}${rowOctave(row)}`,
    });
  }
  return labels;
})();

const MELODY_LANE_HEIGHT = laneHeightPx(DEFAULT_ROW_HEIGHT_PX);

function MeasureLabelImpl({ bar, zoom }: { bar: number; zoom: number }) {
  return (
    <span
      style={{
        position: 'absolute',
        left: tickToX(bar * TICKS_PER_BAR, zoom),
        top: 0,
        fontSize: 11,
        color: 'var(--color-text-muted, #9aa1ad)',
        userSelect: 'none',
      }}
    >
      {bar + 1}
    </span>
  );
}

const MeasureLabel = memo(MeasureLabelImpl);

export function TimelineViewport({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const dispatch = useAppDispatch();
  const { zoomPxPerBeat, scrollTick } = useAppSelector(selectViewport);
  const lengthTicks = useAppSelector(selectLengthTicks);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportPx, setViewportPx] = useState(0);

  // Track the visible width so the lane render window can be computed.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const update = () => setViewportPx(element.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pxPerTick = zoomPxPerBeat / TICKS_PER_BEAT;

  // §3.20 UI-VIEW-2: a zoom change must keep the left-edge tick anchored —
  // otherwise visibleRange is computed from a stale tick origin until the
  // user scrolls. Resync the scroller so scrollLeft = scrollTick *
  // newPxPerTick (clamped >= 0); the native scroll event then flows through
  // onScroll, which re-derives scrollTick (no extra dispatch, no loops).
  // useLayoutEffect so the correction lands before paint — a passive effect
  // would flash one frame of the stale window after clicking zoom.
  const prevPxPerTickRef = useRef(pxPerTick);
  useLayoutEffect(() => {
    const prevPxPerTick = prevPxPerTickRef.current;
    prevPxPerTickRef.current = pxPerTick;
    // Skip the mount run: only actual zoom changes resync.
    if (prevPxPerTick === pxPerTick) return;
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollLeft = Math.max(0, scrollTick * pxPerTick);
  }, [pxPerTick, scrollTick]);

  const totalMeasures = Math.max(1, Math.ceil(lengthTicks / TICKS_PER_BAR));
  const contentWidth = Math.max(
    measureWidthPx(zoomPxPerBeat) * totalMeasures,
    measureWidthPx(zoomPxPerBeat),
  );

  // Visible measures + two buffer measures each side (§3.20).
  const visibleRange = useMemo(() => {
    const fromTick = Math.max(0, scrollTick - BUFFER_MEASURES * TICKS_PER_BAR);
    const visibleTicks =
      viewportPx > 0 ? viewportPx / pxPerTick : 4 * TICKS_PER_BAR;
    return {
      fromTick,
      toTick: fromTick + visibleTicks + 2 * BUFFER_MEASURES * TICKS_PER_BAR,
    };
  }, [scrollTick, viewportPx, pxPerTick]);


  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const { scrollLeft } = event.currentTarget;
      // Coalesce sub-pixel event storms: compare in PIXELS against the left
      // edge implied by the stored tick (the old sub-TICK guard filtered only
      // ~0.04px at default zoom). The round-trip scrollTick*pxPerTick →
      // /pxPerTick is float-exact, so the zoom resync's programmatic
      // scrollLeft lands with a 0px delta and is correctly swallowed — the
      // stored tick already equals the true left edge there. Real gestures
      // always dispatch the absolute derived tick, so no drift accumulates.
      if (Math.abs(scrollLeft - scrollTick * pxPerTick) < 1) return;
      dispatch({ type: "session/viewportChanged", payload: { scrollTick: scrollLeft / pxPerTick } });
    },
    [dispatch, scrollTick, pxPerTick],
  );

  const zoomBy = useCallback(
    (delta: number) => {
      dispatch({ type: "session/viewportChanged", payload: { zoomPxPerBeat: clampZoomPxPerBeat(zoomPxPerBeat + delta) } });
    },
    [dispatch, zoomPxPerBeat],
  );

  // Ctrl/⌘+wheel (and trackpad pinch, which synthesizes ctrl+wheel) zooms the
  // timeline. React's onWheel is passive; preventDefault needs a manual
  // non-passive listener.
  //
  // Trackpads deliver wheel bursts faster than frames, and every accepted
  // step re-renders both lanes (each visible block's geometry changes), so
  // dispatching per event saturates the main thread on dense projects.
  // Deltas accumulate and one clamped dispatch runs per animation frame:
  // render cost is capped at display rate while total zoom travel is kept.
  //
  // Anchoring: the wheel's natural anchor is the pointer — the content tick
  // under the cursor must stay under the cursor after the zoom (the +/- buttons
  // keep the §3.20 UI-VIEW-2 left-edge anchor via zoomBy). The flush therefore
  // dispatches zoomPxPerBeat and the compensated scrollTick in ONE action, so
  // the layout resync lands the scroller exactly where the anchor math put it.
  // zoomPxRef keeps the flush reading the latest zoom (the effect attaches
  // once; a captured zoomPxPerBeat would recompute from a stale base).
  const zoomPxRef = useRef(zoomPxPerBeat);
  useLayoutEffect(() => {
    zoomPxRef.current = zoomPxPerBeat;
  }, [zoomPxPerBeat]);

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let pendingDelta = 0;
    let pendingCursorX = 0; // viewport x of the latest wheel event in the burst
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      if (pendingDelta === 0) return;
      const scroller = scrollRef.current;
      const oldPxPerBeat = zoomPxRef.current;
      const nextZoom = clampZoomPxPerBeat(oldPxPerBeat + pendingDelta);
      pendingDelta = 0;
      if (scroller === null || nextZoom === oldPxPerBeat) return;
      const rect = scroller.getBoundingClientRect();
      // No upper clamp: a wheel over the gutter anchors slightly left of the
      // content edge, which the math degrades to gracefully.
      const cursorX = Math.max(pendingCursorX - rect.left, 0);
      const tickAtCursor = (scroller.scrollLeft + cursorX) / (oldPxPerBeat / TICKS_PER_BEAT);
      const scrollTick = Math.max(0, tickAtCursor - cursorX / (nextZoom / TICKS_PER_BEAT));
      dispatch({ type: "session/viewportChanged", payload: { zoomPxPerBeat: nextZoom, scrollTick } });
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.deltaY === 0) return;
      e.preventDefault();
      pendingDelta += e.deltaY < 0 ? 10 : -10;
      pendingCursorX = e.clientX;
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", onWheel);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [dispatch]);

  // Click-to-seek on the ruler: the transport's seek() is fully live-capable
  // (re-schedules while playing, sets the resume point while idle) but had no
  // UI surface — the playhead could only move by playing. Snap to the beat
  // grid so a click lands on a musical boundary; clamp to the project length.
  const transport: ProjectTransport = getDependencies().transport;
  const seekToRulerX = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const beat = Math.round(xToTick(event.clientX - rect.left, zoomPxPerBeat) / CHORD_GRID);
      const tick = Math.min(lengthTicks, Math.max(0, beat * CHORD_GRID));
      transport.seek(tick);
    },
    [transport, lengthTicks, zoomPxPerBeat],
  );

  // Playhead auto-follow: while playing, keep the playhead visible with
  // DAW-style page flips — when it exits the window (or is seeked out of it),
  // jump so it sits just inside the left edge. Idle/paused never scrolls, so
  // a stopped session never fights the user's hand.
  //
  // Subscribed imperatively, NOT via useSyncExternalStore: the transport
  // snapshot changes every frame during playback, and a state subscription
  // here would re-render this whole component — both lanes — on every frame
  // just to adjust scrollLeft. A direct subscription mutates the scroller
  // with zero React renders; lanes re-render only on real changes.
  useEffect(() => {
    const follow = (): void => {
      const { status, currentTick } = transport.getSnapshot();
      if (status !== 'playing') return;
      const scroller = scrollRef.current;
      if (scroller === null) return;
      const x = tickToX(currentTick, zoomPxPerBeat);
      const margin = Math.min(120, scroller.clientWidth * 0.1);
      if (x < scroller.scrollLeft + margin || x > scroller.scrollLeft + scroller.clientWidth - margin) {
        scroller.scrollLeft = Math.max(0, x - margin);
      }
    };
    follow();
    return transport.subscribe(follow);
  }, [transport, zoomPxPerBeat]);

  const bars = useMemo(() => {
    // The ruler labels one number per measure while the lanes buffer whole
    // measures: label every bar intersecting the buffered [from, to) window,
    // never the full content length. Bar numbers match the project dialog's
    // «такты» vocabulary; beat addressing stays on the seek grid. When a
    // measure is narrower than the widest label, thin to multiples so
    // adjacent numbers never overlap (inert at the current 20..200 px/beat
    // range — a measure is ≥ 80px vs a 24px label — but kept as a guard).
    const totalBars = Math.max(1, Math.ceil(lengthTicks / TICKS_PER_BAR));
    const firstBar = Math.max(0, Math.floor(visibleRange.fromTick / TICKS_PER_BAR));
    const lastBar = Math.min(
      totalBars - 1,
      Math.ceil(visibleRange.toTick / TICKS_PER_BAR) - 1,
    );
    const labelEvery = Math.max(
      1,
      Math.ceil(RULER_MIN_LABEL_PX / measureWidthPx(zoomPxPerBeat)),
    );
    const result: number[] = [];
    for (
      let bar = Math.ceil(firstBar / labelEvery) * labelEvery;
      bar <= lastBar;
      bar += labelEvery
    ) {
      result.push(bar);
    }
    return result;
  }, [lengthTicks, visibleRange, zoomPxPerBeat]);

  return (
    <div ref={rootRef} className={className} data-testid="timeline-viewport">
      {/* Zoom controls: own toolbar row so they never overlap the ruler. */}
      <div className="timeline-zoom" title="Колесо при Ctrl/⌘ — масштаб">
        <button
          data-testid="zoom-out"
          onClick={() => zoomBy(-10)}
          disabled={zoomPxPerBeat <= MIN_ZOOM_PX_PER_BEAT}
          aria-label="Уменьшить масштаб"
        >
          −
        </button>
        <span data-testid="zoom-value" aria-live="polite">{zoomPxPerBeat} px/beat</span>
        <button
          data-testid="zoom-in"
          onClick={() => zoomBy(10)}
          disabled={zoomPxPerBeat >= MAX_ZOOM_PX_PER_BEAT}
          aria-label="Увеличить масштаб"
        >
          +
        </button>
      </div>

      <div className="timeline-body">
        {/* Left gutter (§3.20 y-axis): lane captions + pitch names for the
            visible vertical range; stays fixed while content scrolls. */}
        <div className="lane-gutter" aria-hidden="true">
          <div className="lane-gutter-ruler" style={{ height: RULER_HEIGHT_PX }}>
            {/* Track label lives in the ruler strip: the pitch labels below
                are positioned relative to the lane box and must stay aligned
                with the content rows, slot for slot. */}
            <span className="lane-gutter-ruler-caption">Мелодия</span>
          </div>
          <div className="lane-gutter-lane" style={{ height: MELODY_LANE_HEIGHT }}>
            {ROW_LABELS.map(({ top, label }) => (
              <span key={top} className="lane-gutter-row" style={{ top }}>
                {label}
              </span>
            ))}
          </div>
          <div className="lane-gutter-lane" style={{ height: CHORD_LANE_HEIGHT }}>
            <span className="lane-gutter-caption">Гармония</span>
          </div>
        </div>

        <div
          ref={scrollRef}
          data-testid="timeline-scroller"
          className="timeline-scroller"
          onScroll={onScroll}
        >
          <div style={{ position: 'relative', width: contentWidth }}>
            {/* Bar-number ruler */}
            <div
              data-testid="bar-ruler"
              className="bar-ruler"
              title="Клик — переместить позицию воспроизведения"
              onPointerDown={seekToRulerX}
              style={{ position: 'relative', height: RULER_HEIGHT_PX }}
            >
              {bars.map((bar) => (
                <MeasureLabel key={bar} bar={bar} zoom={zoomPxPerBeat} />
              ))}
            </div>

            {/* Both lanes share this scrolling ancestor → scrollLeft is in sync */}
            <MelodyLane visibleRange={visibleRange} />
            <ChordLane visibleRange={visibleRange} />

            {/* Overlay layer inside the content: children position in
                document-space pixels (Playhead translateX). */}
            {children !== undefined && (
              <div
                data-testid="viewport-overlay"
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                }}
              >
                {children}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
