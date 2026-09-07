/**
 * Top toolbar (§3.20): project title | Key (transpose, §3.14) | Mode
 * (reinterpret) | BPM | default Pattern | Undo/Redo | Play/Pause/Stop |
 * Export MIDI, plus the §3.18 storage-error banner slot.
 *
 * Transport buttons mirror the external transport state (never Redux);
 * Space is owned by the keyboard-shortcuts layer — these buttons only
 * call the ProjectTransport through the dependency container.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@app/hooks';
import { getDependencies } from '@app/dependencies';

import { type PatternKind } from '@domain/model/pattern';
import {
  type ModeId,
  parseSpelled,
  spelledName,
} from '@domain/model/pitch';
import { MODE_LABELS, MODE_OPTIONS, PATTERN_LABELS, TONIC_OPTIONS } from '@shared/labels';
import { REDO_ACTION_TYPE, UNDO_ACTION_TYPE } from '@state/historyReducer';
import {
  changeBpmCmd,
  setActiveToolCmd,
  setDefaultPatternCmd,
  setModeCmd,
  setTitleCmd,
  transposeToTonicCmd,
} from '@state/commands';
import {
  selectActiveTool,
  selectDefaultPattern,
  selectHarmonyContext,
  selectPersistenceError,
  selectPresentProject,
  selectSaveStatus,
  selectTiming,
} from '@state/selectors';
import { TransportControls } from '@features/transport/TransportControls';

/** Undo hint matches the platform: the shortcut layer accepts both Ctrl and ⌘. */
const UNDO_HINT = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
  ? '⌘Z'
  : 'Ctrl+Z';



export const PATTERN_KIND_OPTIONS: readonly PatternKind[] = Object.freeze([
  'block',
  'up',
  'down',
  'upDown',
  'bassChord',
  'oneFiveThreeFive',
]);



/** §3.15 activeTool model: the lane tools exposed as toolbar buttons. */
const TOOL_OPTIONS: readonly {
  tool: 'select' | 'drawNote' | 'drawChord';
  label: string;
  testId: string;
}[] = Object.freeze([
  { tool: 'select', label: 'Выбор', testId: 'tool-select' },
  { tool: 'drawNote', label: 'Нота', testId: 'tool-draw-note' },
  { tool: 'drawChord', label: 'Аккорд', testId: 'tool-draw-chord' },
]);

const SAVE_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  idle: '',
  dirty: 'Есть изменения',
  saving: 'Сохранение…',
  saved: 'Сохранено',
  error: 'Ошибка сохранения',
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EditorToolbar({ className }: { className?: string }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const context = useAppSelector(selectHarmonyContext);
  const timing = useAppSelector(selectTiming);
  const defaultPattern = useAppSelector(selectDefaultPattern);
  const present = useAppSelector(selectPresentProject);
  const activeTool = useAppSelector(selectActiveTool);
  const saveStatus = useAppSelector(selectSaveStatus);
  const persistenceError = useAppSelector(selectPersistenceError);
  const canUndo = useAppSelector((state) => state.projectHistory.past.length > 0);
  const canRedo = useAppSelector((state) => state.projectHistory.future.length > 0);

  // §3.3: exports go through the application composition root instead of
  // importing @persistence/* / @midi/* directly.
  const { downloadBackup, downloadMidi } = getDependencies();

  // Local BPM buffer so typing does not dispatch a command per keystroke;
  // committed on blur/Enter, re-synced whenever the document changes.
  const [bpmDraft, setBpmDraft] = useState(String(timing.bpm));
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // Escape drops the rename input; the title button is unmounted while the
  // input is open, so focus is restored AFTER it remounts (effect below) —
  // otherwise focus falls to <body> and keyboard flow leaves the toolbar.
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreTitleFocusRef = useRef(false);
  useEffect(() => {
    if (titleDraft === null && restoreTitleFocusRef.current) {
      restoreTitleFocusRef.current = false;
      titleButtonRef.current?.focus();
    }
  }, [titleDraft]);
  // Enter blurs into this; Escape skips it by clearing the draft first. The
  // onBlur closure is from the latest render, so it always sees the final
  // keystrokes. Empty input still dispatches: the domain command rejects it
  // with the «Название не может быть пустым» toast — same error feedback as
  // an invalid BPM, instead of a silent revert.
  const commitTitleDraft = () => {
    if (titleDraft === null) return;
    const trimmed = titleDraft.trim();
    if (trimmed !== present?.title) dispatch(setTitleCmd(trimmed));
    setTitleDraft(null);
  };
  useEffect(() => {
    setBpmDraft(String(timing.bpm));
  }, [timing.bpm]);

  const [exporting, setExporting] = useState(false);

  const commitBpm = () => {
    const parsed = Number(bpmDraft);
    if (parsed === timing.bpm) return;
    // Reset the draft to the value actually committed, computed once from
    // the parsed draft — re-reading timing.bpm here would flash the stale
    // closure value for one frame before the store update re-renders.
    const committed = dispatch(changeBpmCmd(parsed)) ? parsed : timing.bpm;
    setBpmDraft(String(committed));
  };

  const handleBackupDownload = () => {
    // downloadBackup is fully synchronous: a state-based in-flight flag would
    // batch set(true)+set(false) into one event and never reach a render, so
    // it guarded nothing. Keep the plain handler.
    if (present === null) return;
    downloadBackup(present);
  };

  const handleExport = () => {
    if (present === null || exporting) return;
    if (present.melody.notes.length === 0 && present.harmony.chords.length === 0) {
      dispatch({
        type: 'session/toastPushed',
        payload: {
          toast: {
            id: crypto.randomUUID(),
            kind: 'info',
            message: 'Проект пуст — будет экспортирован корректный пустой MIDI-файл',
          },
        },
      });
    }
    setExporting(true);
    downloadMidi(present)
      .then((result) => {
        if (!result.ok) {
          dispatch({
            type: 'session/toastPushed',
            payload: {
              toast: {
                id: crypto.randomUUID(),
                kind: 'error',
                message: `Не удалось экспортировать MIDI: ${result.error}`,
              },
            },
          });
        } else {
          dispatch({
            type: 'session/toastPushed',
            payload: {
              toast: { id: crypto.randomUUID(), kind: 'success', message: 'MIDI экспортирован' },
            },
          });
        }
      })
      .catch((exportError: unknown) => {
        const detail = exportError instanceof Error ? exportError.message : '';
        // Offline / chunk-fetch failures surface as engine URLs («Importing a
        // module script failed» is Safari's variant); name the actual problem.
        const message = /failed to fetch|importing a module|load failed/i.test(detail)
          ? 'Не удалось загрузить модуль экспорта — проверьте соединение и попробуйте снова'
          : detail
            ? `Не удалось экспортировать MIDI: ${detail}`
            : 'Не удалось экспортировать MIDI';
        dispatch({
          type: 'session/toastPushed',
          payload: {
            toast: {
              id: crypto.randomUUID(),
              kind: 'error',
              message,
            },
          },
        });
      })
      .finally(() => setExporting(false));
  };

  const keyOptions = TONIC_OPTIONS.some(
    (option) => option.letter === context.tonic.letter && option.accidental === context.tonic.accidental,
  )
    ? TONIC_OPTIONS
    : [context.tonic, ...TONIC_OPTIONS];
  const keySelectValue = spelledName(context.tonic);
  return (
    <header className={className === undefined ? 'toolbar' : `toolbar ${className}`}>
      <div className="toolbar-groups">
        {/* The editor is a dead end otherwise: without this the only way
        back to the list is the browser Back button (RevUI-4). */}
        <button type="button" className="toolbar-back" onClick={() => void navigate('/')}>
          ← Проекты
        </button>
        {titleDraft === null ? (
          <button
            ref={titleButtonRef}
            type="button"
            className="toolbar-title"
            title={present?.title ?? ''}
            aria-label="Название проекта — нажмите, чтобы переименовать"
            onClick={() => setTitleDraft(present?.title ?? '')}
          >
            {present?.title ?? '—'}
          </button>
        ) : (
          <input
            className="toolbar-title-input"
            value={titleDraft}
            maxLength={60}
            aria-label="Название проекта"
            autoFocus
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              else if (event.key === 'Escape') {
                restoreTitleFocusRef.current = true;
                setTitleDraft(null);
              }
            }}
            onBlur={commitTitleDraft}
          />
        )}

        <div className="toolbar-group toolbar-tools" role="group" aria-label="Инструменты">
          {TOOL_OPTIONS.map(({ tool, label, testId }) => (
            <button
              key={tool}
              type="button"
              data-testid={testId}
              aria-pressed={activeTool === tool}
              onClick={() => dispatch(setActiveToolCmd(tool))}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-group toolbar-history">
          <button
            type="button"
            disabled={!canUndo}
            onClick={() => dispatch({ type: UNDO_ACTION_TYPE })}
          >
            Отменить
          </button>
          <button
            type="button"
            aria-label="Повторить"
            disabled={!canRedo}
            onClick={() => dispatch({ type: REDO_ACTION_TYPE })}
          >
            Повторить
          </button>
        </div>

        <label className="toolbar-group">
          Тональность{' '}
          <select
            aria-label="Тональность"
            value={keySelectValue}
            onChange={(event) => {
              const parsed = parseSpelled(event.target.value);
              if (parsed !== null) dispatch(transposeToTonicCmd(parsed));
            }}
          >
            {keyOptions.map((tonic) => (
              <option key={spelledName(tonic)} value={spelledName(tonic)}>
                {spelledName(tonic)}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbar-group">
          Лад{' '}
          <select
            aria-label="Лад"
            value={context.mode}
            onChange={(event) => dispatch(setModeCmd(event.target.value as ModeId))}
          >
            {MODE_OPTIONS.map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbar-group">
          BPM{' '}
          <input
            aria-label="Темп BPM"
            type="number"
            min={40}
            max={240}
            /* §3.5: bpm is any number in 40..240 — fractional tempos allowed. */
            step="any"
            value={bpmDraft}
            onChange={(event) => setBpmDraft(event.target.value)}
            onBlur={commitBpm}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitBpm();
            }}
          />
        </label>

        <label className="toolbar-group">
          Паттерн{' '}
          <select
            aria-label="Паттерн по умолчанию"
            value={defaultPattern.kind}
            onChange={(event) =>
              dispatch(
                setDefaultPatternCmd({
                  ...defaultPattern,
                  kind: event.target.value as PatternKind,
                }),
              )
            }
          >
            {PATTERN_KIND_OPTIONS.map((kind) => (
              <option key={kind} value={kind}>
                {PATTERN_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

      </div>

      <div className="toolbar-groups toolbar-row-secondary">
        <TransportControls className="toolbar-group toolbar-transport" />
        <span
          className={`toolbar-save-badge toolbar-save-badge-${saveStatus}`}
          data-testid="save-status"
          data-status={saveStatus}
          role="status"
          aria-live="polite"
        >
          {SAVE_STATUS_LABELS[saveStatus] ?? ''}
        </span>

        <span className="toolbar-hints" aria-hidden="true">
          {`Пробел — воспроизведение · ${UNDO_HINT} — отмена · Delete — удалить · Esc — снять выделение · клик по линейке — перемотка`}
        </span>
        <div className="toolbar-group toolbar-export">
          <button type="button" disabled={present === null || exporting} onClick={handleExport}>
            {/* First export fetches the lazy exporter chunk; on a slow
            connection the disabled-but-unlabeled button reads as a dead
            click, so the label names the in-flight work. */}
            {exporting ? 'Экспорт…' : 'Экспортировать MIDI'}
          </button>
        </div>

      </div>


      {saveStatus === 'error' && (
        <div className="storage-banner" role="alert">
          <span>
            Ошибка сохранения{persistenceError === undefined ? '' : `: ${persistenceError}`}.
            Проект остаётся в памяти.
          </span>
          <button
            type="button"
            disabled={present === null}
            onClick={handleBackupDownload}
          >
            Скачать резервную копию
          </button>
          <button
            type="button"
            disabled={present === null}
            onClick={() => present !== null && getDependencies().projects.retrySave(present)}
          >
            Повторить
          </button>
        </div>
      )}
    </header>
  );
}
