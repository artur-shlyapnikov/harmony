/**
 * Autosave write-order serialization (§3.16/§3.18): repository.save() runs are
 * chained through a promise tail so a slow older save can never complete after
 * a faster newer one and leave the older payload on disk. Also pins preserved
 * semantics: cancel() aborts only the pending timer, flush() re-runs every
 * not-yet-stored attempt (debounce-pending or parked) INLINE under a shared
 * write gate that buffers concurrent debounced saves (§3.22), and a
 * validation failure never reaches storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectDocument,
  type ProjectDocumentV1,
} from '../../src/domain/model/project';
import { createAutosave, createSerialQueue } from '../../src/persistence/autosave';
import type { ProjectRepository } from '../../src/persistence/ProjectRepository';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function makeDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Repository whose save() calls park until each test resolves them in order. */
function makeGatedRepository(): ProjectRepository & {
  saves: ProjectDocumentV1[];
  deferreds: Deferred[];
} {
  const saves: ProjectDocumentV1[] = [];
  const deferreds: Deferred[] = [];
  return {
    saves,
    deferreds,
    list: vi.fn(async () => []),
    load: vi.fn(async () => {
      throw new Error('not found');
    }),
    save: vi.fn((project: ProjectDocumentV1) => {
      saves.push(project);
      const d = makeDeferred();
      deferreds.push(d);
      return d.promise;
    }),
    delete: vi.fn(async () => {}),
    duplicate: vi.fn(async () => {
      throw new Error('not found');
    }),
  };
}

function doc(title: string): ProjectDocumentV1 {
  return createProjectDocument({
    title,
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });
}

describe('createAutosave write-order race (§3.16/§3.18)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes concurrent runs so the newest document wins on disk', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    // Doc A (generation 1) reaches its debounced timer and parks mid-save.
    autosave.schedule(doc('A'));
    expect(autosave.generation()).toBe(1);
    await vi.advanceTimersByTimeAsync(750);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.saves[0]?.title).toBe('A');

    // While A is still in flight, doc B (generation 2) is scheduled and its
    // debounce fires: the debounce path is FIFO (§3.16/§3.18), so B waits.
    autosave.schedule(doc('B'));
    await vi.advanceTimersByTimeAsync(750);
    expect(repository.save).toHaveBeenCalledTimes(1);

    repository.deferreds[0]!.resolve(); // A's slow save settles first in wall time
    await vi.advanceTimersByTimeAsync(0);

    // B reaches storage only after A, so the newest payload commits last.
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.saves.map((p) => p.title)).toEqual(['A', 'B']);
    repository.deferreds[1]!.resolve();
  });

  it('cancel() aborts only the pending timer, not an already-issued run', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    autosave.schedule(doc('A'));
    await vi.advanceTimersByTimeAsync(750);
    expect(repository.saves.map((p) => p.title)).toEqual(['A']);

    // B is issued by flush() (§3.22 unload durability); cancel() must not
    // drop either the parked A run or the flushed B run.
    autosave.schedule(doc('B'));
    const flushPromise = autosave.flush();
    autosave.cancel();

    repository.deferreds[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0); // promoted B issues once the gate frees
    repository.deferreds[1]!.resolve();
    await flushPromise;

    expect(repository.saves.map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('flush() with no pending document resolves true without touching storage', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    await expect(autosave.flush()).resolves.toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('a validation failure never hands the document to storage and flush() reports false', async () => {
    const repository = makeGatedRepository();
    const onStatus = vi.fn();
    // §3.16 «validate project»: an invalid document must never reach storage.
    const invalid = { ...doc('сломанный'), title: null } as unknown as ProjectDocumentV1;

    const autosave = createAutosave(repository, { delayMs: 750, onStatus });

    autosave.schedule(invalid);
    await expect(autosave.flush()).resolves.toBe(false);

    expect(repository.save).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(
      'error',
      1,
      expect.stringContaining('не был сохранён'),
    );
  });

  it('flush() promotes the pending run under the write gate even while another save is in flight (§3.22)', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    // A parks mid-save.
    autosave.schedule(doc('A'));
    await vi.advanceTimersByTimeAsync(750);
    expect(repository.save).toHaveBeenCalledTimes(1);

    // Unload durability (§3.22): B must not stay debounce-pending through an
    // unload — flush() promotes it and runs it under the SAME write gate as
    // the parked A save, so it issues right after A settles instead of
    // racing it. IndexedDB serializes overlapping readwrite transactions in
    // issue order, so B still commits last on the real backend (§3.18); an
    // UNGATED inline put could let a mid-flush debounced save slip before it.
    autosave.schedule(doc('B'));
    const flushPromise = autosave.flush();
    expect(repository.saves.map((p) => p.title)).toEqual(['A']);

    repository.deferreds[0]!.resolve(); // A settles first...
    await vi.advanceTimersByTimeAsync(0); // ...then promoted B issues
    repository.deferreds[1]!.resolve(); // ...and B settles
    await flushPromise;

    // B was issued last, so it is also stored last.
    expect(repository.saves.map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('flush() promotes a queued run parked behind an in-flight save (§3.22)', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    // A's debounce fires and parks mid-save; B's debounce fires while A is
    // still in flight, so B's run sits in the FIFO and pending === null.
    autosave.schedule(doc('A'));
    await vi.advanceTimersByTimeAsync(750);
    autosave.schedule(doc('B'));
    await vi.advanceTimersByTimeAsync(750);
    expect(repository.save).toHaveBeenCalledTimes(1); // B parked behind A
    // flush() must promote the queued B instead of returning a no-op —
    // otherwise an unload at this point loses B's generation entirely. The
    // promoted attempt buffers on the shared write gate and issues once A settles.
    const flushPromise = autosave.flush();

    repository.deferreds[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0); // promoted B issues once the gate frees
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.saves[1]?.title).toBe('B');

    repository.deferreds[1]!.resolve();
    await flushPromise;

    // The promoted generation is never saved twice by its queue task.
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.saves.map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('flush() promotes every un-taken attempt so an older queued save never lands last', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    // gen1 starts and parks mid-save.
    autosave.schedule(doc('A1'));
    await vi.advanceTimersByTimeAsync(750);
    // gen2's debounce fires while gen1 is in flight: gen2 queues behind it.
    autosave.schedule(doc('B2'));
    await vi.advanceTimersByTimeAsync(750);
    expect(repository.save).toHaveBeenCalledTimes(1);
    // gen3 is scheduled but its debounce has not fired yet.
    autosave.schedule(doc('C3'));

    // flush() must promote BOTH un-taken attempts (queued gen2 AND pending
    // gen3) and runs them as ONE gate-holding session in generation order,
    // so each issues only after its predecessor settles — gen2 can never issue
    // after gen3 and commit last.
    const flushed = autosave.flush();

    repository.deferreds[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0); // gen2 issues once the gate frees
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.saves[1]?.title).toBe('B2');

    repository.deferreds[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0); // gen3 issues once the gate frees
    expect(repository.save).toHaveBeenCalledTimes(3);
    expect(repository.saves[2]?.title).toBe('C3');

    repository.deferreds[2]!.resolve();
    await flushed;
    expect(repository.saves.map((p) => p.title)).toEqual(['A1', 'B2', 'C3']);
  });

  it('a queued task that throws synchronously resolves without wedging the drain or rejecting unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const queue = createSerialQueue();

      // Synchronous throw: the push promise must still settle (a rejected
      // wrapper would hang every later caller and surface as an unhandled
      // rejection from the fire-and-forget drain).
      await expect(
        queue.push(() => {
          throw new Error('sync boom');
        }),
      ).resolves.toBeUndefined();

      // The drain survives and keeps serving later tasks in order.
      const ran: number[] = [];
      await queue.push(async () => {
        ran.push(1);
      });
      await queue.push(async () => {
        throw new Error('async boom');
      });
      await queue.push(async () => {
        ran.push(2);
      });
      expect(ran).toEqual([1, 2]);

      // Let any stray rejection reach the process handler before asserting.
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('flush() reports false when the promoted save is rejected by the repository', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    autosave.schedule(doc('A'));
    const flushed = autosave.flush();
    // Storage idle: the promoted save starts SYNCHRONOUSLY inside flush()
    // (§3.22 — unload can kill pending JS before a continuation runs).
    expect(repository.save).toHaveBeenCalledTimes(1);

    repository.deferreds[0]!.reject(new Error('quota exceeded'));
    await expect(flushed).resolves.toBe(false);
  });

  it('flush() reports true when every promoted attempt reaches storage', async () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    // A parks mid-save; B is pending when flush() promotes it.
    autosave.schedule(doc('A'));
    await vi.advanceTimersByTimeAsync(750);
    autosave.schedule(doc('B'));
    const flushed = autosave.flush();

    repository.deferreds[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0); // promoted B issues once the gate frees
    expect(repository.save).toHaveBeenCalledTimes(2);
    repository.deferreds[1]!.resolve();
    await expect(flushed).resolves.toBe(true);
    expect(repository.saves.map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('flush() kicks the promoted save synchronously when storage is idle (§3.22 unload durability)', () => {
    const repository = makeGatedRepository();
    const autosave = createAutosave(repository, { delayMs: 750 });

    // The edit is still debounce-pending when the unload flush fires. With
    // no run in flight, repository.save must be ISSUED by the flush() call
    // itself — no timers advanced, no awaits: pending JS may die at any
    // moment during visibilitychange/pagehide/beforeunload.
    autosave.schedule(doc('срочный'));
    const flushed = autosave.flush();
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.saves[0]?.title).toBe('срочный');

    repository.deferreds[0]!.resolve();
    return expect(flushed).resolves.toBe(true);
  });
});
