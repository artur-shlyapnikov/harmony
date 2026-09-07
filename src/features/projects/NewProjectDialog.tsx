/**
 * Project creation dialog (§3.18 / project library): title, tonic (one of 17
 * common tonics or a free letter+accidental pair), mode (7 modes), bars
 * (1..128, default 8). Submit creates the document, persists it and navigates
 * to the editor.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDependencies } from '@app/dependencies';
import { useFocusTrap } from '@shared/focusTrap';
import { createProjectDocument } from '@domain/model/project';
import {
  type Accidental,
  type ModeId,
  type NoteLetter,
  type SpelledPitchClass,
  spelledName,
} from '@domain/model/pitch';
import { MAX_BARS, MIN_BARS } from '@domain/timeline/constants';
import { MODE_LABELS, MODE_OPTIONS, TONIC_OPTIONS } from '@shared/labels';

const LETTERS: readonly NoteLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const ACCIDENTAL_OPTIONS: readonly { value: Accidental; label: string }[] = Object.freeze([
  { value: -2, label: '𝄫 (bb)' },
  { value: -1, label: '♭ (b)' },
  { value: 0, label: 'бекар' },
  { value: 1, label: '♯ (#)' },
  { value: 2, label: '𝄪 (##)' },
]);

const CUSTOM_TONIC = 'custom';

/** Clean dialog state, restored every time the dialog opens (NP-1). */
const DEFAULTS = {
  title: 'Новый проект',
  tonicChoice: spelledName(TONIC_OPTIONS[0]!),
  customLetter: 'C' as NoteLetter,
  customAccidental: 0 as Accidental,
  mode: 'ionian' as ModeId,
  bars: 8,
};

export function NewProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(DEFAULTS.title);
  const [tonicChoice, setTonicChoice] = useState(DEFAULTS.tonicChoice);
  const [customLetter, setCustomLetter] = useState<NoteLetter>(DEFAULTS.customLetter);
  const [customAccidental, setCustomAccidental] = useState<Accidental>(DEFAULTS.customAccidental);
  const [mode, setMode] = useState<ModeId>(DEFAULTS.mode);
  const [bars, setBars] = useState(DEFAULTS.bars);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trapRef = useFocusTrap<HTMLFormElement>(open);
  // NP-1: the dialog stays mounted for ProjectListPage's lifetime; restore
  // clean defaults on each open transition so stale edits and error banners
  // never reappear. Runs only on the closed → open transition, never while
  // a save is in flight (the dialog stays open for the whole save).
  useEffect(() => {
    if (!open) return;
    setTitle(DEFAULTS.title);
    setTonicChoice(DEFAULTS.tonicChoice);
    setCustomLetter(DEFAULTS.customLetter);
    setCustomAccidental(DEFAULTS.customAccidental);
    setMode(DEFAULTS.mode);
    setBars(DEFAULTS.bars);
    setError(null);
    setBusy(false);
  }, [open]);

  // ChordPicker convention (RevUI-3): Escape and an overlay click dismiss
  // the modal; the document-level bubble listener fires ahead of the window
  // shortcut listener. While a save is in flight the dialog stays put —
  // the save either navigates to the editor or surfaces the error.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The dialog-level bubble listener fires ahead of the window shortcut
      // listener: Escape must NEVER leak there (it clears the selection
      // behind the modal). While a save is in flight Escape is swallowed
      // without closing — the dialog stays put until the save resolves.
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);
  if (!open) return null;

  const resolvedTonic: SpelledPitchClass =
    tonicChoice === CUSTOM_TONIC
      ? { letter: customLetter, accidental: customAccidental }
      : (TONIC_OPTIONS.find((option) => spelledName(option) === tonicChoice) ?? TONIC_OPTIONS[0]!);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError('Укажите название проекта');
      return;
    }
    if (!Number.isInteger(bars) || bars < MIN_BARS || bars > MAX_BARS) {
      setError(`Количество тактов — от ${MIN_BARS} до ${MAX_BARS}`);
      return;
    }

    const document = createProjectDocument({
      title: trimmedTitle,
      tonic: resolvedTonic,
      mode,
      bars,
    });

    setBusy(true);
    setError(null);
    getDependencies()
      .projects.create(document)
      .then(() => {
        onClose();
        void navigate(`/project/${document.id}`);
      })
      .catch((saveError: unknown) => {
        setBusy(false);
        setError(
          saveError instanceof Error
            ? `Не удалось сохранить проект: ${saveError.message}`
            : 'Не удалось сохранить проект',
        );
      });
  };

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      {/* RevUI-3: [data-modal] guard for useEditorShortcuts (see ChordPicker). */}
      <form
        ref={trapRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        data-modal=""
        aria-label="Новый проект"
        noValidate
        onSubmit={handleSubmit}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title">Новый проект</h2>

        <label className="dialog-field">
          Название
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            required
          />
        </label>

        <fieldset className="dialog-field">
          <legend>Тоника</legend>
          <select
            aria-label="Тоника"
            value={tonicChoice}
            onChange={(event) => setTonicChoice(event.target.value)}
          >
            {TONIC_OPTIONS.map((tonic) => (
              <option key={spelledName(tonic)} value={spelledName(tonic)}>
                {spelledName(tonic)}
              </option>
            ))}
            <option value={CUSTOM_TONIC}>Другая…</option>
          </select>
          {tonicChoice === CUSTOM_TONIC && (
            <span className="dialog-inline-selects">
              <select
                aria-label="Буква тоники"
                value={customLetter}
                onChange={(event) => setCustomLetter(event.target.value as NoteLetter)}
              >
                {LETTERS.map((letter) => (
                  <option key={letter} value={letter}>
                    {letter}
                  </option>
                ))}
              </select>
              <select
                aria-label="Альтерация тоники"
                value={customAccidental}
                onChange={(event) =>
                  setCustomAccidental(Number(event.target.value) as Accidental)
                }
              >
                {ACCIDENTAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </span>
          )}
        </fieldset>

        <label className="dialog-field">
          Лад
          <select
            aria-label="Лад"
            value={mode}
            onChange={(event) => setMode(event.target.value as ModeId)}
          >
            {MODE_OPTIONS.map((modeId) => (
              <option key={modeId} value={modeId}>
                {MODE_LABELS[modeId]}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field">
          <span className="dialog-field-row">
            Такты <span className="dialog-field-hint">1–128</span>
          </span>
          <input
            aria-label="Количество тактов"
            type="number"
            min={MIN_BARS}
            max={MAX_BARS}
            step={1}
            value={bars}
            onChange={(event) => setBars(Number(event.target.value))}
          />
        </label>

        {error !== null && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="button-primary" disabled={busy}>
            Создать
          </button>
        </div>
      </form>
    </div>
  );
}
