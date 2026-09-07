/**
 * Project library page (§3.18): lists projects (updatedAt desc), opens them
 * in the editor, creates new ones via NewProjectDialog, duplicates and
 * deletes with confirmation. A project that fails validation on open is
 * marked corrupt and offers the §3.18 recovery trio: download raw JSON,
 * create a new project, delete the corrupt one.
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getDependencies } from '@app/dependencies';
import { openProjectByIdCmd } from '@state/commands';
import { useAppDispatch } from '@app/hooks';
import type { ProjectSummary } from '@domain/model/project';
import {
  ConfirmDialogProvider,
  useConfirm,
} from '@shared/ConfirmDialog';
import { formatModifiedRu, MODE_LABELS, pluralRu } from '@shared/labels';
import { ToastHost } from '@shared/ToastHost';
import { NewProjectDialog } from './NewProjectDialog';

/** List-row meta line: «C ионийский (мажор) · 16 тактов · 3 аккорда, 2 ноты».
 * Zero counts drop out — «0 аккордов» adds nothing a musician wants to know. */
function summaryMetaLine(meta: NonNullable<ProjectSummary['meta']>): string {
  const parts = [`${meta.tonic} ${MODE_LABELS[meta.mode].toLowerCase()}`];
  parts.push(`${meta.bars} ${pluralRu(meta.bars, 'такт', 'такта', 'тактов')}`);
  const counts = [
    meta.chordCount > 0
      ? `${meta.chordCount} ${pluralRu(meta.chordCount, 'аккорд', 'аккорда', 'аккордов')}`
      : null,
    meta.noteCount > 0 ? `${meta.noteCount} ${pluralRu(meta.noteCount, 'нота', 'ноты', 'нот')}` : null,
  ].filter((part) => part !== null);
  if (counts.length > 0) parts.push(counts.join(', '));
  return parts.join(' · ');
}

type CorruptRow = {
  projectId: string;
  raw: unknown;
  reason: string;
};

function pushErrorToast(dispatch: ReturnType<typeof useAppDispatch>, message: string): void {
  dispatch({
    type: 'session/toastPushed',
    payload: { toast: { id: crypto.randomUUID(), kind: 'error', message } },
  });
}

/** Triggers a client-side download of arbitrary raw JSON. */
function downloadRawJson(projectId: string, raw: unknown): void {
  const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${projectId}.json`;
  // Detached anchor.click() is ignored by Firefox/Safari: attach first
  // (same pattern as downloadMidi.ts).
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer until the click has fully processed — revoking synchronously can
  // abort the download in some browsers (same pattern as backup.ts).
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ProjectList() {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const confirm = useConfirm();

  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(
    (location.state as { newProject?: boolean } | null)?.newProject === true,
  );
  const [corrupt, setCorrupt] = useState<CorruptRow | null>(null);

  const refresh = useCallback(() => {
    return getDependencies()
      .projects.list()
      .then((rows) => setSummaries([...rows]))
      .catch((listError: unknown) => {
        pushErrorToast(
          dispatch,
          listError instanceof Error
            ? `Не удалось загрузить список проектов: ${listError.message}`
            : 'Не удалось загрузить список проектов',
        );
        setSummaries([]);
      });
  }, [dispatch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = (id: string) => {
    // Single open use case (§3.18): validates BEFORE navigating, so a corrupt
    // record is caught here on the list page instead of mid-editor.
    void openProjectByIdCmd(id)(dispatch).then((result) => {
      if (result.kind === 'stale') return;
      if (result.kind === 'ok') {
        void navigate(`/project/${id}`);
      } else if (result.kind === 'corrupt' || result.kind === 'unsupported') {
        setCorrupt({
          projectId: result.projectId,
          raw: result.raw,
          reason: result.reason,
        });
      } else if (result.kind === 'notFound') {
        pushErrorToast(dispatch, 'Проект не найден');
      } else {
        pushErrorToast(
          dispatch,
          result.cause instanceof Error
            ? `Не удалось открыть проект: ${result.cause.message}`
            : 'Не удалось открыть проект',
        );
      }
    });
  };

  const handleDuplicate = async (summary: ProjectSummary) => {
    const confirmed = await confirm({
      title: 'Копия проекта',
      message: `Создать копию проекта «${summary.title}»?`,
      confirmLabel: 'Создать копию',
    });
    if (!confirmed) return;
    const result = await getDependencies().projects.duplicate(
      summary.id,
      `${summary.title} (копия)`,
    );
    if (result.kind === 'ok') {
      await refresh();
    } else if (result.kind === 'notFound') {
      pushErrorToast(dispatch, 'Проект не найден');
    } else {
      pushErrorToast(
        dispatch,
        result.cause instanceof Error
          ? `Не удалось создать копию проекта: ${result.cause.message}`
          : 'Не удалось создать копию проекта',
      );
    }
  };

  const handleDelete = async (summary: ProjectSummary) => {
    const confirmed = await confirm({
      title: 'Удаление проекта',
      message: `Удалить проект «${summary.title}»? Действие необратимо.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await getDependencies().projects.delete(summary.id);
      if (corrupt?.projectId === summary.id) setCorrupt(null);
      await refresh();
    } catch (deleteError) {
      pushErrorToast(
        dispatch,
        deleteError instanceof Error
          ? `Не удалось удалить проект: ${deleteError.message}`
          : 'Не удалось удалить проект',
      );
    }
  };

  const corruptRow = summaries?.find((row) => row.id === corrupt?.projectId);

  return (
    <main className="page project-list-page">
      <div className="project-list-header">
        <h1>Проекты</h1>
        <button type="button" className="button-primary" onClick={() => setDialogOpen(true)}>
          Новый проект
        </button>
      </div>

      {summaries === null ? (
        <p>Загрузка…</p>
      ) : summaries.length === 0 ? (
        <div className="empty-state" data-testid="empty-state">
          <p>Пока нет ни одного проекта — создайте первый.</p>
          <p className="empty-state-hint">
            Выберите тональность и лад, добавьте аккорды подсказками и наиграйте мелодию.
          </p>
          <button type="button" className="button-primary" onClick={() => setDialogOpen(true)}>
            Создать первый проект
          </button>
        </div>
      ) : (
        <ul className="project-list">
          {summaries.map((summary) => (
            <li
              key={summary.id}
              className="project-row"
              onClick={() => handleOpen(summary.id)}
            >
              <span className="project-row-main">
                <button
                  type="button"
                  className="project-row-title"
                  data-testid="project-row-title"
                  onClick={(event) => {
                    // The row <li> also opens on click — handle it once.
                    event.stopPropagation();
                    handleOpen(summary.id);
                  }}
                >
                  {summary.title}
                </button>
                {summary.meta && (
                  <span className="project-row-subtitle" data-testid="project-row-subtitle">
                    {summaryMetaLine(summary.meta)}
                  </span>
                )}
              </span>
              <span className="project-row-meta">
                Изменён: {formatModifiedRu(summary.updatedAt)}
              </span>
              {corrupt?.projectId === summary.id && (
                <span className="badge-corrupt" role="status">
                  Повреждён
                </span>
              )}
              <span
                className="project-row-actions"
                onClick={(event) => event.stopPropagation()}
              >
                <button type="button" onClick={() => handleOpen(summary.id)}>
                  Открыть
                </button>
                <button type="button" onClick={() => void handleDuplicate(summary)}>
                  Копия
                </button>
                <button
                  type="button"
                  className="button-danger"
                  onClick={() => void handleDelete(summary)}
                >
                  Удалить
                </button>
              </span>

              {corrupt !== null && corrupt.projectId === summary.id && (
                <div
                  className="corrupt-panel"
                  role="alert"
                  onClick={(event) => event.stopPropagation()}
                >
                  <p>
                    Не удалось открыть проект: {corrupt.reason}. Сохранённые данные не
                    перезаписаны — их можно скачать как JSON.
                  </p>
                  <div className="dialog-actions">
                    <button
                      type="button"
                      onClick={() => downloadRawJson(corrupt.projectId, corrupt.raw)}
                    >
                      Скачать JSON
                    </button>
                    <button type="button" onClick={() => setDialogOpen(true)}>
                      Создать новый
                    </button>
                    <button
                      type="button"
                      className="button-danger"
                      onClick={() => void handleDelete(summary)}
                    >
                      Удалить повреждённый
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {summaries !== null && summaries.length > 0 && (
        <p className="help-text" data-testid="lww-note">
        <span className="help-icon" aria-hidden="true">
          ℹ
        </span>{' '}
        Один и тот же проект можно открыть в нескольких вкладках браузера, но одновременное
        редактирование не поддерживается: при сохранении последняя записанная версия
        перезаписывает предыдущую.
        </p>
      )}

      {corruptRow === undefined && corrupt !== null && summaries !== null && (
        <p className="help-text" role="status">
          Повреждённый проект больше не отображается в списке.
        </p>
      )}

      <NewProjectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ToastHost />
    </main>
  );
}

export function ProjectListPage() {
  return (
    <ConfirmDialogProvider>
      <ProjectList />
    </ConfirmDialogProvider>
  );
}
