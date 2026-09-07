/**
 * Framework-external transport state (§3.17 Execution model).
 *
 * The playhead position is NOT dispatched into Redux 60 times per second:
 * React reads it from this observable store via useSyncExternalStore, updated
 * by a requestAnimationFrame pump that runs only while playing.
 *
 * No React imports. Snapshots are immutable objects so `getSnapshot()` can be
 * used directly as a useSyncExternalStore snapshot getter.
 */

import type { Tick } from '@domain/model/project';

export type TransportStatus = 'idle' | 'starting' | 'playing' | 'paused' | 'error';

export type TransportSnapshot = {
  status: TransportStatus;
  /** Last playhead position in ticks (live while pumping, preserved otherwise). */
  currentTick: Tick;
  /** Bumped on every currentTick change so consumers can key effects off it. */
  playheadVersion: number;
  /** Populated only when status is 'error'. */
  errorMessage?: string;
};

const INITIAL_SNAPSHOT: TransportSnapshot = Object.freeze({
  status: 'idle',
  currentTick: 0,
  playheadVersion: 0,
});

type FrameHandle = number;

function scheduleFrame(handler: () => void): FrameHandle {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === 'function') return raf.call(globalThis, handler);
  return globalThis.setTimeout(handler, 16) as unknown as FrameHandle;
}

function cancelFrame(handle: FrameHandle): void {
  const rafCancel = globalThis.cancelAnimationFrame;
  if (typeof rafCancel === 'function') rafCancel.call(globalThis, handle);
  else globalThis.clearTimeout(handle);
}

export class TransportStore {
  private snapshot: TransportSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private frame: FrameHandle | null = null;
  private readTick: (() => Tick) | null = null;
  /** Logged-once guard for listener throws inside the pump (see startPump). */
  private pumpErrorLogged = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TransportSnapshot => this.snapshot;

  setStatus(status: TransportStatus, errorMessage?: string): void {
    const prev = this.snapshot;
    const message = status === 'error' ? (errorMessage ?? 'Audio error') : undefined;
    if (
      prev.status === status &&
      prev.errorMessage === message
    ) {
      return;
    }
    this.publish({
      status,
      currentTick: prev.currentTick,
      playheadVersion: prev.playheadVersion,
      ...(message === undefined ? {} : { errorMessage: message }),
    });
  }

  setTick(currentTick: Tick): void {
    if (this.snapshot.currentTick === currentTick) return;
    this.publish({
      ...this.snapshot,
      currentTick,
      playheadVersion: this.snapshot.playheadVersion + 1,
    });
  }

  /**
   * Starts the rAF tick pump. While running, each frame reads the live tick
   * via `readTick` and publishes it when it changed. Re-calling while running
   * swaps the reader without stacking loops; `stopPump` ends it.
   */
  startPump(readTick: () => Tick): void {
    this.readTick = readTick;
    this.pumpErrorLogged = false;
    if (this.frame !== null) return;
    const step = (): void => {
      this.frame = null;
      const read = this.readTick;
      if (read === null) return;
      // A throwing useSyncExternalStore listener unwinds through publish();
      // try/finally guarantees the next frame is still scheduled so the
      // playhead never freezes while the transport plays.
      try {
        this.setTick(read());
      } catch (error) {
        if (!this.pumpErrorLogged) {
          this.pumpErrorLogged = true;
          console.error('TransportStore: listener threw during publish', error);
        }
      } finally {
        this.frame = scheduleFrame(step);
      }
    };
    this.frame = scheduleFrame(step);
  }

  stopPump(): void {
    this.readTick = null;
    if (this.frame !== null) {
      cancelFrame(this.frame);
      this.frame = null;
    }
  }

  private publish(next: TransportSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

let singleton: TransportStore | null = null;

/** Module-level singleton shared by AudioEngine, toolbar and playhead. */
export function getTransportStore(): TransportStore {
  singleton ??= new TransportStore();
  return singleton;
}
