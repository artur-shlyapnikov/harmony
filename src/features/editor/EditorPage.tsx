/**
 * Editor page (§3.20 main screen): toolbar on top, MelodyLane + ChordLane
 * inside a shared TimelineViewport, suggestions/inspector strip at the
 * bottom, ToastHost mounted for session-wide messages.
 *
 * Load flow (§3.18): `openProjectByIdCmd` is the single open use case — the
 * persistence façade returns a normalized, ready-to-commit document (or a
 * stable failure kind); this page only maps kinds onto its load-screen
 * states and never touches the repository or error classes itself.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDependencies } from '@app/dependencies';
import { useAppDispatch, useAppSelector } from '@app/hooks';
import type { AppDispatch } from '@app/store';
import { ChordInspector } from '@features/chords/ChordInspector';
import { NoteInspector } from '@features/notes/NoteInspector';
import { EditorToolbar } from '@features/editor/EditorToolbar';
import { useEditorShortcuts } from '@features/editor/useEditorShortcuts';
import { Playhead } from '@features/editor/Playhead';
import { TimelineViewport } from '@features/editor/TimelineViewport';
import { SuggestionPanel } from '@features/suggestions/SuggestionPanel';
import { openProjectByIdCmd, setActiveToolCmd } from '@state/commands';
import {
  selectChords,
  selectMelodyNotes,
  selectPresentProject,
  selectSelection,
} from '@state/selectors';
import {
  CLASSIFICATION_FILL,
  CLASSIFICATION_TITLE,
} from '@features/editor/NoteBlock';
import type { NoteClassification } from '@domain/theory/noteAnalysis';
import { ConfirmDialogProvider, useConfirm } from '@shared/ConfirmDialog';
import { ToastHost } from '@shared/ToastHost';

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'corrupt'; raw: unknown; reason: string };


function downloadRawJson(projectId: string, raw: unknown): void {
  const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${projectId}.json`;
  anchor.click();
  // Defer until the click has fully processed — revoking synchronously can
  // abort the download in some browsers (same pattern as backup.ts).
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Session error toast (same mechanism as ProjectListPage). */
function pushErrorToast(dispatch: AppDispatch, message: string): void {
  dispatch({
    type: 'session/toastPushed',
    payload: { toast: { id: crypto.randomUUID(), kind: 'error', message } },
  });
}

/** Ordered for the legend: consonant → dissonant → outside. */
const LEGEND_ORDER: readonly NoteClassification[] = [
  'chordTone',
  'availableTension',
  'scaleTone',
  'chromatic',
  'unscored',
];

/** Idle strip: action hint + note-color legend; onboarding while empty. */
function IdleStrip() {
  const notes = useAppSelector(selectMelodyNotes);
  const chords = useAppSelector(selectChords);
  const isEmpty = notes.length === 0 && chords.length === 0;
  return (
    <div className="editor-idle">
      <p className="inspector-hint">
        Выберите ноту или аккорд на дорожке, либо диапазон на «Гармонии» —
        для подсказок.
      </p>
      <ul className="classification-legend" aria-label="Цветовая разметка нот">
        {LEGEND_ORDER.map((classification) => (
          <li key={classification}>
            <span
              className="legend-swatch"
              style={{ backgroundColor: CLASSIFICATION_FILL[classification] }}
            />
            {CLASSIFICATION_TITLE[classification]}
          </li>
        ))}
      </ul>
      {isEmpty && (
        <ol className="onboarding-steps" aria-label="С чего начать">
          <li>Инструментом «Нота» нарисуйте мелодию на верхней дорожке</li>
          <li>Выделите диапазон на «Гармонии» — появятся подсказки аккордов</li>
          <li>Пробел — воспроизведение</li>
        </ol>
      )}
    </div>
  );
}

/** Bottom strip (§3.20): range selection → suggestions, otherwise inspector. */
function BottomStrip() {
  const selection = useAppSelector(selectSelection);

  if (selection?.kind === 'range') {
    return <SuggestionPanel />;
  }
  if (selection?.kind === 'note') {
    return <NoteInspector />;
  }
  if (selection?.kind === 'chord') {
    return <ChordInspector />;
  }
  return <IdleStrip />;
}

function CorruptPanel({
  projectId,
  reason,
  raw,
}: {
  projectId: string;
  reason: string;
  raw: unknown;
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const confirm = useConfirm();

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: 'Удаление повреждённого проекта',
      message:
        'Удалить повреждённый проект? Сначала можно скачать его данные как JSON — действие необратимо.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await getDependencies().projects.delete(projectId);
      void navigate('/');
    } catch (deleteError) {
      // PL-1: a rejected delete (IndexedDB/quota) must keep the user on the
      // corrupt panel — they can retry or download JSON first — with the same
      // session error-toast feedback as ProjectListPage.handleDelete.
      pushErrorToast(
        dispatch,
        deleteError instanceof Error
          ? `Не удалось удалить проект: ${deleteError.message}`
          : 'Не удалось удалить проект',
      );
    }
  };

  return (
    <main className="page" role="alert">
      <h1>Проект повреждён</h1>
      <p>
        Не удалось открыть проект: {reason}. Сохранённые данные не перезаписаны — их можно
        скачать как JSON, удалить или создать новый проект.
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={() => downloadRawJson(projectId, raw)}>
          Скачать JSON
        </button>
        <button type="button" onClick={() => { void navigate('/', { state: { newProject: true } }); }}>
          Создать новый
        </button>
        <button type="button" className="button-danger" onClick={() => void handleDelete()}>
          Удалить повреждённый проект
        </button>
      </div>
      <ToastHost />
    </main>
  );
}

function EditorContent() {
  // Keyboard shortcuts (§3.20): installed once for the editor's lifetime.
  useEditorShortcuts();
  const present = useAppSelector(selectPresentProject);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });

    if (id === undefined) {
      setState({ kind: 'error', message: 'Не указан идентификатор проекта' });
      return undefined;
    }

    void openProjectByIdCmd(id)(dispatch).then((result) => {
      if (cancelled || result.kind === 'stale') return;
      switch (result.kind) {
        case 'ok': {
          const document = result.document;
          // An empty score opens ready-to-draw: the onboarding strip's first
          // step says «Инструментом „Нота“», so the active tool must match —
          // the generic 'select' default left the first lane click dead
          // (§3.15). Runs once per open, never re-asserts afterwards.
          if (document.melody.notes.length === 0 && document.harmony.chords.length === 0) {
            dispatch(setActiveToolCmd('drawNote'));
          }
          setState({ kind: 'ready' });
          break;
        }
        case 'corrupt':
        case 'unsupported':
          setState({
            kind: 'corrupt',
            raw: result.raw,
            // Raw zod/repository dumps must not surface mid-Russian-sentence;
            // the technical detail stays available via «Скачать JSON».
            reason: 'структура проекта не соответствует ожидаемой',
          });
          break;
        case 'notFound':
          // Deleted elsewhere / stale direct URL: the raw English diagnostic
          // must not surface; the panel copy stays Russian.
          setState({ kind: 'error', message: 'Проект не найден' });
          break;
        case 'storageError':
          setState({
            kind: 'error',
            message:
              result.cause instanceof Error ? result.cause.message : 'Не удалось открыть проект',
          });
          break;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, id]);

  // Tab title carries the project name: with several projects open in
  // browser tabs every one read «Harmonic Editor». Follows renames live
  // (title lives in the present document); restores the base on unmount.
  useEffect(() => {
    const base = 'Harmonic Editor';
    document.title = state.kind === 'ready' && present ? `${present.title} · ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [present, state.kind]);

  // Leaving the editor surface halts playback (§3.17): the project list has
  // no transport UI, so a running transport would keep sounding with no
  // indicator and no way to stop it. stop() preserves the playhead (§3.16),
  // so returning to the same project resumes where it left off; opening a
  // different project then resets the session as usual (REPLACED_FROM_LOAD).
  useEffect(() => {
    const { transport } = getDependencies();
    // Teardown is best-effort and never throws (same contract as the title
    // restore above): test doubles may stub the transport minimally.
    return () => transport.stop?.();
  }, []);

  if (state.kind === 'loading') {
    return (
      <main className="page">
        <p>Загрузка проекта…</p>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="page" role="alert">
        <h1>Проект не открыт</h1>
        <p>{state.message}</p>
        <button type="button" onClick={() => { void navigate('/'); }}>
          К списку проектов
        </button>
        <ToastHost />
      </main>
    );
  }

  if (state.kind === 'corrupt') {
    return <CorruptPanel projectId={id ?? ''} reason={state.reason} raw={state.raw} />;
  }

  return (
    <div className="editor-page">
      {/* Heading structure (§3.20): list and error states carry an h1; the
         ready editor had none, leaving screen readers without a page
         heading. Visually hidden — the toolbar title input stays the
         visible name surface. Prefixed so exact-text queries for the bare
         title (storage banner copy shares scenario names) stay unique. */}
      <h1 className="sr-only">{present ? `Проект «${present.title}»` : 'Редактор'}</h1>
      <EditorToolbar />
      <div className="editor-body">
        <TimelineViewport className="editor-lanes">
          <Playhead />
        </TimelineViewport>
        <section className="editor-bottom">
          <BottomStrip />
        </section>
      </div>
      <ToastHost />
    </div>
  );
}

export function EditorPage() {
  return (
    <ConfirmDialogProvider>
      <EditorContent />
    </ConfirmDialogProvider>
  );
}
