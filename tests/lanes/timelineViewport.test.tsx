// @vitest-environment jsdom
/**
 * TimelineViewport render windowing (§3.20): only the measures inside the
 * visible window plus two buffer measures per side are rendered as measure
 * labels — never the full content length.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';

// jsdom has no layout engine: stub the observer for the duration of each
// test; clientWidth stays 0 so the viewport falls back to its default
// 4-bar visible window.
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

import { makeStore } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import { CHORD_GRID, TICKS_PER_BAR, TICKS_PER_BEAT } from '../../src/domain/timeline/constants';
import { openProjectCmd } from '../../src/state/commands';
import { TimelineViewport } from '../../src/features/editor/TimelineViewport';
import { tickToX } from '../../src/features/editor/timelineGeometry';
import { selectViewport } from '../../src/state/selectors';

describe('TimelineViewport windowing', () => {
  it('renders visible measures + 2 buffer bars only, not total content', () => {
    const store = makeStore();
    store.dispatch(
      openProjectCmd(
        createProjectDocument({ title: 'Длинный проект', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian', bars: 60 }),
      ),
    );
    // Scroll deep into the project: first visible measure is bar index 50
    // (one bar = TICKS_PER_BAR).
    store.dispatch({
      type: 'session/viewportChanged',
      payload: { scrollTick: 50 * TICKS_PER_BAR },
    });

    render(
      <Provider store={store}>
        <TimelineViewport />
      </Provider>,
    );

    const ruler = screen.getByTestId('bar-ruler');
    const labels = Array.from(ruler.querySelectorAll('span'));

    // Fallback visible window is bars 50..53 (buffered to [48, 56) measures
    // in ticks: [184320, 215040)). The ruler labels one number per measure,
    // so the window yields bars 48..55 (0-based) → numbers 49..56.
    expect(labels).toHaveLength(8);
    const texts = labels.map((label) => label.textContent);
    expect(texts[0]).toBe('49');
    expect(texts[texts.length - 1]).toBe('56');
    expect(texts).toHaveLength(new Set(texts).size);
  });
});

describe('TimelineViewport zoom anchoring', () => {
  it('keeps the left-edge tick anchored: scrollLeft = scrollTick * newPxPerTick', () => {
    const store = makeStore();
    store.dispatch(
      openProjectCmd(createProjectDocument({ title: 'Зум', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian', bars: 60 })),
    );
    const scrollTick = 10 * CHORD_GRID;
    store.dispatch({
      type: 'session/viewportChanged',
      payload: { scrollTick },
    });

    render(
      <Provider store={store}>
        <TimelineViewport />
      </Provider>,
    );

    // jsdom has no layout engine: seed a nonzero scroll position directly.
    const scroller = screen.getByTestId('timeline-scroller');
    scroller.scrollLeft = 1234;

    const newZoomPxPerBeat = 80;
    act(() => {
      store.dispatch({
        type: 'session/viewportChanged',
        payload: { zoomPxPerBeat: newZoomPxPerBeat },
      });
    });

    expect(scroller.scrollLeft).toBe((scrollTick * newZoomPxPerBeat) / TICKS_PER_BEAT);
  });
});


describe('TimelineViewport zoom clamp wiring (§3.20 viewport bounds)', () => {
  it('repeated zoom-in saturates at 200 px/beat and repeated zoom-out at 20, with the displayed value matching session state', () => {
    const store = makeStore();
    store.dispatch(
      openProjectCmd(
        createProjectDocument({ title: 'Зум', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian', bars: 60 }),
      ),
    );

    render(
      <Provider store={store}>
        <TimelineViewport />
      </Provider>,
    );

    // Default is 40 px/beat; 20 clicks ×10 would reach 240 unclamped.
    for (let i = 0; i < 20; i++) {
      act(() => {
        fireEvent.click(screen.getByTestId('zoom-in'));
      });
    }
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(200);
    expect(screen.getByTestId('zoom-value').textContent).toBe('200 px/beat');

    // Further zoom-in clicks are inert at the cap.
    act(() => {
      fireEvent.click(screen.getByTestId('zoom-in'));
    });
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(200);

    // 50 clicks ×−10 would reach −460 unclamped; the floor holds.
    for (let i = 0; i < 50; i++) {
      act(() => {
        fireEvent.click(screen.getByTestId('zoom-out'));
      });
    }
    expect(selectViewport(store.getState()).zoomPxPerBeat).toBe(20);
    expect(screen.getByTestId('zoom-value').textContent).toBe('20 px/beat');
  });
});


describe('TimelineViewport onScroll sub-pixel coalescing', () => {
  const pxPerTick = 40 / TICKS_PER_BEAT; // default zoom

  function setup() {
    const store = makeStore();
    store.dispatch(
      openProjectCmd(createProjectDocument({ title: 'Скролл', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian', bars: 60 })),
    );
    const scrollTick = 10 * CHORD_GRID;
    store.dispatch({ type: 'session/viewportChanged', payload: { scrollTick } });
    render(
      <Provider store={store}>
        <TimelineViewport />
      </Provider>,
    );
    return { store, scroller: screen.getByTestId('timeline-scroller'), scrollTick };
  }

  it('does not dispatch viewportChanged for a sub-pixel scroll delta (<1px)', () => {
    // jsdom has no layout engine and fires no native scroll events, so the
    // position is seeded by hand and the event dispatched explicitly. A
    // half-pixel nudge off the stored left edge is ~12 ticks at default
    // zoom — far over the old sub-TICK guard (>1 tick), which wrongly
    // dispatched; the new PIXEL-epsilon guard (<1px) swallows it.
    const { store, scroller, scrollTick } = setup();
    scroller.scrollLeft = scrollTick * pxPerTick + 0.5;
    fireEvent.scroll(scroller);

    expect(selectViewport(store.getState()).scrollTick).toBe(scrollTick);
  });
  it('still dispatches the derived tick for a full-gesture scroll', () => {
    const { store, scroller } = setup();
    const target = 1236; // px

    act(() => {
      scroller.scrollLeft = target;
      fireEvent.scroll(scroller);
    });

    expect(selectViewport(store.getState()).scrollTick).toBe((target * TICKS_PER_BEAT) / 40);
  });

  it('the programmatic scrollLeft written by the zoom resync produces ZERO viewportChanged dispatches', () => {
    const { store, scroller, scrollTick } = setup();
    // jsdom has no layout engine: seed a nonzero scroll position directly.
    scroller.scrollLeft = 1234;

    // State asserts CANNOT discriminate here: after the resync the derived
    // tick equals the stored one, so even a guard-removal mutant would
    // dispatch a value-equal action. Count the dispatches instead.
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    try {
      act(() => {
        store.dispatch({
          type: 'session/viewportChanged',
          payload: { zoomPxPerBeat: 80 },
        });
      });

      // Sanity: the layout-effect resync really landed the anchored left edge.
      expect(scroller.scrollLeft).toBe((scrollTick * 80) / TICKS_PER_BEAT);

      // The browser fires a native scroll event for that programmatic write;
      // the pixel-epsilon guard must swallow it — no feedback dispatch.
      fireEvent.scroll(scroller);
      const feedbackDispatches = dispatchSpy.mock.calls.filter(
        ([action]) =>
          typeof action === 'object' &&
          action !== null &&
          'type' in action &&
          (action as { type: string }).type === 'session/viewportChanged' &&
          typeof action.payload === 'object' &&
          action.payload !== null &&
          'scrollTick' in action.payload,
      );
      expect(feedbackDispatches).toHaveLength(0);
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it('a JUST-over-epsilon gesture (2px) still dispatches the derived tick', () => {
    const { store, scroller, scrollTick } = setup();
    // ≥1px off the stored left edge is a REAL gesture: only sub-pixel
    // deltas (<1px) may be coalesced away. Kills epsilon-inflation mutants.
    const target = scrollTick * pxPerTick + 2;

    act(() => {
      scroller.scrollLeft = target;
      fireEvent.scroll(scroller);
    });

    expect(selectViewport(store.getState()).scrollTick).toBe(
      (target * TICKS_PER_BEAT) / 40,
    );
  });
});

describe('TimelineViewport measure geometry (CHORD-GEOM-1)', () => {
  function geometrySetup() {
    const store = makeStore();
    store.dispatch(
      openProjectCmd(
        createProjectDocument({ title: 'Геометрия', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian', bars: 8 }),
      ),
    );
    render(
      <Provider store={store}>
        <TimelineViewport />
      </Provider>,
    );
    return store;
  }

  it('content width covers exactly the project measures — no blank scroll runway past the end', () => {
    const store = geometrySetup();
    const zoom = selectViewport(store.getState()).zoomPxPerBeat;

    const content = document.querySelector(
      '[data-testid="timeline-scroller"] > div',
    ) as HTMLElement;
    // One measure per bar: 8 bars × measureWidthPx(zoom). The buggy math
    // divided by CHORD_GRID (a beat), quadrupling the width.
    expect(parseFloat(content.style.width)).toBe(tickToX(8 * TICKS_PER_BAR, zoom));
  });

  it('ruler labels sit one MEASURE (TICKS_PER_BAR) apart', () => {
    const store = geometrySetup();
    const zoom = selectViewport(store.getState()).zoomPxPerBeat;

    const ruler = screen.getByTestId('bar-ruler');
    const lefts = Array.from(ruler.querySelectorAll<HTMLElement>('span')).map((span) =>
      parseFloat(span.style.left),
    );
    expect(lefts.length).toBeGreaterThan(1);
    const measureSpacing = tickToX(TICKS_PER_BAR, zoom);
    lefts.slice(1).forEach((left, index) => {
      expect(left - lefts[index]!).toBeCloseTo(measureSpacing);
    });
  });

  it('ruler never labels bars past the project end when scrolled fully right', () => {
    // Scrolling past the last measure pushes the buffered window beyond the
    // content: the lastBar clamp must bind, or the ruler renders bar
    // numbers past the project's 8 bars (the unclamped mutant yields 10+).
    const store = makeStore();
    store.dispatch(
      openProjectCmd(
        createProjectDocument({ title: 'Геометрия', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian', bars: 8 }),
      ),
    );
    store.dispatch({
      type: 'session/viewportChanged',
      payload: { scrollTick: 8 * TICKS_PER_BAR },
    });

    render(
      <Provider store={store}>
        <TimelineViewport />
      </Provider>,
    );

    const ruler = screen.getByTestId('bar-ruler');
    const texts = Array.from(ruler.querySelectorAll('span')).map(
      (label) => label.textContent,
    );
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[texts.length - 1]).toBe('8');
  });
  it('ruler labels consecutive bars without overlap at min zoom', () => {
    // 40-bar project at 20 px/beat: a measure is 80px wide vs a ~24px
    // three-digit label, so every bar gets its number — no thinning needed,
    // and adjacent labels never collide.
    const store = makeStore();
    store.dispatch(
      openProjectCmd(
        createProjectDocument({ title: 'Плотность', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian', bars: 40 }),
      ),
    );
    store.dispatch({
      type: 'session/viewportChanged',
      payload: { zoomPxPerBeat: 20 },
    });

    render(
      <Provider store={store}>
        <TimelineViewport />
      </Provider>,
    );

    const ruler = screen.getByTestId('bar-ruler');
    const spans = Array.from(ruler.querySelectorAll<HTMLElement>('span'));
    expect(spans.length).toBeGreaterThan(1);
    const lefts = spans.map((span) => parseFloat(span.style.left));
    const measureSpacing = tickToX(TICKS_PER_BAR, 20);
    lefts.slice(1).forEach((left, index) => {
      expect(left - lefts[index]!).toBeCloseTo(measureSpacing);
      expect(left - lefts[index]!).toBeGreaterThanOrEqual(24);
    });
    // consecutive 1-based bar numbers: 5, 6, 7, … — stable while scrolling
    const texts = spans.map((span) => Number(span.textContent));
    texts.slice(1).forEach((value, index) => {
      expect(value).toBe(texts[index]! + 1);
    });
  });
});

