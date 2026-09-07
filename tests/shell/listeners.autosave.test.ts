// @vitest-environment jsdom
/**
 * Autosave + stop-on-edit listeners (§3.16/§3.18): an accepted document
 * mutation flips saveStatus to dirty and schedules the debounced save through
 * the persistence façade; façade status events map onto saveStatus saving→saved
 * (or error + persistenceError). Loading must NOT mark dirty. Editing while
 * the transport plays hot-swaps playback via ProjectTransport.updateProject;
 * only an in-flight «starting» start is stopped.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { makeStore } from '../../src/app/store';
import {
  setDependenciesForTesting,
  type AppDependencies,
} from '../../src/app/dependencies';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import type { AudioEngine } from '../../src/audio/AudioEngine';
import { ProjectTransport } from '../../src/audio/projectTransport';
import { getTransportStore } from '../../src/audio/TransportStore';
import type { PlaybackProject } from '../../src/domain/model/playback';
import { createProjectDocument, type ProjectDocumentV1 } from '../../src/domain/model/project';
import type { ProjectRepository } from '../../src/persistence/ProjectRepository';
import { changeBpmCmd } from '../../src/state/commands';
import { REPLACED_FROM_LOAD } from '../../src/state/projectDocumentSlice';
import { registerAutosaveFlushTriggers } from '../../src/app/listeners';
import type { AppDispatch, RootState } from '../../src/app/store';

type FakeDeps = AppDependencies & {
  /** The BASE repository the real façade saves through — assertions observe it. */
  repository: ProjectRepository & { save: Mock<(project: ProjectDocumentV1) => Promise<void>> };
  /** The stubbed engine underneath the real ProjectTransport façade. */
  engine: AudioEngine & {
    stop: Mock<() => void>;
    updateProject: Mock<(project: PlaybackProject) => void>;
  };
};

/** Minimal store surface the tests exercise (avoids ReturnType coupling). */
type TestStore = {
  getState(): RootState;
  dispatch(action: { type: string; payload?: unknown }): unknown;
  subscribe(listener: () => void): () => void;
};

function makeFakeDeps(saveImpl: () => Promise<void> = async () => {}): FakeDeps {
  const repository = {
    list: vi.fn(async () => []),
    load: vi.fn(async () => {
      throw new Error('not found');
    }),
    save: vi.fn(saveImpl),
    delete: vi.fn(async () => {}),
    duplicate: vi.fn(async () => {
      throw new Error('not found');
    }),
  };
  // Real production façade over the recording base repository: every fence
  // and status rule under test is live code.
  const projects = createProjectPersistence({ repository, delayMs: 750 });
  const engine = {
    initialize: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    stop: vi.fn(),
    resetForNewDocument: vi.fn(),
    updateProject: vi.fn(),
    seek: vi.fn(),
    getCurrentTick: () => 0,
    dispose: vi.fn(),
  };
  // Real ProjectTransport over the recording engine stub: the reset guard
  // (clean idle sessions never touch the engine) is live code under test,
  // and snapshot reads hit the shared TransportStore singleton.
  const transport = new ProjectTransport(engine as unknown as AudioEngine);
  return { projects, repository, engine, transport } as unknown as FakeDeps;
}

function loadDocument(store: ReturnType<typeof makeStore>): void {
  const document = createProjectDocument({
    title: 'Тест',
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });
  store.dispatch({ type: REPLACED_FROM_LOAD, payload: { project: document } });
}

type SaveGate = { resolve: () => void; reject: (error: unknown) => void };

/** Fake deps whose base repository.save() parks each call until its gate is released. */
function makeGatedDeps(): FakeDeps & { gates: SaveGate[] } {
  const gates: SaveGate[] = [];
  const deps = makeFakeDeps(
    () =>
      new Promise<void>((resolve, reject) => {
        gates.push({ resolve, reject });
      }),
  );
  return Object.assign(deps, { gates });
}

describe('autosave listener', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore the shared TransportStore singleton even if an assertion above
    // threw: a leaked 'playing'/'starting' would stop playback checks in
    // later tests spuriously.
    getTransportStore().setStatus('idle');
    setDependenciesForTesting(null);
  });

  it('goes dirty → saving → saved around the debounced repository.save', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    const statuses: string[] = [];
    store.subscribe(() => statuses.push(store.getState().session.saveStatus));
    loadDocument(store);

    // Loading is not a mutation: no dirty flag, nothing scheduled.
    expect(store.getState().session.saveStatus).toBe('idle');
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.repository.save).not.toHaveBeenCalled();

    changeBpmCmd(100)(store.dispatch as AppDispatch, store.getState);
    expect(store.getState().session.saveStatus).toBe('dirty');

    await vi.advanceTimersByTimeAsync(749);
    expect(deps.repository.save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // debounce fires; save resolves in microtasks
    expect(store.getState().session.saveStatus).toBe('saved');
    // Full lifecycle was observable through the store subscription.
    // Consecutive actions notify twice; collapse to distinct transitions.
    const transitions = statuses.filter((s, i) => i === 0 || statuses[i - 1] !== s);
    expect(transitions).toEqual(['idle', 'dirty', 'saving', 'saved']);

    expect(store.getState().session.persistenceError).toBeUndefined();
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.repository.save).mock.calls[0]?.[0]?.timing.bpm).toBe(100);
  });

  it('maps a failed save to error status + persistenceError, cleared by the next successful save', async () => {
    let failFirst = true;
    const deps = makeFakeDeps(async () => {
      if (failFirst) throw new Error('quota exceeded');
    });
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store);

    changeBpmCmd(90)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);

    expect(store.getState().session.saveStatus).toBe('error');
    expect(store.getState().session.persistenceError).toBe('хранилище переполнено');

    failFirst = false;
    changeBpmCmd(120)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(800);

    expect(store.getState().session.saveStatus).toBe('saved');
    expect(store.getState().session.persistenceError).toBeUndefined();
    expect(deps.repository.save).toHaveBeenCalledTimes(2);
  });

  it('keeps the persistence warning visible while a retry saves, clearing it only on success (§3.18)', async () => {
    const deps = makeGatedDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store);

    // First save fails: the §3.18 persistent warning appears.
    changeBpmCmd(90)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    deps.gates[0]?.reject(new Error('quota exceeded'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session.saveStatus).toBe('error');
    expect(store.getState().session.persistenceError).toBe('хранилище переполнено');

    // Retry starts ('saving'): the warning must NOT flicker off mid-flight —
    // the outcome is not known yet.
    changeBpmCmd(120)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    expect(deps.gates).toHaveLength(2);
    expect(store.getState().session.saveStatus).toBe('saving');
    expect(store.getState().session.persistenceError).toBe('хранилище переполнено');

    // Only the actual success clears it.
    deps.gates[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session.saveStatus).toBe('saved');
    expect(store.getState().session.persistenceError).toBeUndefined();
  });

  it('never drops the persistence warning when a retried save fails again (§3.18)', async () => {
    const deps = makeGatedDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    const snapshots: string[] = [];
    store.subscribe(() => {
      const session = store.getState().session;
      snapshots.push(`${session.saveStatus}:${session.persistenceError ?? '-'}`);
    });
    loadDocument(store);

    changeBpmCmd(90)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    deps.gates[0]?.reject(new Error('quota exceeded'));
    await vi.advanceTimersByTimeAsync(0);

    // The retry also fails: the warning survives every intermediate
    // dirty/saving hop between the two failures.
    changeBpmCmd(120)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    deps.gates[1]?.reject(new Error('quota exceeded'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session.persistenceError).toBe('хранилище переполнено');

    // Collapsed state timeline: no '-' after the first failure.
    const transitions = snapshots.filter((s, i) => i === 0 || snapshots[i - 1] !== s);
    expect(transitions).toEqual([
      'idle:-',
      'dirty:-',
      'saving:-',
      // Transient between the two forwarded dispatches: status flips to
      // error one action before the message lands. The banner keys off
      // persistenceError, which stays put throughout.
      'error:-',
      'error:хранилище переполнено',
      'dirty:хранилище переполнено',
      'saving:хранилище переполнено',
      'error:хранилище переполнено',
    ]);
  });

  it('a stale save attempt emits no status once a newer save is scheduled (§3.16)', async () => {
    const gates: Array<() => void> = [];
    const deps = makeFakeDeps();
    vi.mocked(deps.repository.save).mockImplementation(
      () => new Promise<void>((resolve) => { gates.push(resolve); }),
    );
    setDependenciesForTesting(deps);
    const store = makeStore();
    const statuses: string[] = [];
    store.subscribe(() => statuses.push(store.getState().session.saveStatus));
    loadDocument(store);

    // Attempt 1 starts and hangs inside repository.save.
    changeBpmCmd(100)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    expect(gates).toHaveLength(1);

    // A newer edit schedules attempt 2 while attempt 1 is still in flight.
    changeBpmCmd(120)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    // Autosave runs are serialized (§3.16/§3.18 last-write-wins), so
    // attempt 2 waits for attempt 1 to settle before starting.
    expect(gates).toHaveLength(1);

    // The stale attempt settles first here: per §3.16 it must not emit anything
    // — no 'saved', no 'error', and no spurious 'saving' either.
    gates[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(gates).toHaveLength(2); // attempt 2 started only after attempt 1 settled
    // Collapse consecutive duplicates (unrelated dispatches re-push the same
    // status): exactly one 'saving' per started attempt survives, and the
    // stale attempt adds neither a third 'saving' nor a late terminal state.
    const transitions = statuses.filter((s, i) => i === 0 || statuses[i - 1] !== s);
    expect(transitions.filter((s) => s === 'saving')).toHaveLength(2);
    expect(transitions).not.toContain('error');

    // The newer attempt still completes its lifecycle normally.
    gates[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    const finalTransitions = statuses.filter((s, i) => i === 0 || statuses[i - 1] !== s);
    expect(finalTransitions).toEqual(['idle', 'dirty', 'saving', 'dirty', 'saving', 'saved']);
    expect(store.getState().session.saveStatus).toBe('saved');
    expect(store.getState().session.persistenceError).toBeUndefined();
  });

  it('reschedules live playback on an accepted edit while the transport is playing', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store);

    // Idle transport: editing never touches the engine.
    changeBpmCmd(100)(store.dispatch as AppDispatch, store.getState);
    expect(deps.engine.stop).not.toHaveBeenCalled();
    expect(deps.engine.updateProject).not.toHaveBeenCalled();

    getTransportStore().setStatus('playing');
    changeBpmCmd(110)(store.dispatch as AppDispatch, store.getState);
    // Playback continues: the committed document is hot-swapped into the
    // engine instead of stopping the transport.
    expect(deps.engine.stop).not.toHaveBeenCalled();
    expect(deps.engine.updateProject).toHaveBeenCalledTimes(1);
    // The transport renders the committed document before hot-swapping it
    // into the engine (the engine only ever sees PlaybackProjects).
    const rendered = deps.engine.updateProject.mock.calls[0]![0];
    expect(rendered).not.toBe(store.getState().projectHistory.present);
    expect(rendered.bpm).toBe(110);

    // The same edit still scheduled the autosave.
    await vi.advanceTimersByTimeAsync(750);
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
  });

  it('stops the transport on an accepted edit while audio is starting (RevUI-4)', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store);

    getTransportStore().setStatus('starting');
    changeBpmCmd(110)(store.dispatch as AppDispatch, store.getState);
    // stop() bumps the operationId so the in-flight play becomes a no-op.
    expect(deps.engine.stop).toHaveBeenCalledTimes(1);
  });

  it('stops playback when another project is loaded (REPLACED_FROM_LOAD, §3.17)', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store); // first load with an idle transport: no stop

    getTransportStore().setStatus('playing');
    loadDocument(store);

    expect(deps.engine.resetForNewDocument).toHaveBeenCalledTimes(1);

    // Loading is not an edit of the current document: the session stays
    // clean and nothing is scheduled for save.
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(store.getState().session.saveStatus).toBe('idle');
  });

  it('fully resets the transport context when another project loads while PAUSED (§3.17)', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();

    // Project A: the user pauses at tick X. A later load must clear that
    // playhead too, not only halt a live transport — otherwise project B's
    // first Play resumes from project A's position.
    getTransportStore().setStatus('paused');
    getTransportStore().setTick(480);
    loadDocument(store);

    expect(deps.engine.resetForNewDocument).toHaveBeenCalledTimes(1);
    expect(deps.engine.stop).not.toHaveBeenCalled();
  });

  it('resets the transport context when another project loads while IDLE with a nonzero playhead (§3.17)', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();

    // Project A ended via stop(): the transport is IDLE but the stored
    // tick survives. A later load must still clear that playhead —
    // otherwise project B's first Play resumes from project A's position.
    getTransportStore().setStatus('idle');
    getTransportStore().setTick(480);
    loadDocument(store);

    expect(deps.engine.resetForNewDocument).toHaveBeenCalledTimes(1);
    expect(deps.engine.stop).not.toHaveBeenCalled();

    // Hygiene: the describe afterEach restores STATUS only; drop the
    // stored tick so later cells start from a clean playhead too.
    getTransportStore().setTick(0);
  });

  it('reports an error and skips repository.save when the scheduled document is invalid (§3.16)', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store);

    const base = createProjectDocument({
      title: 'Невалидный',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    const invalid: ProjectDocumentV1 = {
      ...base,
      timing: { ...base.timing, bpm: 500 }, // вне диапазона 40..240
    };
    deps.projects.scheduleSave(invalid);

    await vi.advanceTimersByTimeAsync(750);

    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(store.getState().session.saveStatus).toBe('error');
    expect(store.getState().session.persistenceError).toContain('валидаци');

    // The pending raw document is untouched and a later valid edit recovers.
    changeBpmCmd(100)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(800);
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
    expect(store.getState().session.saveStatus).toBe('saved');
    expect(store.getState().session.persistenceError).toBeUndefined();
  });

  it('a save of the previous project reports nothing after REPLACED_FROM_LOAD (§3.15/§3.18)', async () => {
    const deps = makeGatedDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    const forwarded: string[] = [];
    store.subscribe(() => {
      const session = store.getState().session;
      forwarded.push(`${session.saveStatus}:${session.persistenceError ?? '-'}`);
    });
    loadDocument(store); // project A

    // A's edit arms the debounce; firing it parks A's save mid-flight.
    changeBpmCmd(100)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    expect(deps.gates).toHaveLength(1);

    // Open project B while A's save is still in flight.
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: {
        project: createProjectDocument({
          title: 'Проект B',
          tonic: { letter: 'C', accidental: 0 },
          mode: 'ionian',
        }),
      },
    });
    const snapshotAfterSwitch = `${store.getState().session.saveStatus}:${
      store.getState().session.persistenceError ?? '-'
    }`;
    forwarded.length = 0;

    // A settles with a rejection after the switch: no error status, no
    // storage-error banner over B (§3.18).
    deps.gates[0]!.reject(new Error('quota exceeded'));
    await vi.advanceTimersByTimeAsync(0);
    expect(`${store.getState().session.saveStatus}:${
      store.getState().session.persistenceError ?? '-'
    }`).toBe(snapshotAfterSwitch); // unchanged by A's failure
    expect(forwarded).toEqual([]); // listener saw nothing

    // Same for a successful settle of the stale generation.
    deps.gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(`${store.getState().session.saveStatus}:${
      store.getState().session.persistenceError ?? '-'
    }`).toBe(snapshotAfterSwitch);
    expect(store.getState().session.persistenceError).toBeUndefined();
    expect(forwarded).toEqual([]);

    // The gate is not sticky: B's first accepted edit bumps the generation
    // past the epoch and its lifecycle forwards normally.
    changeBpmCmd(140)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    expect(deps.gates).toHaveLength(2); // B's own save started
    deps.gates[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session.saveStatus).toBe('saved');
    expect(store.getState().session.persistenceError).toBeUndefined();
  });

  it('flushes the previous project\'s pending edit on switch without painting the new session (§3.15/§3.16)', async () => {
    const deps = makeGatedDeps();
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store);

    changeBpmCmd(100)(store.dispatch as AppDispatch, store.getState); // arms the timer
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: {
        project: createProjectDocument({
          title: 'Проект B',
          tonic: { letter: 'C', accidental: 0 },
          mode: 'ionian',
        }),
      },
    });
    // ... while its lifecycle stays below the epoch: nothing reached B's
    // session, not even the synchronous 'saving' emission.
    const snapshotAfterSwitch = `${store.getState().session.saveStatus}:${
      store.getState().session.persistenceError ?? '-'
    }`;

    // Advancing well past the old debounce runs nothing extra: flush()
    // cleared the timer and the promoted attempt is taken.
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
    expect(deps.gates).toHaveLength(1);

    deps.gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(`${store.getState().session.saveStatus}:${
      store.getState().session.persistenceError ?? '-'
    }`).toBe(snapshotAfterSwitch);
    expect(store.getState().session.persistenceError).toBeUndefined();
  });

  it('a failed switch-flush surfaces a persistent persistenceError on the new session (§3.18)', async () => {
    const deps = makeFakeDeps(async () => {
      throw new Error('quota exceeded');
    });
    setDependenciesForTesting(deps);
    const store = makeStore();
    loadDocument(store);

    // A's last edit is armed but not yet saved when the switch happens.
    changeBpmCmd(100)(store.dispatch as AppDispatch, store.getState); // arms the timer
    store.dispatch({
      type: REPLACED_FROM_LOAD,
      payload: {
        project: createProjectDocument({
          title: 'Проект B',
          tonic: { letter: 'C', accidental: 0 },
          mode: 'ionian',
        }),
      },
    });

    // The flushed run's own 'error' stays below the epoch, but flush()'s
    // false outcome must surface explicitly: quota / private-mode IndexedDB
    // failures of the previous project's last edit cannot stay silent.
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session.persistenceError).toBe(
      'Не удалось сохранить изменения предыдущего проекта',
    );
    expect(store.getState().session.saveStatus).toBe('error');
  });

  it('a freshly swapped-in façade forwards statuses without any project switch (per-instance suppression state)', async () => {
    // Each façade owns its stale-status epoch internally, so a brand-new one
    // starts with an empty gate: its very first save lifecycle forwards even
    // though no flushOnProjectSwitch ever ran for it. The subscription wires
    // whatever façade is current at store creation.
    const fresh = makeFakeDeps();
    setDependenciesForTesting(fresh);
    const store = makeStore();
    loadDocument(store);

    changeBpmCmd(140)(store.dispatch as AppDispatch, store.getState);
    await vi.advanceTimersByTimeAsync(750);
    expect(fresh.repository.save).toHaveBeenCalledTimes(1);
    expect(store.getState().session.saveStatus).toBe('saved');
  });
});


describe('autosave flush triggers (§3.22)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setDependenciesForTesting(null);
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  function setVisibility(value: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
  }

  function edit(store: TestStore): void {
    changeBpmCmd(90)(store.dispatch as AppDispatch, store.getState);
  }

  it('flushes the pending debounced save when the page becomes hidden', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const unregister = registerAutosaveFlushTriggers();
    const store = makeStore();
    loadDocument(store);

    // Edit inside the debounce window: nothing saved yet.
    edit(store);
    expect(deps.repository.save).not.toHaveBeenCalled();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session.saveStatus).toBe('saved');

    // The debounce timer is gone: advancing time saves nothing extra.
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.repository.save).toHaveBeenCalledTimes(1);

    // Becoming visible again must not trigger anything.
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(deps.repository.save).toHaveBeenCalledTimes(1);

    // Unregistered triggers stop flushing (no leaked listeners).
    unregister();
    edit(store);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
  });

  it('flushes on pagehide for iOS Safari in-app navigations and process kills', async () => {
    const deps = makeFakeDeps();
    setDependenciesForTesting(deps);
    const unregister = registerAutosaveFlushTriggers();
    const store = makeStore();
    loadDocument(store);

    edit(store);
    expect(deps.repository.save).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session.saveStatus).toBe('saved');

    // Unregistered triggers stop flushing (no leaked listeners).
    unregister();
    edit(store);
    window.dispatchEvent(new Event('pagehide'));
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
  });

  it('flushes on beforeunload as a belt-and-suspenders fallback, never blocking unload', async () => {
    const deps = makeFakeDeps();
    vi.mocked(deps.repository.save).mockImplementation(() => new Promise<void>(() => {})); // hangs
    setDependenciesForTesting(deps);
    const unregister = registerAutosaveFlushTriggers();
    const store = makeStore();
    loadDocument(store);

    edit(store);

    // Fire-and-forget: an in-flight flush neither throws nor blocks the event.
    expect(() => window.dispatchEvent(new Event('beforeunload'))).not.toThrow();
    expect(deps.repository.save).toHaveBeenCalledTimes(1);

    unregister();
    window.dispatchEvent(new Event('beforeunload'));
    expect(deps.repository.save).toHaveBeenCalledTimes(1);
  });
});
