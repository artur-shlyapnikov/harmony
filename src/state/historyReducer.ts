/**
 * Undo/redo wrapper over the document reducer (§3.8).
 *
 * History stores only `ProjectDocumentV1` snapshots — never session state.
 * All `document/*` actions are undoable except `document/replacedFromLoad`,
 * which resets past/future (loading a project is not an undoable edit).
 *
 * Success/failure is decided BEFORE dispatch: command shells only dispatch
 * `document/documentCommitted` after applyProjectEdit returned `applied`,
 * so every commit action unconditionally pushes a history entry. There is
 * deliberately NO reference-equality rejection inference here anymore.
 */

import type { Action, Reducer } from 'redux';

import type { ProjectDocumentV1 } from '@domain/model/project';
import { MAX_UNDO_ENTRIES } from '@domain/timeline/constants';
import { DOCUMENT_COMMITTED, REPLACED_FROM_LOAD } from './projectDocumentSlice';

export const UNDO_ACTION_TYPE = 'history/undo';
export const REDO_ACTION_TYPE = 'history/redo';

export type ProjectHistoryState = {
  past: ProjectDocumentV1[];
  present: ProjectDocumentV1 | null;
  future: ProjectDocumentV1[];
};

const EMPTY_HISTORY: ProjectHistoryState = { past: [], present: null, future: [] };

export function createProjectHistoryReducer(
  documentReducer: Reducer<ProjectDocumentV1 | null, Action>,
): Reducer<ProjectHistoryState, Action> {
  return (state: ProjectHistoryState = EMPTY_HISTORY, action: Action): ProjectHistoryState => {
    if (action.type === UNDO_ACTION_TYPE) {
      if (state.present === null || state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1]!;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      };
    }

    if (action.type === REDO_ACTION_TYPE) {
      if (state.present === null || state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      // Belt-and-braces: past can never exceed MAX_UNDO_ENTRIES via REDO
      // (UNDO decremented it first, and mutations cap + clear future), so
      // the same splice as the mutation branch is unreachable today. Kept
      // for symmetry so a future refactor cannot silently regress the cap.
      const past = [...state.past, state.present];
      if (past.length > MAX_UNDO_ENTRIES) {
        past.splice(0, past.length - MAX_UNDO_ENTRIES);
      }
      return { past, present: next!, future: rest };
    }

    if (action.type === REPLACED_FROM_LOAD) {
      // Loading replaces everything and is not undoable.
      return {
        past: [],
        present: documentReducer(state.present, action),
        future: [],
      };
    }

    if (action.type === DOCUMENT_COMMITTED) {
      if (state.present === null) return state;
      // The inner reducer stamps `updatedAt` and runs the §3.4 sweep as
      // defense-in-depth; that sweep rejecting is unreachable-by-construction
      // (the editor validated with the same code), and history intentionally
      // does NOT re-derive its decision from document identity.
      const past = [...state.past, state.present];
      if (past.length > MAX_UNDO_ENTRIES) {
        past.splice(0, past.length - MAX_UNDO_ENTRIES);
      }
      return { past, present: documentReducer(state.present, action), future: [] };
    }

    return state;
  };
}
