/**
 * Cross-cutting store side effects (§3.16):
 *
 *  1. Autosave — every ACCEPTED document mutation (present reference changed)
 *     marks the session dirty and schedules a debounced save of the present
 *     document through the persistence façade.
 *  2. Live reschedule (§3.17) — an accepted document mutation while the
 *     transport is playing hot-swaps the scheduled playback (updateProject);
 *     only an in-flight «starting» start is stopped.
 *
 * Opening a project is deliberately NOT here: it is the single application
 * use case `openProjectByIdCmd` in @state/commands, which both the list page
 * (pre-navigation validation) and the editor load screen go through.
 */

import { createListenerMiddleware } from '@reduxjs/toolkit';

import { getDependencies } from './dependencies';
import { REDO_ACTION_TYPE, UNDO_ACTION_TYPE } from '@state/historyReducer';
import { REPLACED_FROM_LOAD } from '@state/projectDocumentSlice';
import type { AppDispatch, RootState } from './store';

export const listenerMiddleware = createListenerMiddleware<RootState, AppDispatch>();

/** Accepted document edit = `document/*` action that changed the present doc.
 * Undo/redo also change the present and MUST be persisted, otherwise a
 * reload resurrects the undone state (§3.18 autosave of every accepted
 * mutation). */
function isAcceptedDocumentEdit(
  action: { type: string },
  currentState: RootState,
  previousState: RootState,
): boolean {
  if (currentState.projectHistory.present === previousState.projectHistory.present) return false;
  if (action.type === UNDO_ACTION_TYPE || action.type === REDO_ACTION_TYPE) return true;
  return action.type.startsWith('document/');
}

listenerMiddleware.startListening({
  predicate: isAcceptedDocumentEdit,
  effect: (action, api) => {
    // §3.17: editing during playback re-schedules the live transport from the
    // freshly committed document, so deletions silence instantly and added
    // notes sound without restarting playback. Only an in-flight «starting»
    // start is stopped: stop() bumps the operationId, so the in-flight play()
    // becomes a no-op instead of overriding the edit.
    const status = getDependencies().transport.getSnapshot().status;
    if (status === 'starting') {
      try {
        getDependencies().transport.stop();
      } catch (error) {
        console.error('[listeners] transport.stop failed during live edit', error);
      }
    } else if (status === 'playing') {
      const present = api.getState().projectHistory.present;
      // updateProject never throws (render failures surface as error
      // status), but a defensive catch keeps autosave below reachable even
      // if the transport implementation regresses.
      if (present !== null) {
        try {
          getDependencies().transport.updateProject(present);
        } catch (error) {
          console.error('[listeners] transport.updateProject failed during live edit', error);
        }
      }
    }

    // Loading another project also replaces the present document, so it must
    // stop playback too (§3.17: any document mutation stops the transport).
    // It is not an edit of the current document, though: the previous
    // project's pending work is flushed below, and the load itself never
    // writes — no dirty flag, no autosave reschedule.
    if (action.type === REPLACED_FROM_LOAD) {
      // §3.15/§3.17 project switch: fully reset the transport context — halt
      // any live OR PAUSED playback AND clear the playhead (stop() alone
      // preserves the stored tick, so project B's first Play would resume
      // from project A's playhead). The transport itself skips the engine
      // on a clean idle session, keeping bare dependency stubs untouched.
      getDependencies().transport.reset();

      // §3.15/§3.18 project switch through the façade: it freezes status
      // forwarding for the previous project's saves FIRST (an in-flight or
      // queued run settling later must not paint the new session), then
      // flushes the pending or queued document so the user's last edits on
      // the old project reach storage instead of being silently dropped with
      // the armed debounce timer (§3.16). §3.18 storage error: if promoting
      // the previous project's last edit fails (quota, private-mode
      // IndexedDB), the false outcome must surface as a persistent warning
      // over the new session.
      void getDependencies()
        .projects.flushOnProjectSwitch()
        .then((ok) => {
          if (!ok) {
            api.dispatch({
              type: 'session/persistenceErrorSet',
              payload: { error: 'Не удалось сохранить изменения предыдущего проекта' },
            });
            api.dispatch({ type: 'session/saveStatusSet', payload: { status: 'error' } });
          }
        });
      return;
    }

    const present = api.getState().projectHistory.present;
    if (present === null) return;
    api.dispatch({ type: 'session/saveStatusSet', payload: { status: 'dirty' } });
    getDependencies().projects.scheduleSave(present);
  },
});

/**
 * §3.18 i18n: the storage-error banner interpolates this string into an
 * otherwise Russian sentence («Ошибка сохранения: …»), so raw browser
 * exception text («QuotaExceededError…», «The database connection is
 * closing») must not surface verbatim. Known failure classes map to fixed
 * Russian copy; anything unrecognized passes through unchanged (tests and
 * callers may inject already-Russian reasons).
 */
export function describePersistenceError(message: string): string {
  // `String(new Error(...))` yields «Error: …» — a prefix that carries no
  // information for the user (Dexie/DOM exceptions keep their meaningful
  // name, e.g. «QuotaExceededError: …»).
  const cleaned = message.replace(/^Error:?\s+/, '').trim();
  if (/quota/i.test(cleaned)) return 'хранилище переполнено';
  if (/private|privacy|security/i.test(cleaned)) return 'хранилище недоступно в частном режиме';
  if (/database|indexeddb|connection/i.test(cleaned)) return 'хранилище временно недоступно';
  return cleaned;
}

/**
 * Explicit bootstrap wiring of the persistence façade to a store (§3.18
 * storage error): saveStatus=error + persistent persistenceError message
 * until the next successful save clears it. Called by makeStore right after
 * creation — no global dispatch slot, no autosave callback registry; each
 * store subscribes to the façade that is current at its creation.
 *
 * Stale statuses of a previously opened project are already suppressed
 * INSIDE the façade (flushOnProjectSwitch epoch), so everything delivered
 * here belongs to the current session.
 */
export function subscribePersistenceToStore(dispatch: AppDispatch): () => void {
  return getDependencies().projects.subscribe((event) => {
    dispatch({ type: 'session/saveStatusSet', payload: { status: event.status } });
    // §3.18: the persistence warning must stay visible until the save actually
    // succeeds — clearing it on 'saving'/'dirty' would flicker the banner off
    // ~750 ms after Retry, before the outcome is known.
    if (event.status === 'error') {
      dispatch({
        type: 'session/persistenceErrorSet',
        payload: {
          error: describePersistenceError(event.errorMessage ?? 'Не удалось сохранить проект'),
        },
      });
    } else if (event.status === 'saved') {
      dispatch({ type: 'session/persistenceErrorSet', payload: { error: undefined } });
    }
  });
}

/**
 * §3.22 DoD «проект восстанавливается после перезагрузки страницы»: edits
 * made inside the debounce window must not be lost when the page goes away.
 * `visibilitychange → hidden` is the reliable trigger for IndexedDB writes
 * (mobile browsers kill the tab before `beforeunload`); `beforeunload` is a
 * belt-and-suspenders second chance on desktop; `pagehide` covers iOS Safari
 * in-app navigations and process kills where neither of the other two is
 * guaranteed. The flush is fire-and-forget: an in-flight promise never blocks
 * unload (§3.16 — stale-generation suppression inside the façade keeps late
 * completions from clobbering newer state).
 *
 * Returns an unregister function so tests (and any future teardown) can
 * remove the listeners without leaking them.
 */
export function registerAutosaveFlushTriggers(): () => void {
  const flush = (): void => {
    void getDependencies().projects.flushBeforeUnload();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('beforeunload', flush);
    window.removeEventListener('pagehide', flush);
  };
}
