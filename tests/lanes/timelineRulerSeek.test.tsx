// @vitest-environment jsdom
/**
 * Click-to-seek on the bar ruler (§3.20): a primary pointerdown moves the
 * transport playhead through ProjectTransport.seek — snapped to the beat grid
 * and clamped to the project length; non-primary buttons are ignored.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import type * as DependenciesModule from '@app/dependencies';

// jsdom has no layout engine: stub the observer (clientWidth stays 0, the
// viewport falls back to its default visible window - irrelevant to seek).
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
  seek.mockClear();
});

const { seek } = vi.hoisted(() => ({ seek: vi.fn() }));
vi.mock('@app/dependencies', async (importOriginal) => {
  const actual = await importOriginal<typeof DependenciesModule>();
  // Real dependency graph (autosave middleware reads it during setup); only
  // the transport's seek is replaced. Vitest isolates the module registry
  // per file, so mutating the singleton stays file-local.
  const deps = actual.getDependencies();
  deps.transport.seek = seek;
  return { ...actual, getDependencies: () => deps };
});

import { makeStore } from '../../src/app/store';
import { createProjectDocument } from '../../src/domain/model/project';
import { openProjectCmd } from '../../src/state/commands';
import { TimelineViewport } from '../../src/features/editor/TimelineViewport';
import { TICKS_PER_BAR, TICKS_PER_BEAT } from '../../src/domain/timeline/constants';
/** Default zoom is 40 px/beat → x = tick / 6. */
function setup(): HTMLElement {
  const store = makeStore();
  store.dispatch(
    openProjectCmd(
      createProjectDocument({
        title: 'Линейка',
        tonic: { letter: 'C', accidental: 0 },
        mode: 'ionian',
        bars: 8,
      }),
    ),
  );
  render(
    <Provider store={store}>
      <TimelineViewport />
    </Provider>,
  );
  return screen.getByTestId('bar-ruler');
}

describe('TimelineViewport ruler click-to-seek', () => {
  it('seeks to the clicked bar: bar 2 starts at tick 1920 → x = 320px', () => {
    const ruler = setup();
    fireEvent.pointerDown(ruler, { clientX: 320, button: 0 });
    expect(seek).toHaveBeenCalledWith(2 * TICKS_PER_BAR);
  });
  it('seeks to the clicked bar: bar 3 starts at tick 1920 → x = 320px', () => {
    const ruler = setup();
    fireEvent.pointerDown(ruler, { clientX: 480, button: 0 });
    expect(seek).toHaveBeenCalledWith(3 * TICKS_PER_BAR);
  });

  it('snaps to the nearest beat: 330px → beat 8, 350px → beat 9', () => {
    const ruler = setup();
    fireEvent.pointerDown(ruler, { clientX: 330, button: 0 });
    expect(seek).toHaveBeenLastCalledWith(8 * TICKS_PER_BEAT);
    fireEvent.pointerDown(ruler, { clientX: 350, button: 0 });
    expect(seek).toHaveBeenLastCalledWith(9 * TICKS_PER_BEAT);
  });

  it('clamps to [0, project length]: far-right click lands on the end, negative on 0', () => {
    const ruler = setup();
    fireEvent.pointerDown(ruler, { clientX: 99999, button: 0 });
    expect(seek).toHaveBeenLastCalledWith(8 * TICKS_PER_BAR);
    fireEvent.pointerDown(ruler, { clientX: -500, button: 0 });
    expect(seek).toHaveBeenLastCalledWith(0);
  });

  it('ignores non-primary buttons', () => {
    const ruler = setup();
    fireEvent.pointerDown(ruler, { clientX: 320, button: 2 });
    expect(seek).not.toHaveBeenCalled();
  });
});
