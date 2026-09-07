/**
 * Project document reducer (§3.5 document).
 *
 * Per-command business rules live in @domain/editing (the ProjectEditor) —
 * this reducer only:
 *   1. installs wholesale replacements (`document/replacedFromLoad`, the
 *      non-undoable load path — the history wrapper clears past/future);
 *   2. commits editor-approved documents (`document/documentCommitted`) with
 *      a fresh `updatedAt` — wall-clock stamping is state-layer ownership;
 *   3. keeps the §3.7 step 8 generic invariant sweep as DEFENSE-IN-DEPTH.
 *      Commands dispatch a commit only after applyProjectEdit accepted it,
 *      so the sweep below rejects structurally invalid documents that could
 *      only arrive through a bug — it must not (and does not) re-implement
 *      any editor policy.
 */

import type { Action } from 'redux';

import type { ProjectDocumentV1 } from '@domain/model/project';
import {
  committedDocumentViolations,
  type InvariantViolation,
} from '@domain/timeline/invariants';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export const DOCUMENT_COMMITTED = 'document/documentCommitted';
export const REPLACED_FROM_LOAD = 'document/replacedFromLoad';

export type DocumentAction =
  /** Carries an already-validated editor result; `editKind` feeds the root
   *  selection-reconcile choke point (see store.ts). */
  | { type: typeof DOCUMENT_COMMITTED; payload: { project: ProjectDocumentV1; editKind: string } }
  | { type: typeof REPLACED_FROM_LOAD; payload: { project: ProjectDocumentV1 } };

export function isDocumentAction(action: Action): action is DocumentAction {
  return action.type.startsWith('document/');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimestamp(doc: ProjectDocumentV1): ProjectDocumentV1 {
  return { ...doc, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function documentReducer(
  state: ProjectDocumentV1 | null | undefined,
  action: Action,
): ProjectDocumentV1 | null {
  if (!isDocumentAction(action)) return state ?? null;

  // Non-undoable load path: wholesale replacement, verbatim (no timestamp —
  // the loaded document carries its own).
  if (action.type === REPLACED_FROM_LOAD) {
    return action.payload.project;
  }
  if (state === null || state === undefined) return null;

  const next = withTimestamp(action.payload.project);

  // §3.7 step 8 defense-in-depth: a committed document must satisfy the
  // §3.4 lane invariants. Unreachable via commands (applyProjectEdit runs
  // the identical sweep before approving), kept so a future caller cannot
  // smuggle an invalid document into history. Reasons are logged in DEV.
  //
  // The sweep shares committedDocumentViolations with the editor gate: the
  // kinds a schema-valid load can carry ('out_of_bounds' per §3.18 step 5,
  // 'overlap' because normalization tolerates overlaps) stay EXCLUDED so a
  // legally loaded document still accepts edits.
  const violations: readonly InvariantViolation[] = committedDocumentViolations(next);
  if (violations.length > 0) {
    if (import.meta.env.DEV) {
      console.error(
        `[projectDocumentSlice] §3.4 invariant violations rejected ${action.type}:`,
        violations,
      );
    }
    return state;
  }

  return next;
}
