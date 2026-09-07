import type { Action } from 'redux';

/**
 * Session slice (§3.15): everything that must NOT live in undo history —
 * selection, tool, viewport, save status, persistence error, toasts.
 */

import type { ProjectDocumentV1, Tick } from '@domain/model/project';

export type SessionSelection =
  | { kind: 'note'; id: string }
  | { kind: 'chord'; id: string }
  | { kind: 'range'; startTick: Tick; durationTicks: Tick }
  | null;

export type ActiveTool = 'select' | 'drawNote' | 'drawChord';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export type ViewportState = {
  scrollTick: Tick;
  zoomPxPerBeat: number;
  melodyCenterMidi: number;
};

export type ToastKind = 'error' | 'info' | 'success';

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
};

export const DEFAULT_VIEWPORT: ViewportState = Object.freeze({
  scrollTick: 0,
  zoomPxPerBeat: 40,
  melodyCenterMidi: 72,
});

// NOTE: `toasts` below deviates from §3.15's literal SessionState shape —
// sanctioned by the §4 ownership table (ToastHost ← 'session state').
export type SessionState = {
  activeProjectId?: string;
  selection: SessionSelection;
  activeTool: ActiveTool;
  viewport: ViewportState;
  saveStatus: SaveStatus;
  persistenceError?: string;
  toasts: Toast[];
};

export const INITIAL_SESSION_STATE: SessionState = {
  selection: null,
  activeTool: 'select',
  viewport: DEFAULT_VIEWPORT,
  saveStatus: 'idle',
  toasts: [],
};

export type SessionAction =
  | { type: 'session/selectionSet'; payload: { selection: SessionSelection } }
  | { type: 'session/activeToolSet'; payload: { tool: ActiveTool } }
  | { type: 'session/viewportChanged'; payload: Partial<ViewportState> }
  | { type: 'session/saveStatusSet'; payload: { status: SaveStatus } }
  | { type: 'session/persistenceErrorSet'; payload: { error?: string } }
  | { type: 'session/toastPushed'; payload: { toast: Toast } }
  | { type: 'session/toastDismissed'; payload: { id: string } }
  | { type: 'session/projectOpened'; payload: { projectId: string } };

export function isSessionAction(action: Action): action is SessionAction {
  return action.type.startsWith('session/');
}

export function sessionReducer(
  state: SessionState = INITIAL_SESSION_STATE,
  action: Action,
): SessionState {
  if (!isSessionAction(action)) return state;
  switch (action.type) {
    case 'session/selectionSet':
      return { ...state, selection: action.payload.selection };

    case 'session/activeToolSet':
      return { ...state, activeTool: action.payload.tool };

    case 'session/viewportChanged':
      return { ...state, viewport: { ...state.viewport, ...action.payload } };


    case 'session/saveStatusSet':
      return { ...state, saveStatus: action.payload.status };

    case 'session/persistenceErrorSet': {
      if (action.payload.error === undefined) {
        const { persistenceError: _cleared, ...rest } = state;
        return rest;
      }
      return { ...state, persistenceError: action.payload.error };
    }

    case 'session/toastPushed': {
      // An identical live toast (kind + message) is replaced, not stacked:
      // a burst of the same failure (re-tapped bounded key, retried save)
      // must read as one persistent alert. The replacement's fresh id also
      // restarts the auto-dismiss timer; the stale timer's later dismiss is
      // a no-op filter.
      const { toast } = action.payload;
      const existing = state.toasts.findIndex(
        (candidate) =>
          candidate.kind === toast.kind && candidate.message === toast.message,
      );
      if (existing === -1) {
        return { ...state, toasts: [...state.toasts, toast] };
      }
      const toasts = state.toasts.slice();
      toasts[existing] = toast;
      return { ...state, toasts };
    }

    case 'session/toastDismissed':
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.payload.id) };

    case 'session/projectOpened': {
      // §3.15: fresh open = idle, and toasts are per-project surface state —
      // like saveStatus/persistenceError they must not bleed across projects.
      // §3.18: the storage-error banner describes THE current project's
      // failed save, so stale error state from a previous project must not survive.
      const { saveStatus: _staleStatus, persistenceError: _staleError, ...rest } = state;
      return { ...rest, saveStatus: 'idle', toasts: [], activeProjectId: action.payload.projectId };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selection coherence (§3.15, SEL-1)
// ---------------------------------------------------------------------------

/**
 * The ONLY selection-repair mechanism: drops a selection whose target id no
 * longer exists in the present document (deleted events, and chords absorbed
 * by the §3.7 merge pass). Applied at ONE root-state choke point (see
 * rootReducer in store.ts) after EVERY present change — commit, undo, redo,
 * load — so delete/merge command paths never hand-clean selection.
 *
 * `clearRange` implements the §3.20 range-delete semantics: a successful
 * deleteEventsInRange leaves the highlighted range empty, so the range
 * selection goes with it.
 */
export function reconcileSelection(
  selection: SessionSelection,
  present: ProjectDocumentV1,
  opts: { clearRange?: boolean } = {},
): SessionSelection {
  if (selection === null) return null;
  if (opts.clearRange === true && selection.kind === 'range') return null;
  if (
    selection.kind === 'note' &&
    !present.melody.notes.some((note) => note.id === selection.id)
  ) {
    return null;
  }
  if (
    selection.kind === 'chord' &&
    !present.harmony.chords.some((chord) => chord.id === selection.id)
  ) {
    return null;
  }
  return selection;
}
