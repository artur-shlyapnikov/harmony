/**
 * AudioEngine — playback lifecycle (§3.17) with operationId race guard (§3.21).
 *
 * All Tone.js work happens on the main thread; Tone objects never enter Redux.
 * The engine schedules every PlaybackProject note on Tone.Transport using
 * absolute transport times (ticks converted via ppq/bpm), so live seek is just
 * moving Transport.seconds and Stop preserves the playhead (§3.16: next Play
 * resumes from the preserved position).
 *
 * Editing and MIDI export never touch this class.
 */


import type * as Tone from 'tone';

/**
 * Tone.js is loaded on first initialize() (§3.17): a dynamic import keeps the
 * audio stack out of every module graph that merely builds the store or renders
 * the shell. The promise is cached so repeated init cycles reuse one load.
 */
type ToneModule = typeof Tone;

let tonePromise: Promise<ToneModule> | null = null;

function loadTone(): Promise<ToneModule> {
  tonePromise ??= import('tone').catch((error: unknown) => {
    // A rejected dynamic import must never stay cached: otherwise every later
    // Retry replays the same rejection instead of re-importing (§3.17).
    tonePromise = null;
    throw error;
  });
  return tonePromise;
}

/**
 * Best-effort idle warm-up of the Tone.js chunk (§3.17 keeps it out of the
 * initial graph). Import only — no AudioContext is created until
 * initialize(); running this at app-shell idle (boot, project list on
 * screen) moves the parse+evaluate cost off both the first project open and
 * the first Играть press. A failure here is swallowed by design:
 * loadTone() has already reset the cache, so the first initialize() simply
 * pays the cost instead (today's behavior).
 */
export function preloadToneModule(): void {
  void loadTone().catch(() => {});
}

import type { Tick } from '@domain/model/project';
import type { PlaybackNote, PlaybackProject } from '@domain/model/playback';

import { AudioInitError, AudioPlaybackError } from './audioErrors';
import { createInstruments, type Instruments } from './instruments';
import { getTransportStore, type TransportStore } from './TransportStore';

/** Ticks → seconds for a given resolution and tempo. */
export function ticksToSeconds(tick: number, ppq: number, bpm: number): number {
  return (tick / ppq) * (60 / bpm);
}

/** Seconds → ticks, rounded to whole ticks. */
export function secondsToTicks(seconds: number, ppq: number, bpm: number): Tick {
  return Math.round((seconds * bpm * ppq) / 60);
}

/** Equal-tempered MIDI note number → frequency in Hz. */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const MIN_VELOCITY = 0.05;
const MAX_VELOCITY = 1;
const DEFAULT_BPM = 120;

/**
 * Tail-decay grace before the idle suspend: the longest instrument release is
 * 0.4 s (harmony envelope), so after 0.6 s of stopped/paused transport every
 * voice has decayed and the AudioContext can be suspended. A running context
 * keeps the renderer's audio thread and the audio service alive forever —
 * measurable constant CPU burn after the first Play for zero benefit.
 */
const IDLE_SUSPEND_GRACE_MS = 600;

function clampVelocity(velocity: number): number {
  if (!Number.isFinite(velocity)) return MIN_VELOCITY;
  return Math.min(MAX_VELOCITY, Math.max(MIN_VELOCITY, velocity));
}

export class AudioEngine {
  private readonly store: TransportStore;
  private instruments: Instruments | null = null;
  /** Loaded Tone module; null until the first initialize() completes. */
  private tone: ToneModule | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** Pending idle suspend (see IDLE_SUSPEND_GRACE_MS); cancelled by play(). */
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  /** §3.21: every async operation captures the id; stale completions are ignored. */
  private operationId = 0;
  /** Preserved playhead (§3.16): survives pause/stop; next play resumes here. */
  private storedTick: Tick = 0;
  /** seek() sets this; the next play() starts from it. */
  private pendingSeekTick: Tick | null = null;
  private activePpq = 960;
  private activeBpm = DEFAULT_BPM;
  /** Last-played project: a live seek() must re-run clip-and-schedule from it. */
  private activeProject: PlaybackProject | null = null;
  /**
   * Latest scheduled voice end as a transport-time offset (seconds), tracked
   * so the idle suspend waits out still-sustaining voices instead of chopping
   * them at IDLE_SUSPEND_GRACE_MS.
   */
  private latestVoiceEndSeconds = 0;

  constructor(store: TransportStore = getTransportStore()) {
    this.store = store;
  }

  /**
   * Unlocks the AudioContext (Tone.start). Idempotent and lazy — called on
   * first user gesture. Rejects with AudioInitError; transport lands in
   * 'error' so the UI can offer Retry Audio.
   */
  async initialize(): Promise<void> {
    // §3.21: only a genuinely fresh init cycle may invalidate in-flight
    // operations. Joining an existing cycle — or init that already succeeded —
    // must not stale a concurrent play() awaiting the same initPromise.
    const id =
      this.initialized || this.initPromise !== null ? this.operationId : ++this.operationId;
    try {
      await this.ensureInitialized();
    } catch (error) {
      if (id !== this.operationId) return;
      const message =
        error instanceof AudioInitError ? error.message : 'Аудиодвижок недоступен';
      this.store.setStatus('error', message);
      throw error;
    }
    if (id !== this.operationId) return;
    // Standalone initialize (Retry Audio): leave 'starting' when nothing plays.
    if (this.store.getSnapshot().status === 'starting') {
      this.store.setStatus('idle');
      // Standalone Retry with nothing to play: arm the idle suspend so a
      // retried-but-unused context does not run unattended.
      this.armIdleSuspend();
    } else if (this.store.getSnapshot().status === 'error') {
      // Post-init failure (e.g. play() errored after a successful boot) also
      // lands here on Retry: init succeeded, so the banner must clear.
      this.store.setStatus('idle');
    }
  }

  async play(project: PlaybackProject, fromTick: Tick): Promise<void> {
    const id = ++this.operationId;
    this.cancelIdleSuspend();
    try {
      await this.ensureInitialized();
      // Stale completion: a newer op (e.g. quick Play→Stop) superseded us.
      if (id !== this.operationId) return;
      const startTick = this.pendingSeekTick ?? fromTick;
      this.pendingSeekTick = null;
      this.startScheduledPlayback(project, startTick);
    } catch (error) {
      if (id !== this.operationId) return;
      const message =
        error instanceof AudioInitError || error instanceof AudioPlaybackError
          ? error.message
          : 'Не удалось запустить воспроизведение';
      this.store.stopPump();
      this.store.setTick(this.storedTick);
      this.store.setStatus('error', message);
    }
  }

  pause(): void {
    const status = this.store.getSnapshot().status;
    if (status === 'starting') {
      // A start is still initializing: invalidate it so its completion neither
      // schedules nor overwrites status; playback never begins (§3.21).
      this.operationId += 1;
      this.store.setStatus('idle');
      return;
    }
    const tone = this.tone;
    if (tone === null || status !== 'playing') return;
    tone.getTransport().pause();
    this.storedTick = this.readLiveTick();
    this.store.stopPump();
    this.store.setTick(this.storedTick);
    this.store.setStatus('paused');
    this.armIdleSuspend(this.suspendDelayMs(this.tone?.getTransport()?.seconds ?? 0));
  }

  stop(): void {
    // Invalidate any in-flight initialize/play: their completions must be ignored.
    this.operationId += 1;
    this.storedTick = this.readLiveTick();
    const transport = this.tone?.getTransport();
    // Voices already triggered keep ringing across stop(); wait them out too.
    // The remaining sustain is measured BEFORE the transport time resets to 0.
    let suspendDelay = IDLE_SUSPEND_GRACE_MS;
    if (transport !== undefined) {
      suspendDelay = this.suspendDelayMs(transport.seconds);
      this.cancelScheduledEvents();
      transport.stop();
      transport.seconds = 0;
    }
    this.store.stopPump();
    this.store.setTick(this.storedTick);
    this.store.setStatus('idle');
    this.armIdleSuspend(suspendDelay);
  }

  /**
   * Project switch (REPLACED_FROM_LOAD): fully reset the transport context.
   * Unlike stop() — which preserves the stored tick so Play resumes where the
   * user edited — a loaded document starts a NEW session: any live or paused
   * transport halts AND the playhead clears, so the first Play starts at 0.
   */
  resetForNewDocument(): void {
    // Invalidate any in-flight initialize/play from the previous document:
    // their completions must not schedule into the new session.
    this.operationId += 1;
    const transport = this.tone?.getTransport();
    if (transport !== undefined) {
      this.cancelScheduledEvents();
      transport.stop();
      transport.seconds = 0;
    }
    this.store.stopPump();
    this.activeProject = null;
    this.storedTick = 0;
    this.pendingSeekTick = null;
    this.store.setTick(0);
    this.store.setStatus('idle');
    this.armIdleSuspend();
  }

  /**
   * Moves the playhead. Sets the pending start used by the next play(); while
   * the transport is live it also moves the live position AND re-runs the
   * clip-and-schedule pass from the target tick: resume-clipped straddlers are
   * not absolute-valid, so after any seek they must be re-derived (a backward
   * seek would otherwise replay the stale clip, a forward one skips sustain).
   */
  seek(tick: Tick): void {
    const target = Math.max(0, tick);
    this.pendingSeekTick = target;
    this.storedTick = target;
    const transport = this.tone?.getTransport();
    const live =
      transport !== undefined && (transport.state === 'started' || transport.state === 'paused');
    if (transport !== undefined && live) {
      // A live seek applies NOW; the pending value is consumed here. Leaving
      // it set made the next play() resume from the stale seek target instead
      // of the pause position (Space → ruler-jump → Space replayed the gap).
      this.pendingSeekTick = null;
      const wasPaused = transport.state === 'paused';
      if (this.activeProject !== null && this.instruments !== null) {
        this.scheduleAllNotes(this.activeProject, this.instruments, target);
        transport.seconds = ticksToSeconds(target, this.activePpq, this.activeBpm);
        if (!wasPaused && transport.state !== 'started') transport.start();
      } else {
        transport.seconds = ticksToSeconds(target, this.activePpq, this.activeBpm);
      }
    }
    this.store.setTick(target);
  }

  getCurrentTick(): Tick {
    const status = this.store.getSnapshot().status;
    if (status === 'playing' || status === 'paused') return this.readLiveTick();
    return this.storedTick;
  }

  /**
   * Hot-swaps the scheduled playback to a freshly rendered project while the
   * transport is playing: the clip-and-schedule pass re-runs from the live
   * playhead, so deleting a not-yet-played note silences it immediately and
   * notes added behind the playhead never double-fire. Idle/paused/starting
   * transports are no-ops — their next play() renders fresh anyway.
   */
  updateProject(project: PlaybackProject): void {
    if (this.store.getSnapshot().status !== 'playing') return;
    if (this.activeProject === null || this.instruments === null) return;
    this.scheduleAllNotes(project, this.instruments, this.readLiveTick());
  }

  /**
   * Arms the idle suspend: once the transport has been stopped/paused for
   * `delayMs` (default IDLE_SUSPEND_GRACE_MS; callers pass at least the
   * remaining sustain of already-triggered voices), the AudioContext is
   * suspended. A running context keeps the renderer's audio thread and the
   * audio service alive forever — constant CPU burn after the first Play for
   * zero benefit. play() cancels the timer and resumes the context.
   */
  private armIdleSuspend(delayMs: number = IDLE_SUSPEND_GRACE_MS): void {
    this.cancelIdleSuspend();
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      const status = this.store.getSnapshot().status;
      if (status !== 'idle' && status !== 'paused') return;
      // Tone's Context wrapper exposes no suspend(); the raw real-time
      // context does (the engine never owns an OfflineAudioContext).
      const raw = this.tone?.getContext().rawContext;
      if (raw !== undefined) void (raw as AudioContext).suspend().catch(() => {});
    }, delayMs);
  }

  /**
   * Suspend delay: the idle grace, extended to cover the longest voice still
   * sustaining past `elapsedSeconds` of transport time (triggerAttackRelease
   * voices survive pause()/stop() until their duration elapses).
   */
  private suspendDelayMs(elapsedSeconds: number): number {
    const remainingVoiceMs = Math.max(0, (this.latestVoiceEndSeconds - elapsedSeconds) * 1000);
    return Math.max(IDLE_SUSPEND_GRACE_MS, remainingVoiceMs);
  }

  private cancelIdleSuspend(): void {
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  /** Tone module accessor for playback paths — only reachable after initialize(). */
  private requireTone(): ToneModule {
    const tone = this.tone;
    if (tone === null) throw new AudioPlaybackError('Аудиодвижок не инициализирован');
    return tone;
  }

  dispose(): void {
    this.cancelIdleSuspend();
    this.operationId += 1;
    const transport = this.tone?.getTransport();
    if (transport !== undefined) {
      this.cancelScheduledEvents();
      transport.stop();
      transport.cancel(0);
    }
    this.store.stopPump();
    this.instruments?.dispose();
    this.instruments = null;
    this.initialized = false;
    this.initPromise = null;
    this.pendingSeekTick = null;
    this.activeProject = null;
    this.storedTick = 0;
    this.store.setStatus('idle');
    // Instruments are disposed: nothing can be ringing, suspend immediately.
    const raw = this.tone?.getContext().rawContext;
    if (raw !== undefined) void (raw as AudioContext).suspend().catch(() => {});
  }

  // ---------------------------------------------------------------------

  private ensureInitialized(): Promise<void> {
    if (this.initialized) {
      // A previous stop()/pause() suspended the context (idle power save).
      const context = this.tone?.getContext();
      if (context !== undefined && context.state === 'suspended') {
        return context.resume().then(() => {});
      }
      return Promise.resolve();
    }
    this.store.setStatus('starting');
    this.initPromise ??= loadTone()
      .then(async (tone) => {
        await tone.start();
        this.tone = tone;
        this.instruments = await createInstruments();
        this.initialized = true;
      })
      .catch((cause: unknown) => {
        // Allow a later Retry to attempt initialization again.
        this.initPromise = null;
        throw new AudioInitError('Аудиодвижок недоступен', { cause });
      });
    return this.initPromise.then(() => {
      if (!this.initialized) {
        throw new AudioInitError('Аудиодвижок недоступен');
      }
    });
  }

  private startScheduledPlayback(project: PlaybackProject, fromTick: Tick): void {
    const instruments = this.instruments;
    if (instruments === null) {
      throw new AudioPlaybackError('Аудиодвижок не инициализирован');
    }
    const transport = this.requireTone().getTransport();

    // §3.17: starting at or past the project end would enter 'playing' only
    // to trip the auto-stop guard on the next frame (one-frame flash +
    // spurious start/stop cycle). Natural completion rests the playhead at
    // the end (stop() preserves the final tick), so a play request here is a
    // restart: begin from the top. Settling into a dead idle would leave
    // Space unable to start sound again without a manual seek.
    if (project.lengthTicks > 0 && fromTick >= project.lengthTicks) {
      fromTick = 0;
      this.storedTick = 0;
      this.store.setTick(0);
    }

    this.scheduleAllNotes(project, instruments, fromTick);

    transport.seconds = ticksToSeconds(fromTick, this.activePpq, this.activeBpm);
    if (transport.state !== 'started') transport.start();

    this.storedTick = fromTick;
    this.store.setStatus('playing');
    // §3.16/§3.17: once the playhead passes the rendered project length,
    // playback ends via the regular stop path (which preserves storedTick).
    // The guard makes it fire a single time even if a frame lands past the end.
    const lengthTicks = project.lengthTicks;
    this.store.startPump(() => {
      const tick = this.readLiveTick();
      if (lengthTicks > 0 && tick >= lengthTicks && this.store.getSnapshot().status === 'playing') {
        this.stop();
        return this.storedTick;
      }
      return tick;
    });
  }

  /**
   * Cancels any scheduled events, releases already-triggered (still ringing)
   * voices and runs the §3.17 clip-and-schedule pass from `fromTick`: notes
   * entirely before it are skipped, a straddling note is clipped (attack moved
   * to `fromTick`, duration reduced), everything else stays absolute. Shared
   * by play() and the live seek()/updateProject() paths — without releaseAll a
   * live re-schedule re-attacks voices that are still sounding (phasing).
   */
  private scheduleAllNotes(project: PlaybackProject, instruments: Instruments, fromTick: Tick): void {
    const transport = this.requireTone().getTransport();
    this.cancelScheduledEvents();
    // Tail cut on a mid-playback reschedule is accepted: doubled attacks are
    // worse than a clipped release.
    instruments.melody.triggerRelease();
    instruments.harmony.releaseAll();
    this.latestVoiceEndSeconds = 0;

    this.activePpq = project.ppq > 0 ? project.ppq : this.activePpq;
    this.activeBpm = project.bpm > 0 ? project.bpm : this.activeBpm;
    transport.bpm.value = this.activeBpm;
    this.activeProject = project;

    for (const note of project.notes) {
      if (note.durationTicks <= 0) continue;
      if (note.startTick + note.durationTicks <= fromTick) continue;
      // §3.17: a note straddling the resume tick must be clipped to it —
      // Tone's Clock only fires timeline events at ticks >= the transport
      // start offset, so scheduling at the original startTick would silence
      // it entirely (no attack, no tail). Non-straddlers stay absolute.
      if (note.startTick < fromTick) {
        const clipped: PlaybackNote = {
          ...note,
          durationTicks: note.startTick + note.durationTicks - fromTick,
        };
        this.scheduleNote(instruments, clipped, fromTick);
      } else {
        this.scheduleNote(instruments, note);
      }
    }
  }
  /**
   * Schedules a note at its absolute transport time. `resumeFromTick` clips a
   * straddling note (§3.17): the attack moves to the transport start offset
   * and `note.durationTicks` is expected to be pre-reduced by the caller.
   */
  private scheduleNote(instruments: Instruments, note: PlaybackNote, resumeFromTick?: Tick): void {
    const target = note.track === 'melody' ? instruments.melody : instruments.harmony;
    const atSeconds =
      resumeFromTick === undefined
        ? ticksToSeconds(note.startTick, this.activePpq, this.activeBpm)
        : ticksToSeconds(resumeFromTick, this.activePpq, this.activeBpm);
    const durationSeconds = ticksToSeconds(note.durationTicks, this.activePpq, this.activeBpm);
    const frequency = midiToFrequency(note.midi);
    // PlaybackNote.velocity is a MIDI byte (1..127); Tone expects 0..1.
    const velocity = clampVelocity(note.velocity / 127);
    const endSeconds = atSeconds + durationSeconds;
    if (endSeconds > this.latestVoiceEndSeconds) this.latestVoiceEndSeconds = endSeconds;
    this.requireTone().getTransport().schedule((time: number) => {
      target.triggerAttackRelease(frequency, durationSeconds, time, velocity);
    }, atSeconds);
  }

  private cancelScheduledEvents(): void {
    // transport.cancel(0) clears every scheduled event at once.
    this.requireTone().getTransport().cancel(0);
  }

  private readLiveTick(): Tick {
    const transport = this.tone?.getTransport();
    if (transport === undefined || (transport.state !== 'started' && transport.state !== 'paused')) {
      return this.storedTick;
    }
    return Math.max(
      0,
      secondsToTicks(transport.seconds, this.activePpq, this.activeBpm),
    );
  }
}

let singleton: AudioEngine | null = null;

/** Lazily-created shared instance used by app dependencies (§3.17 singleton). */
export function getAudioEngine(): AudioEngine {
  singleton ??= new AudioEngine();
  return singleton;
}
