/**
 * Shared Russian UI label tables (§3.20): chord families and pattern kinds.
 *
 * The app UI is Russian; these keep enum ids (basic/seventh, block/up, …)
 * from leaking onto chord surfaces. EditorToolbar keeps its own private copy
 * of the pattern wording — the strings here mirror it verbatim.
 */

import { CHORD_FAMILY_GROUPS } from '@domain/theory/chordCatalog';
import type { PatternKind } from '@domain/model/pattern';
import { type ModeId, type SpelledPitchClass, parseSpelled } from '@domain/model/pitch';

/** 17 common tonics: every pitch class plus frequent enharmonic spellings. */
export const TONIC_OPTIONS: readonly SpelledPitchClass[] = Object.freeze(
  [
    'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#',
    'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
  ].map((name) => {
    const parsed = parseSpelled(name);
    if (parsed === null) throw new Error(`Bad tonic option ${name}`);
    return parsed;
  }),
);

export const MODE_OPTIONS: readonly ModeId[] = Object.freeze([
  'ionian',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'aeolian',
  'locrian',
]);
export const MODE_LABELS: Readonly<Record<ModeId, string>> = Object.freeze({
  ionian: 'Ионийский (мажор)',
  dorian: 'Дорийский',
  phrygian: 'Фригийский',
  lydian: 'Лидийский',
  mixolydian: 'Миксолидийский',
  aeolian: 'Эолийский (минор)',
  locrian: 'Локрийский',
});

export type ChordFamily = (typeof CHORD_FAMILY_GROUPS)[number]['family'];

export const CHORD_FAMILY_LABELS: Readonly<Record<ChordFamily, string>> = Object.freeze({
  basic: 'Основные',
  seventh: 'Септаккорды',
  extended: 'Расширенные',
  sus: 'Сустейны',
  color: 'Колор',
});

export const PATTERN_LABELS: Readonly<Record<PatternKind, string>> = Object.freeze({
  block: 'Аккорд (блок)',
  up: 'Арпеджио вверх',
  down: 'Арпеджио вниз',
  upDown: 'Арпеджио вверх-вниз',
  bassChord: 'Бас + аккорд',
  oneFiveThreeFive: 'Бас-квинта-терция',
});

/** Russian plural: 1 такт, 2 такта, 5 тактов. */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Russian decimal comma for beat counts: 0.25 → «0,25», 1 → «1». */
const BEATS_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

export function formatBeatsRu(beats: number): string {
 return BEATS_FORMAT.format(beats);
}

/** Russian plural for beats («доля»): 1 доля, 2 доли, 5 долей; дробные — «доли». */
export function beatsNounRu(beats: number): string {
 if (!Number.isInteger(beats)) return 'доли';
 return pluralRu(beats, 'доля', 'доли', 'долей');
}

/** «25 авг., 08:38»; the year appears only when it differs from the current one. */
const MODIFIED_SHORT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const MODIFIED_SHORT_WITH_YEAR = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatModifiedRu(timestamp: number | string | Date, now: Date = new Date()): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return (date.getFullYear() === now.getFullYear() ? MODIFIED_SHORT : MODIFIED_SHORT_WITH_YEAR).format(date);
}
