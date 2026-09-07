/**
 * NoteInspector (§3.20): spelled note name, explicit accidental override
 * (§3.20 Chromatic alteration), duration in beats, velocity 1..127, delete.
 * The MIDI number is display-only — pitch edits happen in the melody lane.
 */

import { useEffect, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import {
  type Accidental,
} from '@domain/model/pitch';
import { spellMelodyMidi } from "@domain/theory/spelling";
import { beatsNounRu, formatBeatsRu } from '@shared/labels';
import { spelledName } from "@domain/model/pitch";
import { PPQ } from '@domain/timeline/constants';
import {
  deleteNoteCmd,
  setNoteSpellingOverrideCmd,
  setNoteVelocityCmd,
} from '@state/commands';
import {
  selectHarmonyContext,
  selectMelodyNotes,
  selectSelection,
} from '@state/selectors';

const ACCIDENTAL_OPTIONS: readonly { value: Accidental; label: string }[] = Object.freeze([
  { value: -2, label: '𝄫 (bb)' },
  { value: -1, label: '♭ (b)' },
  { value: 0, label: 'бекар' },
  { value: 1, label: '♯ (#)' },
  { value: 2, label: '𝄪 (##)' },
]);


/** Musical note-value names for standard durations (NOTE_GRID multiples up to a dotted whole). */
const NOTE_VALUE_NAMES: readonly (readonly [beats: number, name: string])[] = Object.freeze([
  [6, 'целая с точкой'],
  [4, 'целая'],
  [3, 'половинная с точкой'],
  [2, 'половинная'],
  [1.5, 'четверть с точкой'],
  [1, 'четверть'],
  [0.75, 'восьмая с точкой'],
  [0.5, 'восьмая'],
  [0.25, 'шестнадцатая'],
]);

function noteValueName(beats: number): string | null {
  const match = NOTE_VALUE_NAMES.find(([value]) => Math.abs(beats - value) < 1e-6);
  return match?.[1] ?? null;
}


export function NoteInspector({ className }: { className?: string }) {
  const dispatch = useAppDispatch();
  const notes = useAppSelector(selectMelodyNotes);
  const selection = useAppSelector(selectSelection);
  const context = useAppSelector(selectHarmonyContext);

  // Local velocity mirror so the slider stays responsive between dispatches.
  const [velocityDraft, setVelocityDraft] = useState<number | null>(null);

  // Focus anchor for keyboard users: survives the empty-state re-render after
  // «Удалить ноту», so focus never silently drops to document.body.
  const containerRef = useRef<HTMLDivElement | null>(null);

  const note =
    selection?.kind === 'note'
      ? notes.find((candidate) => candidate.id === selection.id)
      : undefined;

  // A pending draft belongs to the note it was started on: when selection
  // moves to another note before pointerup/keyup commits it, rendering the
  // old draft would show (and commit) A's value against B's id.
  useEffect(() => {
    setVelocityDraft(null);
  }, [note?.id]);

  if (note === undefined) {
    return (
      <div
        ref={containerRef}
        className={className}
        data-testid="note-inspector"
        tabIndex={-1}
      >
        Нота не выбрана
      </div>
    );
  }

  const spelling = note.spellingOverride ?? spellMelodyMidi(note.midi, context);
  const durationBeats = note.durationTicks / PPQ;
  const noteValue = noteValueName(durationBeats);

  return (
    <div
      ref={containerRef}
      className={className}
      data-testid="note-inspector"
      tabIndex={-1}
    >
      <strong data-testid="inspector-note-name">
        {spelledName(spelling)}
        {Math.floor(note.midi / 12) - 1}
      </strong>

      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        MIDI: <span data-testid="inspector-midi">{note.midi}</span> · Длительность:{' '}
        <span data-testid="inspector-duration">{formatBeatsRu(durationBeats)}</span>{' '}
        {beatsNounRu(durationBeats)}
        {noteValue !== null && <span> ({noteValue})</span>}
      </div>

      {/* Explicit accidental override (letter preserved) */}
      <label style={{ display: 'block', marginTop: 8 }}>
        Альтерация:{' '}
        <select
          data-testid="inspector-accidental"
          // '' = no explicit override → «по ладу» (§3.20); spelled name above shows the effective accidental.
          value={note.spellingOverride?.accidental ?? ''}
          onChange={(event) =>
            dispatch(
              setNoteSpellingOverrideCmd({
                id: note.id,
                override:
                  event.target.value === ''
                    ? null
                    : {
                        letter: spelling.letter,
                        accidental: Number(event.target.value) as Accidental,
                      },
              }),
            )
          }
        >
          <option value="">— по ладу</option>
          {ACCIDENTAL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {spelling.letter}
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/* Velocity */}
      <label style={{ display: 'block', marginTop: 8 }}>
        Громкость ({velocityDraft ?? note.velocity}):{' '}
        <input
          data-testid="inspector-velocity"
          type="range"
          min={1}
          max={127}
          value={velocityDraft ?? note.velocity}
          onChange={(event) => setVelocityDraft(Number(event.target.value))}
          onPointerUp={() => {
            if (velocityDraft !== null && velocityDraft !== note.velocity) {
              dispatch(setNoteVelocityCmd({ id: note.id, velocity: velocityDraft }));
            }
            setVelocityDraft(null);
          }}
          onKeyUp={() => {
            if (velocityDraft !== null && velocityDraft !== note.velocity) {
              dispatch(setNoteVelocityCmd({ id: note.id, velocity: velocityDraft }));
            }
            setVelocityDraft(null);
          }}
        />
      </label>

      <button
        style={{ marginTop: 12 }}
        onClick={() => {
          dispatch(deleteNoteCmd({ id: note.id }));
          containerRef.current?.focus();
        }}
      >
        Удалить ноту
      </button>
    </div>
  );
}
