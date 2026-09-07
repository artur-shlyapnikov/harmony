import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackProject } from '@domain/model/playback';
import { AudioEngine, secondsToTicks, ticksToSeconds } from '@audio/AudioEngine';
import { AudioInitError } from '@audio/audioErrors';
import { TransportStore } from '@audio/TransportStore';

const h = vi.hoisted(() => {
  const toneStart = vi.fn<(context?: unknown) => Promise<unknown>>();
  const transport = {
    bpm: { value: 120 },
    seconds: 0,
    state: 'stopped' as 'started' | 'paused' | 'stopped',
    schedule: vi.fn((_callback: (time: number) => void, _seconds: number) => 1),
    cancel: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
  };
  const context = {
    state: 'running' as 'running' | 'suspended',
    resume: vi.fn(async () => {
      context.state = 'running';
    }),
    suspend: vi.fn(async () => {
      context.state = 'suspended';
    }),
    rawContext: {
      suspend: vi.fn(async () => {
        context.state = 'suspended';
      }),
    },
  };
  const triggerAttackRelease = vi.fn();
  const synthFactory = () => ({
    triggerAttackRelease,
    releaseAll: vi.fn(),
    triggerRelease: vi.fn(),
    dispose: vi.fn(),
  });
  const instruments = { melody: synthFactory(), harmony: synthFactory(), dispose: vi.fn() };
  return { toneStart, transport, context, triggerAttackRelease, instruments, failToneImport: false };
});

vi.mock('tone', () => {
  if (h.failToneImport) {
    // Simulates the dynamic import itself rejecting (chunk/network failure).
    throw new Error('Failed to fetch dynamically imported module: tone');
  }
  return {
    getTransport: () => h.transport,
    start: (context?: unknown) => h.toneStart(context),
    getContext: () => h.context,
  };
});

vi.mock('@audio/instruments', () => ({
  createInstruments: () => h.instruments,
}));

// ppq=100, bpm=60 → exactly 100 ticks per second; easy mental math.
function makeProject(overrides: Partial<PlaybackProject> = {}): PlaybackProject {
  return {
    ppq: 100,
    bpm: 60,
    timeSignature: [4, 4],
    lengthTicks: 4000,
    notes: [],
    ...overrides,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AudioEngine timing math', () => {
  it('converts ticks to seconds via ppq and bpm', () => {
    expect(ticksToSeconds(960, 960, 60)).toBe(1);
    // 3840/480 = 8 beats @ 0.5 s/beat = 4 s.
    expect(ticksToSeconds(3840, 480, 120)).toBe(4);
    expect(ticksToSeconds(0, 960, 120)).toBe(0);
    expect(ticksToSeconds(250, 100, 60)).toBeCloseTo(2.5, 10);
  });

  it('round-trips seconds back to whole ticks', () => {
    expect(secondsToTicks(2.5, 100, 60)).toBe(250);
    // 0.75 s @ 120 bpm = 1.5 beats = 1440 ticks @ ppq 960.
    expect(secondsToTicks(0.75, 960, 120)).toBe(1440);
  });
});

describe('AudioEngine', () => {
  let store: TransportStore;
  let engine: AudioEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    h.toneStart.mockResolvedValue(undefined);
    h.transport.state = 'stopped';
    h.transport.seconds = 0;
    h.transport.bpm.value = 120;
    h.context.state = 'running';
    store = new TransportStore();
    engine = new AudioEngine(store);
  });
  // FLK-A1: kill any pump a test leaves running before it leaks into the
  // next test's window, and never inherit real-timer mode in fake-timer cells.
  afterEach(() => {
    vi.useRealTimers();
    engine.stop();
  });
  it('re-imports tone after the dynamic import itself rejects (§3.17)', async () => {
    // Must run before any other test caches a successful tone import.
    h.failToneImport = true;

    await expect(engine.initialize()).rejects.toBeInstanceOf(AudioInitError);
    expect(store.getSnapshot()).toMatchObject({ status: 'error' });
    expect(store.getSnapshot().errorMessage).toBeTruthy();

    h.failToneImport = false;
    await engine.initialize();
    expect(store.getSnapshot().status).toBe('idle');
  });

  it('concurrent initialize() joining an in-flight init does not stale play() (§3.21)', async () => {
    let resolveInit!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    h.toneStart.mockReturnValue(gate);

    const project = makeProject({
      notes: [{ track: 'melody', startTick: 0, durationTicks: 50, midi: 60, velocity: 102, sourceEventId: 'a' }],
    });

    const playing = engine.play(project, 0);
    // Joins the same init cycle: must not bump operationId and stale the play.
    const init = engine.initialize();

    resolveInit();
    await Promise.all([playing, init]);
    await flushMicrotasks();

    expect(h.transport.start).toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('playing');
  });

  it('schedules all notes at absolute times with correct conversion', async () => {
    const project = makeProject({
      notes: [
        { track: 'melody', startTick: 250, durationTicks: 50, midi: 69, velocity: 102, sourceEventId: 'm1' },
        { track: 'harmony', startTick: 500, durationTicks: 100, midi: 48, velocity: 64, sourceEventId: 'c1' },
      ],
    });

    await engine.play(project, 0);

    expect(h.toneStart).toHaveBeenCalledTimes(1);
    expect(h.transport.bpm.value).toBe(60);
    // 250 ticks @100 ticks/sec → 2.5s, 500 → 5s.
    expect(h.transport.schedule).toHaveBeenCalledTimes(2);
    for (const call of h.transport.schedule.mock.calls) {
      (call[0])(123);
    }
    // PlaybackNote.velocity is a MIDI byte; the engine normalizes to 0..1.
    expect(h.triggerAttackRelease).toHaveBeenCalledWith(
      440, // midi 69
      0.5,
      123,
      expect.closeTo(102 / 127, 5),
    );
    expect(h.triggerAttackRelease).toHaveBeenCalledWith(
      expect.closeTo(130.81, 1), // midi 48
      1,
      123,
      expect.closeTo(64 / 127, 5),
    );
    expect(store.getSnapshot().status).toBe('playing');
  });

  it('skips notes entirely before the start tick and empty-duration notes', async () => {
    const project = makeProject({
      notes: [
        { track: 'melody', startTick: 0, durationTicks: 50, midi: 60, velocity: 102, sourceEventId: 'a' },
        { track: 'melody', startTick: 300, durationTicks: 100, midi: 62, velocity: 102, sourceEventId: 'b' },
        { track: 'harmony', startTick: 900, durationTicks: 0, midi: 55, velocity: 64, sourceEventId: 'c' },
      ],
    });

    await engine.play(project, 350);

    expect(h.transport.schedule).toHaveBeenCalledTimes(1);
  });

  it('clips a note straddling the resume tick: it sounds at the resume point with a reduced duration (§3.17)', async () => {
    const project = makeProject({
      notes: [
        // Straddles fromTick=350: started at 300, still sounding until 500.
        { track: 'melody', startTick: 300, durationTicks: 200, midi: 69, velocity: 102, sourceEventId: 'm1' },
        // Starts after the resume point: must keep its absolute time.
        { track: 'harmony', startTick: 600, durationTicks: 50, midi: 48, velocity: 64, sourceEventId: 'c1' },
      ],
    });

    await engine.play(project, 350);

    expect(h.transport.schedule).toHaveBeenCalledTimes(2);
    const [straddleCallback, straddleAt] = h.transport.schedule.mock.calls[0]!;
    const [, laterAt] = h.transport.schedule.mock.calls[1]!;
    // The straddler is scheduled at the transport start offset (3.5s), not its
    // original start (3.0s) which lies before it and would never fire.
    expect(straddleAt).toBe(3.5);
    expect(laterAt).toBe(6); // non-straddler keeps its absolute time
    straddleCallback(123);
    // Remaining duration: (300+200−350) ticks = 150 ticks = 1.5s.
    expect(h.triggerAttackRelease).toHaveBeenCalledWith(440, 1.5, 123, expect.closeTo(102 / 127, 5));
  });

  it('ignores stale initialize completion after a quick play→stop race (§3.21)', async () => {
    let resolveInit!: () => void;
    h.toneStart.mockReturnValue(
      new Promise((resolve) => {
        resolveInit = () => resolve(undefined);
      }),
    );

    const project = makeProject();
    const playing = engine.play(project, 0);
    expect(store.getSnapshot().status).toBe('starting');

    engine.stop();
    resolveInit();
    await playing;
    await flushMicrotasks();

    expect(h.transport.schedule).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('idle');
  });

  it('pause during starting cancels the in-flight start: playback never begins', async () => {
    let resolveInit!: () => void;
    h.toneStart.mockReturnValue(new Promise((resolve) => { resolveInit = () => resolve(undefined); }));

    const project = makeProject({
      notes: [{ track: 'melody', startTick: 0, durationTicks: 50, midi: 60, velocity: 102, sourceEventId: 'a' }],
    });
    const playing = engine.play(project, 0);
    expect(store.getSnapshot().status).toBe('starting');

    engine.pause();
    expect(store.getSnapshot().status).toBe('idle');

    resolveInit();
    await playing;
    await flushMicrotasks();

    // The settling init must not schedule notes or start the transport.
    expect(h.transport.schedule).not.toHaveBeenCalled();
    expect(h.transport.start).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('idle');
  });

  it('after pause during starting, play resumes from the preserved tick', async () => {
    let resolveInit!: () => void;
    h.toneStart.mockReturnValue(new Promise((resolve) => { resolveInit = () => resolve(undefined); }));

    const project = makeProject();
    engine.seek(150);
    const playing = engine.play(project, 150);
    engine.pause();

    resolveInit();
    await playing;
    await flushMicrotasks();

    // storedTick survived the aborted start: the next play resumes there.
    expect(engine.getCurrentTick()).toBe(150);
    h.transport.state = 'stopped';
    // The aborted start never reached the transport.
    expect(h.transport.start).not.toHaveBeenCalled();
    await engine.play(project, engine.getCurrentTick());

    expect(h.transport.seconds).toBe(1.5); // 150 ticks @100 ticks/sec
    expect(store.getSnapshot()).toMatchObject({ status: 'playing', currentTick: 150 });
  });

  it('stop preserves the live playhead for the next Play (§3.16)', async () => {
    await engine.play(makeProject(), 0);

    h.transport.state = 'started';
    h.transport.seconds = 3.5; // 350 ticks @100 ticks/sec

    engine.stop();

    expect(h.transport.cancel).toHaveBeenCalled();
    expect(h.transport.stop).toHaveBeenCalled();
    expect(h.transport.seconds).toBe(0);
    expect(store.getSnapshot()).toMatchObject({ status: 'idle', currentTick: 350 });
    expect(engine.getCurrentTick()).toBe(350);
  });

  it('pause freezes position and reports paused', async () => {
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';
    h.transport.seconds = 1.25; // 125 ticks

    engine.pause();

    expect(h.transport.pause).toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('paused');
    expect(engine.getCurrentTick()).toBe(125);
  });

  it('seek sets the pending start used by the next play', async () => {
    engine.seek(300);
    expect(engine.getCurrentTick()).toBe(300);

    await engine.play(makeProject(), 0);

    expect(h.transport.seconds).toBe(3); // 300 ticks @100 ticks/sec
    expect(h.transport.start).toHaveBeenCalled();
  });

  it('seek moves the live position while playing', async () => {
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';

    engine.seek(150);

    expect(h.transport.seconds).toBe(1.5);
    expect(engine.getCurrentTick()).toBe(150);
  });

  it('live seek is consumed: pause then play resumes from the pause point', async () => {
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';

    engine.seek(100); // live jump to 100 ticks
    h.transport.seconds = 3.5; // playback advanced to 350 ticks since
    engine.pause();
    expect(engine.getCurrentTick()).toBe(350);

    h.transport.state = 'paused';
    await engine.play(makeProject(), engine.getCurrentTick());

    // Resumes from the pause position (350 ticks = 3.5s), NOT the stale
    // seek target (100 ticks = 1s).
    expect(h.transport.seconds).toBe(3.5);
    expect(store.getSnapshot()).toMatchObject({ status: 'playing', currentTick: 350 });
  });

  it('reports error on init failure and recovers on retry', async () => {
    h.toneStart.mockRejectedValueOnce(new Error('AudioContext unavailable'));

    await expect(engine.initialize()).rejects.toBeInstanceOf(AudioInitError);
    expect(store.getSnapshot()).toMatchObject({ status: 'error' });
    expect(store.getSnapshot().errorMessage).toBeTruthy();

    await engine.initialize();
    expect(store.getSnapshot().status).toBe('idle');
  });

  it('maps out-of-range velocities into a sane range', async () => {
    const project = makeProject({
      notes: [{ track: 'melody', startTick: 0, durationTicks: 10, midi: 60, velocity: 0, sourceEventId: 'v' }],
    });
    await engine.play(project, 0);

    const callback = h.transport.schedule.mock.calls[0]![0];
    callback(0);
    expect(h.triggerAttackRelease).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 0, 0.05);
  });
  it('normalizes MIDI-byte velocities to 0..1 so dynamics survive', async () => {
    const project = makeProject({
      notes: [
        { track: 'melody', startTick: 0, durationTicks: 10, midi: 60, velocity: 127, sourceEventId: 'loud' },
        { track: 'melody', startTick: 20, durationTicks: 10, midi: 62, velocity: 64, sourceEventId: 'soft' },
      ],
    });
    await engine.play(project, 0);

    expect(h.transport.schedule).toHaveBeenCalledTimes(2);
    for (const call of h.transport.schedule.mock.calls) {
      (call[0])(0);
    }
    expect(h.triggerAttackRelease).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      0,
      1,
    );
    expect(h.triggerAttackRelease).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      0,
      expect.closeTo(64 / 127, 5),
    );
  });

  it('dispose tears down instruments, events and status', async () => {
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';

    engine.dispose();

    expect(h.instruments.dispose).toHaveBeenCalledTimes(1);
    expect(h.transport.cancel).toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('idle');
    expect(engine.getCurrentTick()).toBe(0);
  });

  it('stops playback once the playhead passes the rendered project length (§3.16)', async () => {
    // Fake timers drive the rAF pump deterministically (no wall-clock waits).
    vi.useFakeTimers();
    try {
      const project = makeProject({ lengthTicks: 4000 });
      await engine.play(project, 0);
      expect(store.getSnapshot().status).toBe('playing');

      h.transport.state = 'started';
      h.transport.seconds = 41; // 4100 ticks — past the 4000-tick project end

      await vi.advanceTimersByTimeAsync(50);

      expect(store.getSnapshot().status).toBe('idle');
      expect(store.getSnapshot().currentTick).toBe(4100);
      expect(engine.getCurrentTick()).toBe(4100);
      // The stop fires once even though the pump keeps ticking past the end.
      expect(h.transport.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops playback when the playhead reaches the project length EXACTLY (tick == lengthTicks)', async () => {
    // Fake timers drive the rAF pump deterministically (no wall-clock waits).
    vi.useFakeTimers();
    try {
      const project = makeProject({ lengthTicks: 4000 });
      await engine.play(project, 0);
      expect(store.getSnapshot().status).toBe('playing');

      h.transport.state = 'started';
      h.transport.seconds = 40; // exactly 4000 ticks @ ppq=100, bpm=60 — AT the end

      await vi.advanceTimersByTimeAsync(50);

      expect(store.getSnapshot().status).toBe('idle');
      expect(engine.getCurrentTick()).toBe(4000);
      // Single-fire survives at the boundary too, despite continued pumping.
      expect(h.transport.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });


  it('resetForNewDocument halts a paused transport and clears the playhead (§3.17 project switch)', async () => {
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';
    h.transport.seconds = 3.5;
    engine.pause();
    expect(engine.getCurrentTick()).toBe(350);

    engine.resetForNewDocument();

    expect(h.transport.cancel).toHaveBeenCalled();
    expect(h.transport.stop).toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ status: 'idle', currentTick: 0 });
    expect(engine.getCurrentTick()).toBe(0);
  });

  it('resetForNewDocument drops a pending seek so the new session starts at the requested tick', async () => {
    engine.seek(200);
    engine.resetForNewDocument();

    await engine.play(makeProject(), 0);

    expect(h.transport.seconds).toBe(0);
  });

  it('seek backward while playing cancels and re-schedules: the straddler regains its full remaining duration (§3.17)', async () => {
    const project = makeProject({
      notes: [
        { track: 'melody', startTick: 300, durationTicks: 200, midi: 69, velocity: 102, sourceEventId: 'm1' },
      ],
    });
    await engine.play(project, 350);
    h.transport.state = 'started';
    // Resume clip: the straddler was scheduled at 3.5s with the reduced 1.5s duration.
    expect(h.transport.schedule).toHaveBeenCalledTimes(1);

    engine.seek(320); // backward, still inside the straddler

    expect(h.transport.seconds).toBe(3.2);
    expect(h.transport.schedule).toHaveBeenCalledTimes(2);
    const [callback, at] = h.transport.schedule.mock.calls[1]!;
    expect(at).toBe(3.2);
    callback(123);
    // Full remaining duration from 320: (300+200−320)=180 ticks = 1.8s,
    // NOT the stale resume clip of 1.5s.
    expect(h.triggerAttackRelease).toHaveBeenLastCalledWith(440, 1.8, 123, expect.closeTo(102 / 127, 5));
  });

  it('play from the project end restarts from the top instead of a dead settle (§3.17)', async () => {
    const project = makeProject({ lengthTicks: 4000 });

    await engine.play(project, 4000);

    // Natural completion rests the playhead at the end; a play request there
    // must restart (Space revives), not idle into a state where Space is dead.
    expect(store.getSnapshot().status).toBe('playing');
    expect(engine.getCurrentTick()).toBe(0);
    expect(h.transport.start).toHaveBeenCalled();

    // A pending seek past the end restarts the same way.
    engine.seek(4500);
    await engine.play(project, 0);
    expect(store.getSnapshot().status).toBe('playing');
    expect(engine.getCurrentTick()).toBe(0);
  });

  it('stop() suspends the context only after the tail-decay grace (idle power)', async () => {
    vi.useFakeTimers();
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';
    engine.stop();
    // Tails decay while the context still runs.
    expect(h.context.rawContext.suspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(h.context.rawContext.suspend).toHaveBeenCalledTimes(1);
    expect(h.context.state).toBe('suspended');
  });

  it('pause() arms the same idle suspend', async () => {
    vi.useFakeTimers();
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';
    engine.pause();
    vi.advanceTimersByTime(600);
    expect(h.context.rawContext.suspend).toHaveBeenCalledTimes(1);
  });

  it('play() before the grace elapses cancels the pending idle suspend', async () => {
    vi.useFakeTimers();
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';
    engine.stop();
    h.transport.state = 'stopped';
    await engine.play(makeProject(), 0);
    vi.advanceTimersByTime(600);
    expect(h.context.rawContext.suspend).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('playing');
  });

  it('play() after the idle suspend resumes the context', async () => {
    vi.useFakeTimers();
    await engine.play(makeProject(), 0);
    h.transport.state = 'started';
    engine.stop();
    vi.advanceTimersByTime(600);
    expect(h.context.state).toBe('suspended');
    h.transport.state = 'stopped';
    await engine.play(makeProject(), 0);
    expect(h.context.resume).toHaveBeenCalled();
    expect(h.context.state).toBe('running');
    expect(store.getSnapshot().status).toBe('playing');
  });

  it('updateProject reschedules from the live playhead: the deleted note never sounds', async () => {
    const before = makeProject({
      notes: [
        { track: 'melody', startTick: 200, durationTicks: 50, midi: 69, velocity: 102, sourceEventId: 'a' },
        { track: 'harmony', startTick: 500, durationTicks: 100, midi: 48, velocity: 64, sourceEventId: 'b' },
      ],
    });
    await engine.play(before, 0);
    expect(h.transport.schedule).toHaveBeenCalledTimes(2);

    // Playback advanced to 100 ticks; the melody note at 200 was deleted.
    h.transport.state = 'started';
    h.transport.seconds = 1;
    engine.updateProject(
      makeProject({
        notes: [
          { track: 'harmony', startTick: 500, durationTicks: 100, midi: 48, velocity: 64, sourceEventId: 'b' },
        ],
      }),
    );

    // Only the surviving future note is scheduled now (at its absolute 5s).
    expect(h.transport.schedule).toHaveBeenCalledTimes(3);
    const [, at] = h.transport.schedule.mock.calls[2]!;
    expect(at).toBe(5);
  });

  it('updateProject is a no-op while idle', async () => {
    engine.updateProject(makeProject());
    expect(h.transport.schedule).not.toHaveBeenCalled();
    expect(h.transport.cancel).not.toHaveBeenCalled();
  });

  it('live seek releases still-ringing voices before re-attacking (no doubled attacks)', async () => {
    const project = makeProject({
      notes: [
        { track: 'melody', startTick: 300, durationTicks: 200, midi: 69, velocity: 102, sourceEventId: 'm1' },
      ],
    });
    await engine.play(project, 350);
    h.transport.state = 'started';

    engine.seek(320);

    expect(h.instruments.melody.triggerRelease).toHaveBeenCalled();
    expect(h.instruments.harmony.releaseAll).toHaveBeenCalled();
  });

  it('idle suspend waits for the longest sustaining voice after pause', async () => {
    vi.useFakeTimers();
    try {
      // A 4-second chord (400 ticks @100 ticks/sec).
      const project = makeProject({
        notes: [
          { track: 'harmony', startTick: 0, durationTicks: 400, midi: 48, velocity: 64, sourceEventId: 'c1' },
        ],
      });
      await engine.play(project, 0);
      h.transport.state = 'started';
      h.transport.seconds = 1.1; // paused 1.1s into a 4s sustain
      engine.pause();

      // The plain 600ms grace would chop the remaining ~2.9s of sustain.
      vi.advanceTimersByTime(600);
      expect(h.context.rawContext.suspend).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2300); // past the 2.9s voice-aware delay
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry after a post-init error resets the status to idle', async () => {
    await engine.play(makeProject(), 0); // init succeeds
    store.setStatus('error', 'Не удалось запустить воспроизведение');

    await engine.initialize();

    expect(store.getSnapshot().status).toBe('idle');
  });

  it('pump survives a throwing subscriber and keeps scheduling frames', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const project = makeProject({ lengthTicks: 100_000 });
      await engine.play(project, 0);
      h.transport.state = 'started';

      const boom = (): void => {
        throw new Error('listener boom');
      };
      const unsubscribe = store.subscribe(boom);

      h.transport.seconds = 1;
      await vi.advanceTimersByTimeAsync(20);
      // The listener throw did not kill the pump: later frames still publish.
      expect(store.getSnapshot().currentTick).toBe(100);
      h.transport.seconds = 2;
      await vi.advanceTimersByTimeAsync(20);
      expect(store.getSnapshot().currentTick).toBe(200);
      // Logged once, not per frame.
      expect(errorSpy).toHaveBeenCalledTimes(1);

      unsubscribe();
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
