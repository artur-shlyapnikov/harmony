/**
 * Redux store (§3.15).
 *
 * Reducers:
 * - `projectHistory` — undo/redo wrapper around the pure document reducer;
 * - `session` — selection/tool/viewport/save/toast state (never in history).
 *
 * The root reducer is also the single selection-reconcile choke point: after
 * every present change (commit, undo, redo, load) the session selection is
 * reconciled against the new present document (see rootReducer below).
 *
 * Middleware decision: the default stack stays on, including
 * `serializableCheck` — every action payload and both state slices are plain
 * JSON-serializable data (documents, ticks, strings), nothing non-serializable
 * (Tone.js nodes, AudioContext, DOM) is ever dispatched or stored per §3.15.
 * `immutableCheck` is off: it deep-walks the entire state tree on every
 * dispatch, and the undo history alone holds up to 100 documents, making each
 * keystroke O(history) in production. Reducer purity is enforced structurally
 * instead — pure reducers, the domainPurity architecture gate, and undo/redo
 * round-trip equality tests.
 */
import {
  combineReducers,
  configureStore,
  type Action,
  type Store,
  type ThunkDispatch,
  type UnknownAction,
} from '@reduxjs/toolkit';
import { listenerMiddleware, subscribePersistenceToStore } from './listeners';
import {
  DOCUMENT_COMMITTED,
  documentReducer,
  type DocumentAction,
  REPLACED_FROM_LOAD,
} from '@state/projectDocumentSlice';
import {
  createProjectHistoryReducer,
  REDO_ACTION_TYPE,
  UNDO_ACTION_TYPE,
  type ProjectHistoryState,
} from '@state/historyReducer';
import {
  reconcileSelection,
  sessionReducer,
  type SessionState,
} from '@state/sessionSlice';

/** Root state shape pinned to §3.15. */
export type RootState = {
  projectHistory: ProjectHistoryState;
  session: SessionState;
};

/**
 * Declared independently of the store instance (ThunkDispatch matches
 * configureStore's default-middleware dispatch) so listener middleware can
 * reference it without an inference cycle.
 */
export type AppDispatch = ThunkDispatch<RootState, undefined, UnknownAction>;

/** Concrete store contract (§3.15) — named here rather than inferred off the factory. */
export type AppStore = Store<RootState, UnknownAction> & { dispatch: AppDispatch };

// ---------------------------------------------------------------------------
// Selection-reconcile choke point (§3.15, SEL-1)
// ---------------------------------------------------------------------------

const combinedReducer = combineReducers({
  projectHistory: createProjectHistoryReducer(documentReducer),
  session: sessionReducer,
});

/**
 * The ONE place selection is repaired: after EVERY present-changing action —
 * commit, undo, redo, load — the session selection is reconciled against the
 * new present document via {@link reconcileSelection}. Delete/merge command
 * paths therefore never hand-clean selection. Non-present actions fall
 * through untouched.
 */
function rootReducer(state: RootState | undefined, action: Action): RootState {
  const next = combinedReducer(state, action);
  switch (action.type) {
    case DOCUMENT_COMMITTED:
      // §3.20: a successful range delete empties the highlighted range —
      // its range selection goes with it.
      return withReconciledSelection(next, {
        clearRange:
          (action as Extract<DocumentAction, { type: typeof DOCUMENT_COMMITTED }>).payload
            .editKind === 'deleteEventsInRange',
      });
    case UNDO_ACTION_TYPE:
    case REDO_ACTION_TYPE:
      return withReconciledSelection(next);
    case REPLACED_FROM_LOAD:
      // §3.15: selection is session-bound to the current project — stale ids
      // from the previous document must not survive a load.
      if (next.session.selection === null) return next;
      return { ...next, session: { ...next.session, selection: null } };
    default:
      return next;
  }
}

function withReconciledSelection(
  state: RootState,
  opts: { clearRange?: boolean } = {},
): RootState {
  const present = state.projectHistory.present;
  if (present === null) return state;
  const selection = reconcileSelection(state.session.selection, present, opts);
  if (selection === state.session.selection) return state;
  return { ...state, session: { ...state.session, selection } };
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export const makeStore = (): AppStore => {
  const store = configureStore({
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ immutableCheck: false }).prepend(listenerMiddleware.middleware),
    reducer: rootReducer,
  });
  // Persistence status events arrive outside dispatch; each store wires the
  // façade's subscription to its own dispatch at creation (see
  // subscribePersistenceToStore in ./listeners — no global slot needed).
  subscribePersistenceToStore(store.dispatch);
  return store;
};

/** Application singleton store (tests create isolated stores via makeStore). */
export const store: AppStore = makeStore();
