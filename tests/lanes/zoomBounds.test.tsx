// @vitest-environment jsdom
/**
 * Zoom buttons disable at the clamp bounds (20/200 px per beat): a dead
 * button that clicks but does nothing reads as a broken control — at the
 * bounds the affordance must say "no more of this direction".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';

import { makeStore } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import { openProjectCmd } from '../../src/state/commands';
import { MAX_ZOOM_PX_PER_BEAT, MIN_ZOOM_PX_PER_BEAT } from '../../src/features/editor/timelineGeometry';
import { TimelineViewport } from '../../src/features/editor/TimelineViewport';

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(bars = 8) {
  const store = makeStore();
  store.dispatch(
    openProjectCmd(
      createProjectDocument({
        title: 'Масштаб',
        tonic: { letter: 'C', accidental: 0 },
        mode: 'ionian',
        bars,
      }),
    ),
  );
  render(
    <Provider store={store}>
      <TimelineViewport />
    </Provider>,
  );
  return store;
}

describe('TimelineViewport zoom bounds', () => {
  it('disables «−» at the minimum zoom and «+» at the maximum', () => {
    setup();
    const out = screen.getByTestId('zoom-out');
    const inb = screen.getByTestId('zoom-in');

    expect(out.hasAttribute("disabled")).toBe(false);
    expect(inb.hasAttribute("disabled")).toBe(false);

    for (let i = 0; i < 40 && !out.hasAttribute("disabled"); i += 1) fireEvent.click(out);
    expect(out.hasAttribute("disabled")).toBe(true);
    expect(inb.hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId('zoom-value').textContent).toBe(`${MIN_ZOOM_PX_PER_BEAT} px/beat`);

    for (let i = 0; i < 40 && !inb.hasAttribute("disabled"); i += 1) fireEvent.click(inb);
    expect(inb.hasAttribute("disabled")).toBe(true);
    expect(out.hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId('zoom-value').textContent).toBe(`${MAX_ZOOM_PX_PER_BEAT} px/beat`);
  });
});
