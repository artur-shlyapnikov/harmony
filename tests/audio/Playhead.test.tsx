// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Playhead } from '@features/editor/Playhead';
import { getTransportStore } from '@audio/TransportStore';

vi.mock('@features/editor/timelineGeometry', () => ({
  // Document-space contract: x = tick / TICKS_PER_BEAT * zoomPxPerBeat.
  timelineGeometry: {
    tickToX: vi.fn((tick: number, zoomPxPerBeat: number) => (tick / 960) * zoomPxPerBeat),
  },
}));

const store = getTransportStore();

vi.mock('@app/hooks', () => ({
  useAppSelector: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ session: { viewport: { zoomPxPerBeat: 40 } } }),
  ),
}));

describe('Playhead', () => {
  beforeEach(() => {
    act(() => {
      store.setStatus('idle');
      store.setTick(0);
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('positions itself from the transport tick and viewport zoom', () => {
    act(() => {
      store.setTick(480); // half a beat @ zoom 40 → x = 20px
    });

    const view = render(<Playhead />);
    expect(screen.getByTestId('playhead').style.transform).toBe('translateX(20px)');
    view.unmount();
  });

  it('repositions when the store publishes a new tick', () => {
    const view = render(<Playhead />);
    const playhead = screen.getByTestId('playhead');

    act(() => {
      store.setTick(960);
    });

    expect(playhead.style.transform).toBe('translateX(40px)');
    view.unmount();
  });
});

