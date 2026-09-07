// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectDocument } from '@domain/model/project';
import type { ProjectDocumentV1 } from '@domain/model/project';
import { TransportControls } from '@features/transport/TransportControls';
import { useAppSelector } from '@app/hooks';
import { getTransportStore } from '@audio/TransportStore';
import type { RootState } from '@app/store';

const h = vi.hoisted(() => ({
  transport: {
    play: vi.fn((_project?: unknown) => Promise.resolve()),
    pause: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@app/dependencies', () => ({
  getDependencies: () => ({ transport: h.transport }),
}));

const store = getTransportStore();

const project: ProjectDocumentV1 = createProjectDocument({
  title: 'Test',
  tonic: { letter: 'C', accidental: 0 },
  mode: 'ionian',
});

vi.mock('@app/hooks', () => ({
  useAppSelector: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ projectHistory: { present: project }, session: { viewport: { zoomPxPerBeat: 40 } } }),
  ),
}));

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name });
}

describe('TransportControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      store.setStatus('idle');
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders status and button availability per transport state', () => {
    render(<TransportControls />);

    expect(screen.getByTestId('transport-status').textContent).toBe('Готов к воспроизведению');
    // State changes («Воспроизведение», «Ошибка: …») must reach screen readers.
    expect(screen.getByTestId('transport-status').getAttribute('aria-live')).toBe('polite');
    expect(button('Играть').disabled).toBe(false);
    expect(button('Пауза').disabled).toBe(true);
    expect(button('Стоп').disabled).toBe(true);
  });

  it('play delegates the open project to the transport', async () => {
    const user = userEvent.setup();
    render(<TransportControls />);

    await user.click(button('Играть'));

    // Wiring only: render-before-play and resume-tick selection are the
    // ProjectTransport's contract (tests/audio/projectTransport.test.ts).
    expect(h.transport.play).toHaveBeenCalledTimes(1);
    expect(h.transport.play).toHaveBeenCalledWith(project);
  });

  it('pause and stop delegate to the transport', async () => {
    const user = userEvent.setup();
    act(() => {
      store.setStatus('playing');
    });
    render(<TransportControls />);

    expect(screen.getByTestId('transport-status').textContent).toBe('Воспроизведение');
    expect(button('Играть').disabled).toBe(true);
    expect(button('Пауза').disabled).toBe(false);

    await user.click(button('Пауза'));
    expect(h.transport.pause).toHaveBeenCalledTimes(1);

    await user.click(button('Стоп'));
    expect(h.transport.stop).toHaveBeenCalledTimes(1);
  });

  it('shows Повторить звук only in the error state and retries initialization', async () => {
    const user = userEvent.setup();
    render(<TransportControls />);
    expect(screen.queryByRole('button', { name: 'Повторить звук' })).toBeNull();

    act(() => {
      store.setStatus('error', 'Аудиодвижок недоступен');
    });

    expect(screen.getByTestId('transport-status').textContent).toBe(
      'Ошибка звука: Аудиодвижок недоступен',
    );
    await user.click(button('Повторить звук'));
    expect(h.transport.retry).toHaveBeenCalledTimes(1);

    act(() => {
      store.setStatus('idle');
    });
    expect(screen.queryByRole('button', { name: 'Повторить звук' })).toBeNull();
  });

  it('moves focus to Play when «Повторить звук» unmounts with focus', () => {
    act(() => {
      store.setStatus('error', 'Аудиодвижок недоступен');
    });
    render(<TransportControls />);

    const retry = button('Повторить звук');
    retry.focus();
    expect(document.activeElement).toBe(retry);

    act(() => {
      store.setStatus('idle');
    });

    expect(screen.queryByRole('button', { name: 'Повторить звук' })).toBeNull();
    expect(document.activeElement).toBe(button('Играть'));
  });

  it('disables Play while starting', () => {
    act(() => {
      store.setStatus('starting');
    });
    render(<TransportControls />);

    expect(screen.getByTestId('transport-status').textContent).toBe('Запуск аудио…');
    expect(button('Играть').disabled).toBe(true);
  });

  it('with no open project Play is disabled and clicking it never calls the engine', () => {
    const selectorMock = vi.mocked(useAppSelector);
    const original = selectorMock.getMockImplementation();
    const state = {
      projectHistory: { present: null, past: [], future: [] },
      session: {
        viewport: { scrollTick: 0, zoomPxPerBeat: 40, melodyCenterMidi: 72 },
      },
    } as unknown as RootState;
    selectorMock.mockImplementation((selector: (state: RootState) => unknown) =>
      selector(state),
    );
    try {
      render(<TransportControls />);

      expect(button('Играть').disabled).toBe(true);
      // Idle transport: Pause and Stop are disabled regardless.
      expect(button('Пауза').disabled).toBe(true);
      expect(button('Стоп').disabled).toBe(true);

      fireEvent.click(button('Играть'));
      expect(h.transport.play).not.toHaveBeenCalled();
      expect(h.transport.pause).not.toHaveBeenCalled();
      expect(h.transport.stop).not.toHaveBeenCalled();
    } finally {
      selectorMock.mockImplementation(original!);
    }
  });
});
