// @vitest-environment jsdom
/**
 * Ctrl/⌘+wheel zooms the timeline through the same clamped viewport dispatch
 * as the +/- buttons; a plain wheel event must not touch the zoom (it keeps
 * its native scroll meaning).
 *
 * Wheel bursts are coalesced per animation frame (§3.20): trackpads deliver
 * events faster than frames and every zoom step re-renders both lanes, so
 * deltas accumulate and one clamped dispatch runs per frame. Tests stub
 * requestAnimationFrame and flush frames explicitly.
 */

// jsdom has no layout engine: stub the observer (clientWidth stays 0, the
// viewport falls back to its default visible window — irrelevant to zoom).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'react-redux';

import { makeStore } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import { openProjectCmd } from '../../src/state/commands';
import { TimelineViewport } from '../../src/features/editor/TimelineViewport';
import { TICKS_PER_BEAT, CHORD_GRID } from '../../src/domain/timeline/constants';
import { selectViewport } from '../../src/state/selectors';

function setup() {
  const store = makeStore();
  store.dispatch(
    openProjectCmd(
      createProjectDocument({ title: 't', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' }),
    ),
  );
  render(
    <Provider store={store}>
      <TimelineViewport />
    </Provider>,
  );
  return store;
}

/** Capture the coalescer's frame callback; flush() runs it under act(). */
function stubFrame(): { flush: () => void } {
  let flush: (() => void) | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    flush = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return {
    flush: () =>
      act(() => {
        flush?.();
      }),
  };
}

describe('TimelineViewport wheel zoom', () => {
  it('ctrl+wheel up zooms in, ctrl+wheel down zooms out, clamped to limits', () => {
    const store = setup();
    const { flush } = stubFrame();
    const root = screen.getByTestId('timeline-viewport');
    const zoom = () => selectViewport(store.getState()).zoomPxPerBeat;
    const start = zoom();

    fireEvent.wheel(root, { ctrlKey: true, deltaY: -120 });
    flush();
    expect(zoom()).toBe(start + 10);

    fireEvent.wheel(root, { ctrlKey: true, deltaY: 120 });
    flush();
    expect(zoom()).toBe(start);

    // 40 events inside ONE frame accumulate (+400) and clamp in the single
    // per-frame dispatch — never 40 separate renders.
    for (let i = 0; i < 40; i++) fireEvent.wheel(root, { ctrlKey: true, deltaY: -120 });
    flush();
    expect(zoom()).toBeLessThanOrEqual(200);
  });

  it('plain wheel (no ctrl/meta) never changes the zoom', () => {
    const store = setup();
    stubFrame();
    const root = screen.getByTestId('timeline-viewport');
    const before = selectViewport(store.getState()).zoomPxPerBeat;
    fireEvent.wheel(root, { deltaY: -120 });
    fireEvent.wheel(root, { deltaY: 120 });
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(before);
  });

  it('⌘+wheel zooms too (macOS convention)', () => {
    const store = setup();
    const { flush } = stubFrame();
    const root = screen.getByTestId('timeline-viewport');
    const before = selectViewport(store.getState()).zoomPxPerBeat;
    fireEvent.wheel(root, { metaKey: true, deltaY: -120 });
    flush();
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(before + 10);
  });

  it('a wheel burst dispatches once per frame: deltas accumulate into one clamped step', () => {
    const store = setup();
    const { flush } = stubFrame();
    const scroller = screen.getByTestId('timeline-scroller');

    // Three events inside one frame: no dispatch until the frame runs.
    for (let i = 0; i < 3; i++) {
      act(() => {
        fireEvent.wheel(scroller, { ctrlKey: true, deltaY: -120 });
      });
    }
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(40);

    flush();
    // Default 40 + 3×10 accumulated.
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(70);
  });

  it('the next burst computes from the freshly committed zoom, not a captured stale base', () => {
    const store = setup();
    const { flush } = stubFrame();
    const root = screen.getByTestId('timeline-viewport');

    fireEvent.wheel(root, { ctrlKey: true, deltaY: -120 });
    flush();
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(50);

    // A stale zoomBy closure would recompute from 40 (yielding 50 again);
    // the ref-fresh one continues from 50.
    fireEvent.wheel(root, { ctrlKey: true, deltaY: -120 });
    flush();
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(60);
  });

  it('wheel zoom anchors at the pointer: the content tick under the cursor is preserved', () => {
    const store = setup();
    const { flush } = stubFrame();
    const root = screen.getByTestId('timeline-viewport');
    const scroller = screen.getByTestId('timeline-scroller');

    const scrollTick = 10 * CHORD_GRID;
    store.dispatch({
      type: 'session/viewportChanged',
      payload: { scrollTick },
    });
    // jsdom has no layout engine: seed the scroll position directly.
    scroller.scrollLeft = 1234;

    // jsdom rects are all-zero, so cursorX == clientX. The tick under the
    // cursor before the zoom: (scrollLeft + clientX) / (40 / TICKS_PER_BEAT).
    const clientX = 700;
    const tickAtCursor = (1234 + clientX) / (40 / TICKS_PER_BEAT);

    fireEvent.wheel(root, { ctrlKey: true, deltaY: -120, clientX });
    flush();

    const viewport = selectViewport(store.getState());
    expect(viewport.zoomPxPerBeat).toBe(50);
    // One action carries BOTH fields: the resync must land the compensated
    // left edge, not the stale pre-zoom tick.
    expect(viewport.scrollTick).toBe(tickAtCursor - clientX / (50 / TICKS_PER_BEAT));
    // Invariant: the same tick still sits under the cursor after the zoom.
    const newPxPerTick = viewport.zoomPxPerBeat / TICKS_PER_BEAT;
    expect((viewport.scrollTick * newPxPerTick + clientX) / newPxPerTick).toBe(tickAtCursor);
    // The resync landed the compensated scrollLeft before paint.
    expect(scroller.scrollLeft).toBe(viewport.scrollTick * newPxPerTick);
  });

  it('zooming out anchors at the pointer too and clamps the left edge at 0', () => {
    const store = setup();
    const { flush } = stubFrame();
    const root = screen.getByTestId('timeline-viewport');
    const scroller = screen.getByTestId('timeline-scroller');

    const clientX = 300;
    fireEvent.wheel(root, { ctrlKey: true, deltaY: 120, clientX });
    flush();

    const viewport = selectViewport(store.getState());
    expect(viewport.zoomPxPerBeat).toBe(30);
    // tickAtCursor = (0 + 300) / (40/960); compensated tick would be
    // negative → clamped to 0, matching the native scrollLeft floor.
    expect(viewport.scrollTick).toBe(0);
    expect(scroller.scrollLeft).toBe(0);
  });
});
