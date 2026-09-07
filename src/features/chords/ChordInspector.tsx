/**
 * ChordInspector (§3.20): edits the selected chord's root/template and
 * pattern override (six kinds + inherit), shows the EXACT resolved voicing
 * for this chord id (mini piano + note list), and an effective-formula
 * tooltip listing omitted optional tones ("В voicing опущены 5 и 9", §3.21).
 */

import { useEffect, useMemo, useRef } from 'react';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import {
  type Accidental,
  type NoteLetter,
} from '@domain/model/pitch';
import {
  TEMPLATE_BY_ID,
  type ChordTemplateId,
  chordSymbol,
} from '@domain/model/chord';
import { type PatternKind } from '@domain/model/pattern';
import { CHORD_FAMILY_GROUPS } from '@domain/theory/chordCatalog';
import { degreeLabel } from '@domain/theory/chordFormula';
import { formatNoteNameWithOctave } from '@domain/theory/spelling';
import { selectChordTones } from '@domain/voicing/selectChordTones';
import { setChordPatternOverrideCmd, setChordSpecCmd } from '@state/commands';
import {
  selectChords,
  selectDefaultPattern,
  selectHarmonyContext,
  selectSelection,
  selectVoicingByChordId,
} from '@state/selectors';
import { MiniPiano } from './ChordPicker';
import { CHORD_FAMILY_LABELS, PATTERN_LABELS } from '@shared/labels';

const LETTERS: readonly NoteLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ACCIDENTAL_OPTIONS: readonly { value: Accidental; label: string }[] = [
  { value: -2, label: 'bb' },
  { value: -1, label: 'b' },
  { value: 0, label: '♮' },
  { value: 1, label: '#' },
  { value: 2, label: '##' },
];

const PATTERN_KINDS: readonly PatternKind[] = [
  'block',
  'up',
  'down',
  'upDown',
  'bassChord',
  'oneFiveThreeFive',
];

/** Degrees present in the resolved voicing but not required by the formula. */
function omittedToneLabels(
  spec: { root: { letter: NoteLetter; accidental: Accidental }; templateId: ChordTemplateId },
  maxVoices: number,
): string[] {
  const template = TEMPLATE_BY_ID[spec.templateId];
  const selected = new Set(selectChordTones(spec, maxVoices).map((tone) => tone.degree));
  return template.tones
    .filter(
      (tone) =>
        tone.voicingPriority !== 'required' && !selected.has(tone.degree),
    )
    .map((tone) => degreeLabel(tone.degree, spec));
}

export function ChordInspector({ className }: { className?: string }) {
  const dispatch = useAppDispatch();
  const chords = useAppSelector(selectChords);
  const selection = useAppSelector(selectSelection);
  const defaultPattern = useAppSelector(selectDefaultPattern);
  const voicings = useAppSelector(selectVoicingByChordId);
  const context = useAppSelector(selectHarmonyContext);
  // Focus anchor (mirrors NoteInspector): when the focused chord is deleted
  // the inspector re-renders into its empty state — keep keyboard focus here
  // instead of letting it drop to document.body.
  const containerRef = useRef<HTMLDivElement | null>(null);

  const chord = useMemo(
    () => (selection?.kind === 'chord'
      ? chords.find((candidate) => candidate.id === selection.id)
      : undefined),
    [chords, selection],
  );

  const hadChord = useRef(false);
  useEffect(() => {
    if (chord !== undefined) {
      hadChord.current = true;
      return;
    }
    if (hadChord.current) {
      hadChord.current = false;
      containerRef.current?.focus();
    }
  }, [chord]);

  if (chord === undefined) {
    return (
      <div ref={containerRef} className={className} data-testid="chord-inspector" tabIndex={-1}>
        Аккорд не выбран
      </div>
    );
  }

  const spec = chord.chord;
  const voicing = voicings.get(chord.id);
  const omitted = omittedToneLabels(spec, 4);

  return (
    <div
      ref={containerRef}
      className={className}
      data-testid="chord-inspector"
      tabIndex={-1}
    >
      <strong data-testid="inspector-symbol">{chordSymbol(spec)}</strong>

      {/* Root editor */}
      <label style={{ display: 'block', marginTop: 8 }}>
        Основание:{' '}
        <select
          data-testid="inspector-root-letter"
          value={spec.root.letter}
          onChange={(event) =>
            dispatch(
              setChordSpecCmd({
                id: chord.id,
                chord: {
                  ...spec,
                  root: {
                    ...spec.root,
                    letter: event.target.value as NoteLetter,
                  },
                },
              }),
            )
          }
        >
          {LETTERS.map((letter) => (
            <option key={letter} value={letter}>
              {letter}
            </option>
          ))}
        </select>
        <select
          data-testid="inspector-root-accidental"
          value={spec.root.accidental}
          onChange={(event) =>
            dispatch(
              setChordSpecCmd({
                id: chord.id,
                chord: {
                  ...spec,
                  root: {
                    ...spec.root,
                    accidental: Number(event.target.value) as Accidental,
                  },
                },
              }),
            )
          }
        >
          {ACCIDENTAL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/* Template editor */}
      <label style={{ display: 'block', marginTop: 8 }}>
        Шаблон:{' '}
        <select
          data-testid="inspector-template"
          value={spec.templateId}
          onChange={(event) =>
            dispatch(
              setChordSpecCmd({
                id: chord.id,
                chord: { ...spec, templateId: event.target.value as ChordTemplateId },
              }),
            )
          }
        >
          {CHORD_FAMILY_GROUPS.map((group) => (
            <optgroup key={group.family} label={CHORD_FAMILY_LABELS[group.family]}>
              {group.templateIds.map((id) => (
                <option key={id} value={id}>
                  {TEMPLATE_BY_ID[id].displaySuffix === '' ? 'maj' : TEMPLATE_BY_ID[id].displaySuffix}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {/* Pattern override */}
      <label style={{ display: 'block', marginTop: 8 }}>
        Паттерн:{' '}
        <select
          data-testid="inspector-pattern"
          value={chord.patternOverride?.kind ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            dispatch(
              setChordPatternOverrideCmd({
                id: chord.id,
                pattern:
                  value === ''
                    ? null
                    : ({ ...defaultPattern, kind: value as PatternKind }),
              }),
            );
          }}
        >
          <option value="">— наследовать</option>
          {PATTERN_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {PATTERN_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>

      {/* Voicing preview for THIS chord */}
      <div style={{ marginTop: 12 }} title={omitted.length > 0 ? `В voicing опущены ${omitted.join(' и ')}` : undefined}>
        <strong>Голосоведение</strong>
        {omitted.length > 0 && (
          <span data-testid="omitted-tones" style={{ marginLeft: 8, fontSize: 12, color: '#fbbf24' }}>
            В voicing опущены {omitted.join(' и ')}
          </span>
        )}
        {voicing === undefined ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Нет данных</div>
        ) : (
          <>
            <MiniPiano highlightPcs={[]} highlightMidis={voicing.midiNotes} />
            <div style={{ fontSize: 12 }}>
              {voicing.midiNotes.map((midi) => formatNoteNameWithOctave(midi, context)).join(', ')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
