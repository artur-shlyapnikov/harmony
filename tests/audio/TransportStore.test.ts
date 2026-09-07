import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportStore } from '@audio/TransportStore';

describe('TransportStore', () => {
  let store: TransportStore;

  beforeEach(() => {
    store = new TransportStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle at tick 0', () => {
    expect(store.getSnapshot()).toMatchObject({ status: 'idle', currentTick: 0, playheadVersion: 0 });
  });

  it('notifies subscribers with a fresh immutable snapshot on status change', () => {
    const before = store.getSnapshot();
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));

    store.setStatus('starting');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'starting' });
    expect(seen[0]).not.toBe(before);
    // Snapshot getter is stable between publishes.
    expect(store.getSnapshot()).toBe(seen[0]);

    unsubscribe();
    store.setStatus('playing');
    expect(seen).toHaveLength(1);
  });

  it('does not notify when status (and message) are unchanged', () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.setStatus('error', 'boom');
    store.setStatus('error', 'boom');
    expect(listener).toHaveBeenCalledTimes(1);
    // A different message is a real change.
    store.setStatus('error', 'other');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps errorMessage only in error state', () => {
    store.setStatus('error', 'boom');
    expect(store.getSnapshot().errorMessage).toBe('boom');
    store.setStatus('idle');
    expect(store.getSnapshot().errorMessage).toBeUndefined();
  });

  it('setTick bumps playheadVersion and notifies', () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.setTick(480);
    expect(store.getSnapshot()).toMatchObject({ currentTick: 480, playheadVersion: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    // Same tick → no notification (useSyncExternalStore-safe).
    store.setTick(480);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('pump reads live ticks each frame and stops cleanly', () => {
    vi.useFakeTimers();
    let live = 0;
    const listener = vi.fn();
    store.subscribe(listener);

    store.startPump(() => live);
    live = 240;
    vi.advanceTimersByTime(20);
    expect(store.getSnapshot().currentTick).toBe(240);

    live = 960;
    vi.advanceTimersByTime(20);
    expect(store.getSnapshot().currentTick).toBe(960);

    store.stopPump();
    live = 1920;
    vi.advanceTimersByTime(100);
    expect(store.getSnapshot().currentTick).toBe(960);
  });

  it('re-starting the pump swaps the reader without stacking loops', () => {
    vi.useFakeTimers();
    let reads = 0;
    store.startPump(() => 1);
    store.startPump(() => {
      reads += 1;
      return 2;
    });

    vi.advanceTimersByTime(50);
    const readsAfterWindow = reads;
    vi.advanceTimersByTime(50);

    // Exactly one loop: read rate stays constant after the swap.
    expect(reads).toBe(readsAfterWindow * 2);
    expect(store.getSnapshot().currentTick).toBe(2);
    store.stopPump();
  });
});
