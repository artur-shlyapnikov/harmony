/**
 * Transport controls (§3.17): Play / Pause / Stop + status display.
 *
 * All buttons go through the ProjectTransport façade — this component knows
 * transport operations, not the play protocol. Status comes from the
 * framework-external TransportStore (via the transport's subscription) with
 * useSyncExternalStore (NOT Redux). Retry Audio is rendered only in the error
 * state (§3.21 AudioContext unavailable).
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { getDependencies } from '@app/dependencies';
import { useAppSelector } from '@app/hooks';
import { getProjectTransport, type TransportStatus } from '@audio/projectTransport';
import { selectPresentProject } from '@state/selectors';

const transport = getProjectTransport();

const STATUS_LABEL: Record<TransportStatus, string> = {
  idle: 'Готов к воспроизведению',
  starting: 'Запуск аудио…',
  playing: 'Воспроизведение',
  paused: 'Пауза',
  error: 'Ошибка звука',
};

export type TransportControlsProps = {
  className?: string;
};

export function TransportControls({ className }: TransportControlsProps) {
  const snapshot = useSyncExternalStore(transport.subscribe, transport.getSnapshot);
  const project = useAppSelector(selectPresentProject);
  // Handlers go through the DI container (test seam); the snapshot pair uses
  // the shared singleton — both wrap the same underlying TransportStore.
  const { transport: depsTransport } = getDependencies();

  const handlePlay = (): void => {
    if (project === null) return;
    void depsTransport.play(project);
  };

  const handlePause = (): void => {
    depsTransport.pause();
  };

  const handleStop = (): void => {
    depsTransport.stop();
  };

  const handleRetry = (): void => {
    void depsTransport.retry();
  };

  const { status } = snapshot;
  // «Повторить звук» exists only in the error state; when the status leaves
  // it while that button holds focus, focus would drop to document.body.
  // Park it on Play instead.
  const playRef = useRef<HTMLButtonElement | null>(null);
  const prevStatus = useRef<TransportStatus>(status);
  useEffect(() => {
    const wasError = prevStatus.current === 'error';
    prevStatus.current = status;
    if (!wasError || status === 'error') return;
    if (document.activeElement === document.body) {
      playRef.current?.focus();
    }
  }, [status]);

  return (
    <div className={className} role="group" aria-label="Транспорт">
      <button
        ref={playRef}
        type="button"
        onClick={handlePlay}
        disabled={status === 'playing' || status === 'starting' || project === null}
        aria-label="Играть"
      >
        Играть
      </button>
      <button
        type="button"
        onClick={handlePause}
        disabled={status !== 'playing'}
        aria-label="Пауза"
      >
        Пауза
      </button>
      <button type="button" onClick={handleStop} disabled={status === 'idle'} aria-label="Стоп">
        Стоп
      </button>
      <span
        className={`transport-status transport-status-${status}`}
        data-testid="transport-status"
        data-status={status}
        aria-live="polite"
        aria-atomic="true"
      >
        {STATUS_LABEL[status]}
        {status === 'error' && snapshot.errorMessage !== undefined ? `: ${snapshot.errorMessage}` : ''}
      </span>
      {status === 'error' && (
        <button type="button" onClick={handleRetry} aria-label="Повторить звук">
          Повторить звук
        </button>
      )}
    </div>
  );
}
