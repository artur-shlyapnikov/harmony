/**
 * Timeline interval operations (§3.7 timeline mutation rules).
 *
 * All timeline editing goes through the shared interval operation:
 * `replaceRange(events, [start, end), replacement)` — a new note/chord
 * REPLACES the time range it intersects. Fragments get new ids so UI
 * identity stays stable. Pure functions; inputs are never mutated.
 */

import type { Tick } from '@domain/model/project';
import type { ChordEvent } from '@domain/model/project';

/** Minimal structural supertype of MelodyNoteEvent / ChordEvent. */
export type IntervalEvent = {
  id: string;
  startTick: Tick;
  durationTicks: Tick;
};

/** Stable sort by startTick, then id for equal starts. Inputs are not mutated. */
export function sortEvents<T extends IntervalEvent>(events: readonly T[]): T[] {
  return [...events].sort((a, b) =>
    a.startTick !== b.startTick ? a.startTick - b.startTick : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

const defaultNewId = (): string => crypto.randomUUID();

function eventEnd(event: IntervalEvent): Tick {
  return event.startTick + event.durationTicks;
}

/**
 * §3.7 steps 1–6. Events overlapping `[range.start, range.end)` are
 * truncated: a left fragment (started before range.start) is kept with a NEW
 * id and end clipped to range.start; a right fragment (ending after range.end)
 * is kept with a NEW id and start moved to range.end; fully covered events are
 * removed; the replacement (if any) is inserted; the result is sorted by
 * startTick then id. Zero-length fragments are never emitted.
 */
export function replaceRange<T extends IntervalEvent>(
  events: readonly T[],
  range: { start: Tick; end: Tick },
  replacement: T | null,
  newId: () => string = defaultNewId,
): T[] {
  if (range.start === range.end) {
    return replacement === null ? sortEvents(events) : sortEvents([...events, replacement]);
  }

  const result: T[] = [];

  for (const event of events) {
    const end = eventEnd(event);
    const overlaps = event.startTick < range.end && end > range.start;
    if (!overlaps) {
      result.push(event);
      continue;
    }

    if (event.startTick < range.start) {
      // Left fragment: keep the part before the range, under a NEW id.
      const leftDuration = range.start - event.startTick;
      if (leftDuration > 0) {
        result.push({ ...event, id: newId(), durationTicks: leftDuration });
      }
    }

    if (end > range.end) {
      // Right fragment: keep the part after the range, under a NEW id.
      const rightDuration = end - range.end;
      if (rightDuration > 0) {
        result.push({ ...event, id: newId(), startTick: range.end, durationTicks: rightDuration });
      }
    }
    // Fully covered portion is removed (step 4).
  }

  if (replacement !== null) {
    result.push(replacement);
  }

  return sortEvents(result);
}

function deepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqualValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function sameChordIdentity(a: ChordEvent, b: ChordEvent): boolean {
  const specEqual = deepEqualValue(a.chord, b.chord);
  const overrideEqual =
    (a.patternOverride === undefined && b.patternOverride === undefined) ||
    (a.patternOverride !== undefined &&
      b.patternOverride !== undefined &&
      deepEqualValue(a.patternOverride, b.patternOverride));
  return specEqual && overrideEqual;
}

/**
 * §3.7 step 7 (harmony lane). Merges contiguous neighbors —
 * `prevEnd === next.start` — whose ChordSpec is deep-equal AND whose
 * patternOverride is both-absent-or-deep-equal, keeping the earlier id and
 * extending the duration. Non-contiguous gaps never merge.
 */
export function mergeAdjacentIdenticalChords(chords: readonly ChordEvent[]): ChordEvent[] {
  const merged: ChordEvent[] = [];
  for (const chord of sortEvents(chords)) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      eventEnd(previous) === chord.startTick &&
      sameChordIdentity(previous, chord)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        durationTicks: eventEnd(chord) - previous.startTick,
      };
    } else {
      merged.push(chord);
    }
  }
  return merged;
}

/**
 * Clips events crossing `lengthTicks` back to the project length; drops
 * zero-length results. Ids are always preserved: clipping keeps the event's
 * musical identity (§3.7 fragment ids are reserved for replaceRange).
 */
export function trimEventsBeyond<T extends IntervalEvent>(
  events: readonly T[],
  lengthTicks: Tick,
): T[] {
  const result: T[] = [];
  for (const event of events) {
    if (event.startTick >= lengthTicks) continue;
    if (eventEnd(event) > lengthTicks) {
      const clippedDuration = lengthTicks - event.startTick;
      if (clippedDuration > 0) {
        result.push({ ...event, durationTicks: clippedDuration });
      }
    } else {
      result.push(event);
    }
  }
  return result;
}
