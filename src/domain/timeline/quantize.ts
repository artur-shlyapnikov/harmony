/**
 * Timing quantization helpers (§3.4 timing invariants).
 *
 * Pure domain functions over integer ticks. No side effects, no input mutation.
 */

/** Floor a tick to the nearest grid multiple, never below 0. */
export function quantizeTick(tick: number, grid: number): number {
  return Math.max(0, Math.floor(tick / grid) * grid);
}

/** Floor a duration to the nearest grid multiple, at least one grid step. */
export function quantizeDuration(durationTicks: number, grid: number): number {
  return Math.max(grid, Math.floor(durationTicks / grid) * grid);
}

/** Clamp a tick into [min, max]. */
export function clampTick(tick: number, min: number, max: number): number {
  return Math.min(Math.max(tick, min), max);
}
