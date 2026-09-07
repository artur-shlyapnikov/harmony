import { type ProjectDocumentV1 } from '@domain/model/project';
import { validateProjectDocument } from '@domain/validation/projectSchema';
import { type ProjectRepository } from './ProjectRepository';

export type SaveStatusListener = (
  status: 'saving' | 'saved' | 'error',
  generation: number,
  errorMessage?: string,
) => void;

export type Autosave = {
  /** Debounces the given document; every call bumps the save generation. */
  schedule(project: ProjectDocumentV1): void;
  /** Aborts any pending debounced save. */
  cancel(): void;
  /**
   * Saves every accepted edit that has not reached storage yet (e.g. on
   * pagehide or a project switch), issuing un-taken attempts sequentially in
   * generation order. Resolves true iff every promoted attempt reached
   * storage successfully (also true when there was nothing to do); false
   * when the latest generation failed (validation or storage error).
   */
  flush(): Promise<boolean>;
  /**
   * §3.18 deletion fencing: drops every not-yet-started attempt (the
   * debounce-pending document AND a run parked in the FIFO) for the given
   * project id without running it, so a late autosave cannot resurrect a
   * deleted project. Attempts for other ids stay live; a run whose
   * repository.save() is already in flight cannot be interrupted.
   *
   * Optional on the type because pre-existing test stubs predate it;
   * createAutosave always provides it.
   */
  discardFor?(projectId: string): void;
  generation(): number;
};

const DEFAULT_DELAY_MS = 750;

type PendingSave = {
  project: ProjectDocumentV1;
  generation: number;
  /** Set when flush() promotes this attempt; its queue task becomes a no-op. */
  taken?: boolean;
};

/**
 * FIFO promise tail (§3.16/§3.18 last-write-wins): pushed tasks run strictly
 * one after another in push order, and each task's failure (a rejection or a
 * synchronous throw) is absorbed so the drain itself never rejects. Exported
 * for behavioral tests of the drain contract.
 */
export type SerialQueue = { push(task: () => Promise<void>): Promise<void> };

export function createSerialQueue(): SerialQueue {
  const queue: Array<() => Promise<void>> = [];
  let draining = false;

  async function drain(): Promise<void> {
    draining = true;
    try {
      while (queue.length > 0) {
        await queue.shift()!();
      }
    } finally {
      draining = false;
    }
  }

  return {
    push(task: () => Promise<void>): Promise<void> {
      return new Promise<void>((resolve) => {
        queue.push(async () => {
          // §3.16: a task must never reject the drain — a rejecting drain
          // would skip this resolve(), leaving every caller of push()
          // hanging, and turn the fire-and-forget drain into an unhandled
          // rejection. `Promise.resolve().then(task)` converts a synchronous
          // throw into a rejection the catch absorbs; a bare
          // `task().catch(...)` would not.
          await Promise.resolve()
            .then(task)
            .catch(() => {});
          resolve();
        });
        if (!draining) void drain();
      });
    },
  };
}

/**
 * Write gate shared by the debounce FIFO and flush() (§3.16/§3.22): exactly
 * one repository.save() run holds it at a time, so a promoted flush attempt
 * can never interleave with a concurrently scheduled debounced save — the
 * interleaving that let a newer put land before an older promoted one and
 * commit the stale payload last on disk. A flush session acquires the gate
 * ONCE for all its attempts, so a debounce timer firing mid-flush is buffered
 * until the whole session completes. The fast path hands the gate over
 * without a microtask hop: flush() checks `free` and starts writing
 * synchronously, because unload can kill pending JS before an awaited
 * continuation ever runs (§3.22).
 */
class WriteGate {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  /** True when the caller may take the gate and start writing immediately. */
  get free(): boolean {
    return !this.held;
  }

  /** Takes the free gate synchronously (only valid when `free`). */
  takeSync(): void {
    this.held = true;
  }

  /** Buffers until the current holder releases, then takes the gate. */
  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Hands the gate to the longest-buffered waiter, or frees it. */
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.held = false;
  }
}

export function createAutosave(
  repository: ProjectRepository,
  opts: { delayMs?: number; onStatus?: SaveStatusListener } = {},
): Autosave {
  /** Numeric timer id from global setTimeout; fits DOM and Node typings via cast below. */
  let timer: number | null = null;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const onStatus = opts.onStatus;

  let latestGeneration = 0;
  let pending: PendingSave | null = null;
  /** Attempt whose debounce timer fired but whose FIFO task has not started. */
  let queued: PendingSave | null = null;

  // §3.16/§3.18 last-write-wins: runs must reach storage in schedule order.
  // A slow older repository.save() completing after a faster newer one would
  // otherwise leave the older payload on disk while status gating hides it,
  // so every debounced run goes through this FIFO queue, drained one at a
  // time. The first run starts synchronously so idle-path timing is
  // unchanged; the queue absorbs task failures so the drain never rejects.
  const queue = createSerialQueue();
  // Every storage run — queued or flush-promoted — holds this shared gate,
  // which keeps flush()'s attempts from interleaving with debounced ones.
  const gate = new WriteGate();

  async function run(attempt: PendingSave): Promise<boolean> {
    // §3.16 «validate project» step: an invalid document is never handed to
    // storage; the pending raw document is left untouched for diagnostics.
    const validated = validateProjectDocument(attempt.project);
    if (!validated.ok) {
      if (attempt.generation === latestGeneration) {
        onStatus?.(
          'error',
          attempt.generation,
          `Проект не прошёл валидацию и не был сохранён: ${validated.error}`,
        );
      }
      // A LATEST-generation failure makes flush() report false; a stale
      // generation's outcome stays unreported (§3.18 status gating).
      return attempt.generation !== latestGeneration;
    }
    if (attempt.generation === latestGeneration) {
      onStatus?.('saving', attempt.generation);
    }
    try {
      await repository.save(attempt.project);
      if (attempt.generation === latestGeneration) {
        onStatus?.('saved', attempt.generation);
      }
      return true;
    } catch (error) {
      if (attempt.generation === latestGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        onStatus?.('error', attempt.generation, message);
      }
      return attempt.generation !== latestGeneration;
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    schedule(project: ProjectDocumentV1): void {
      const generation = ++latestGeneration;
      pending = { project, generation };
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        if (pending !== null && pending.generation === generation) {
          const attempt = pending;
          pending = null;
          // cancel() only aborts the timer; an already-queued run proceeds.
          queued = attempt;
          void queue.push(() => {
            queued = null;
            // flush() may have promoted this attempt already (§3.22):
            // a promoted generation is never saved twice.
            if (attempt.taken) return Promise.resolve();
            // The queue contract is Promise<void>: the run's success flag
            // matters only to flush(). The shared write gate is held for
            // the whole run, so a concurrent flush session can never
            // interleave with this debounced put (§3.16 last-write-wins).
            return gate
              .acquire()
              .then(async () => {
                try {
                  await run(attempt);
                } finally {
                  gate.release();
                }
              })
              .then(() => {});
          });
        }
      }, delayMs) as unknown as number;
    },

    cancel(): void {
      clearTimer();
      pending = null;
    },

    discardFor(projectId: string): void {
      // §3.18 deletion fencing: neither the debounce-pending document nor a
      // run parked in the FIFO may re-put a record the user has deleted.
      // A parked attempt is flagged taken so its queue task becomes a no-op,
      // mirroring flush()'s promotion; attempts for other ids stay live and
      // an already in-flight repository.save() is not interrupted. The
      // debounce timer is armed for exactly the pending attempt, so it is
      // only cleared when that attempt is the one being dropped.
      if (queued !== null && queued.project.id === projectId) {
        queued.taken = true;
        queued = null;
      }
      if (pending !== null && pending.project.id === projectId) {
        clearTimer();
        pending = null;
      }
    },

    flush(): Promise<boolean> {
      clearTimer();
      // §3.22 unload durability: promote whatever accepted edit has not
      // reached storage yet — BOTH the debounced-pending document AND any
      // run whose timer already fired but is still parked in the FIFO behind
      // an in-flight save (waiting there can starve the fire-and-forget
      // flush until the tab dies and those edits are lost). Every un-taken
      // attempt is taken here (its original queue task no-ops via its taken
      // flag) and re-run INLINE, in generation order, older first.
      //
      // The runs are inline but NOT lock-free: the whole session holds the
      // shared WriteGate, so a debounce timer firing mid-flush buffers its
      // task on the gate until every promoted attempt has settled — a newer
      // save can never land before an older promoted one and commit the
      // stale payload last (§3.16 last-write-wins; IndexedDB serializes
      // overlapping readwrite transactions in issue order). When storage is
      // idle the gate is taken synchronously, so the first promoted
      // repository.save() STARTS during this very call — unload can kill
      // pending JS before an awaited continuation ever runs. When a debounced
      // save is already in flight, the session buffers on the gate instead:
      // that save's own write is already started, so nothing loses durability,
      // and ordering stays strict. Awaiting the session keeps the
      // flush-before-read contract (§3.16): callers read storage only after
      // every promoted attempt has settled.
      const attempts: PendingSave[] = [];
      if (queued !== null) attempts.push(queued);
      if (pending !== null) attempts.push(pending);
      if (attempts.length === 0) return Promise.resolve(true);
      for (const attempt of attempts) attempt.taken = true;
      pending = null;
      queued = null;

      const runSession = async (): Promise<boolean> => {
        try {
          let ok = true;
          for (const attempt of attempts) {
            if (!(await run(attempt))) ok = false;
          }
          return ok;
        } finally {
          gate.release();
        }
      };

      if (gate.free) {
        gate.takeSync();
        return runSession();
      }
      return gate.acquire().then(runSession);
    },

    generation(): number {
      return latestGeneration;
    },
  };
}
