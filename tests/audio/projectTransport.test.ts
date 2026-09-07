import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createProjectDocument, type ProjectDocumentV1 } from '@domain/model/project';
import type { PlaybackProject } from '@domain/model/playback';
import { NOTE_GRID } from '@domain/timeline/constants';
import { ProjectTransport } from '@audio/projectTransport';
import { TransportStore } from '@audio/TransportStore';
import type { AudioEngine } from '@audio/AudioEngine';

type FakeEngine = {
  initialize: Mock<() => Promise<void>>;
  play: Mock<(project: unknown, fromTick: number) => Promise<void>>;
  pause: Mock<() => void>;
  stop: Mock<() => void>;
  seek: Mock<(tick: number) => void>;
  resetForNewDocument: Mock<() => void>;
  getCurrentTick: Mock<() => number>;
  updateProject: Mock<(project: unknown) => void>;
};

function makeFakeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  const engine: FakeEngine = {
    initialize: vi.fn(() => Promise.resolve()),
    play: vi.fn((_project?: unknown, _fromTick?: number) => Promise.resolve()),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    resetForNewDocument: vi.fn(),
    getCurrentTick: vi.fn(() => 123),
    updateProject: vi.fn(),
  };
  return { ...engine, ...overrides };
}


function makeDocument(notes = true): ProjectDocumentV1 {
  const doc = createProjectDocument({
    title: 'Test',
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });
  if (notes) {
    doc.melody.notes = [
      { id: 'm1', startTick: 0, durationTicks: NOTE_GRID, midi: 72, velocity: 80 },
    ];
  }
  return doc;
}

/** The transport drives a real TransportStore (status decisions) over a fake
 *  engine (call recording) — the same split the AudioEngine suite uses. */
function makeTransport(engine = makeFakeEngine()) {
  const store = new TransportStore();
  const transport = new ProjectTransport(engine as unknown as AudioEngine, store);
  return { transport, store, engine };
}

describe('ProjectTransport — play protocol', () => {
  let fake: FakeEngine;
  let transport: ProjectTransport;

  beforeEach(() => {
    fake = makeFakeEngine();
    transport = makeTransport(fake).transport;
  });

  it('renders the document and resumes from the preserved playhead', async () => {
    await transport.play(makeDocument());

    const [rendered, fromTick] = fake.play.mock.calls[0]! as [
      PlaybackProject,
      number,
    ];
    // Render-before-play: the engine receives a PlaybackProject derived from
    // the document (melody mapped through, header intact)…
    const expectedShape: Record<string, unknown> = {
      ppq: 960,
      bpm: expect.any(Number),
      lengthTicks: expect.any(Number),
      notes: [
        { track: 'melody', startTick: 0, durationTicks: NOTE_GRID, midi: 72 },
      ],
    };
    expect(rendered).toMatchObject(expectedShape);
    // …from the engine's preserved tick (resume selection lives here, not in UI).
    expect(fromTick).toBe(123);
    expect(fake.getCurrentTick).toHaveBeenCalledTimes(1);
  });

  it('seek sets the next start position through the engine', () => {
    transport.seek(960);
    expect(fake.seek).toHaveBeenCalledWith(960);
  });
});

describe('ProjectTransport — toggle (the old Space-key protocol)', () => {
  let fake: FakeEngine;
  let transport: ProjectTransport;
  let store: TransportStore;

  beforeEach(() => {
    ({ transport, store, engine: fake } = makeTransport());
  });

  it('plays when idle', async () => {
    await transport.toggle(makeDocument());
    expect(fake.pause).not.toHaveBeenCalled();
    expect(fake.play).toHaveBeenCalledTimes(1);
    expect(fake.play.mock.calls[0]![1]).toBe(123);
  });

  it('pauses when playing and never starts a second render', async () => {
    store.setStatus('playing');
    await transport.toggle(makeDocument());
    expect(fake.pause).toHaveBeenCalledTimes(1);
    expect(fake.play).not.toHaveBeenCalled();
  });

  it('ignores the toggle while starting', async () => {
    store.setStatus('starting');
    await transport.toggle(makeDocument());
    expect(fake.play).not.toHaveBeenCalled();
    expect(fake.pause).not.toHaveBeenCalled();
  });

  it('ignores the toggle without an open project — even while playing', async () => {
    await transport.toggle(null);
    expect(fake.play).not.toHaveBeenCalled();

    // Parity with the old shortcut: playing wins over the missing document.
    store.setStatus('playing');
    await transport.toggle(null);
    expect(fake.pause).toHaveBeenCalledTimes(1);
  });

  it('plays from the stored tick when paused and after an error', async () => {
    store.setStatus('paused');
    await transport.toggle(makeDocument());
    expect(fake.play).toHaveBeenCalledTimes(1);

    store.setStatus('error', 'Аудиодвижок недоступен');
    await transport.toggle(makeDocument());
    expect(fake.play).toHaveBeenCalledTimes(2);
  });
});

describe('ProjectTransport — pause / stop / reset / retry', () => {
  let fake: FakeEngine;
  let transport: ProjectTransport;
  let store: TransportStore;

  beforeEach(() => {
    ({ transport, store, engine: fake } = makeTransport());
  });

  it('delegates pause and stop (preserve-state halt)', () => {
    transport.pause();
    expect(fake.pause).toHaveBeenCalledTimes(1);
    transport.stop();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('reset is a no-op on a clean idle transport', () => {
    transport.reset();
    expect(fake.resetForNewDocument).not.toHaveBeenCalled();
  });

  it('reset halts AND clears whenever the session is not pristine', () => {
    for (const seed of [['playing'], ['paused'], ['idle']] as const) {
      fake.resetForNewDocument.mockClear();
      store.setStatus(seed[0]);
      if (seed[0] === 'idle') store.setTick(240); // stopped mid-piece, tick kept
      transport.reset();
      expect(fake.resetForNewDocument).toHaveBeenCalledTimes(1);
    }
  });

  it('reset clears a stale nonzero playhead even from idle', () => {
    store.setStatus('idle');
    store.setTick(3840);
    transport.reset();
    expect(fake.resetForNewDocument).toHaveBeenCalledTimes(1);
  });

  it('retry surfaces initialization failure as the error state, never a throw', async () => {
    fake.initialize.mockRejectedValueOnce(new Error('Аудиодвижок недоступен'));
    await expect(transport.retry()).resolves.toBeUndefined();
    expect(fake.initialize).toHaveBeenCalledTimes(1);

    await transport.retry();
    expect(fake.initialize).toHaveBeenCalledTimes(2);
  });
});

describe('ProjectTransport — updateProject (live reschedule)', () => {
  it('delegates the rendered project to the engine', () => {
    const fake = makeFakeEngine();
    const transport = makeTransport(fake).transport;
    const doc = makeDocument();

    transport.updateProject(doc);

    expect(fake.updateProject).toHaveBeenCalledTimes(1);
    const rendered = fake.updateProject.mock.calls[0]![0] as PlaybackProject;
    expect(rendered.notes).toHaveLength(1);
    expect(rendered.notes[0]).toMatchObject({ midi: 72 });
  });
});

describe('ProjectTransport — external store plumbing', () => {
  it('exposes snapshots and notifications from the shared TransportStore', () => {
    const { transport, store } = makeTransport();
    const seen: string[] = [];
    const unsubscribe = transport.subscribe(() => {
      seen.push(transport.getSnapshot().status);
    });

    store.setStatus('playing');
    unsubscribe();
    store.setStatus('paused');

    expect(seen).toEqual(['playing']);
    expect(transport.getSnapshot()).toBe(store.getSnapshot());
  });
});
