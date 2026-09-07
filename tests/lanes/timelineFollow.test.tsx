// @vitest-environment jsdom
/**
 * Playhead auto-follow (§3.16 playback): while playing, a playhead that exits
 * the visible window page-flips the scroller so it sits just inside the left
 * edge. Idle/paused never scrolls — a stopped session must not fight the
 * user's hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';

import { getTransportStore } from '../../src/audio/TransportStore';
import { makeStore } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import { TICKS_PER_BEAT } from '../../src/domain/timeline/constants';
import { openProjectCmd } from '../../src/state/commands';
import { TimelineViewport } from '../../src/features/editor/TimelineViewport';

// jsdom has no layout engine: stub the observer (clientWidth is stubbed
// per-test below; the follow margin math then runs deterministically).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const transportStore = getTransportStore();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  transportStore.setStatus('idle');
  transportStore.setTick(0);
});

function setup(): HTMLElement {
  const store = makeStore();
  store.dispatch(
    openProjectCmd(
      createProjectDocument({
        title: 'Автоследование',
        tonic: { letter: 'C', accidental: 0 },
        mode: 'ionian',
        bars: 32,
      }),
    ),
  );
  render(
    <Provider store={store}>
      <TimelineViewport />
    </Provider>,
  );
  const scroller = screen.getByTestId('timeline-scroller');
  // 800px visible window at the default 40 px/beat = 20 beats = 5 bars.
  Object.defineProperty(scroller, 'clientWidth', { value: 800 });
  // jsdom has no layout engine: scrollLeft neither persists assignments nor
  // reports them — back it with a plain field so the flip is assertable.
  let scrollLeftValue = 0;
  Object.defineProperty(scroller, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeftValue,
    set: (value: number) => {
      scrollLeftValue = value;
    },
  });
  return scroller;
}

describe('TimelineViewport playhead auto-follow', () => {
  it('page-flips when the playing playhead exits the right edge', () => {
    const scroller = setup();
    // Store publishes land outside React's event system: wrap in act() so the
    // follow effect flushes before the assertion.
    act(() => {
      transportStore.setStatus('playing');
      // Beat 20 → x = 800px: past the window [0, 800), flip puts it at the
      // 10% left margin (80px → scrollLeft 720).
      transportStore.setTick(20 * TICKS_PER_BEAT);
    });
    expect(scroller.scrollLeft).toBe(720);
  });

  it('keeps the scroller still while the playhead stays inside the window', () => {
    const scroller = setup();
    act(() => {
      transportStore.setStatus('playing');
      transportStore.setTick(20 * TICKS_PER_BEAT);
    });
    expect(scroller.scrollLeft).toBe(720);
    // Beat 25 → x = 1000: inside [720, 1520-80) → no further jump.
    act(() => {
      transportStore.setTick(25 * TICKS_PER_BEAT);
    });
    expect(scroller.scrollLeft).toBe(720);
  });

  it('never scrolls while idle or paused', () => {
    const scroller = setup();
    act(() => {
      transportStore.setTick(20 * TICKS_PER_BEAT);
    });
    expect(scroller.scrollLeft).toBe(0);
    act(() => {
      transportStore.setStatus('playing');
      transportStore.setTick(20 * TICKS_PER_BEAT);
    });
    expect(scroller.scrollLeft).toBe(720);
    act(() => {
      transportStore.setStatus('paused');
      transportStore.setTick(30 * TICKS_PER_BEAT);
    });
    expect(scroller.scrollLeft).toBe(720);
  });
});
