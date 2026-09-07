/**
 * Global editor keyboard shortcuts (§3.20 Keyboard shortcuts).
 *
 * The DOM listener is a thin adapter over `createEditorShortcutHandler`, a
 * pure (dispatch, getState, transport) -> handler factory so reducer-level
 * flows are testable without a DOM. Handlers never run while the user is
 * typing in an input, textarea, select or contentEditable surface.
 */

import { useEffect } from 'react';

import { getDependencies } from '@app/dependencies';
import { useAppDispatch } from '@app/hooks';
import { projectLengthTicks } from '@domain/model/project';
import { clampTick } from '@domain/timeline/quantize';
import { CHORD_GRID, NOTE_GRID } from '@domain/timeline/constants';
import {
  clearSelectionCmd,
  deleteEventsInRangeCmd,
  deleteChordCmd,
  deleteNoteCmd,
  diatonicStepTargetMidi,
  moveChordCmd,
  moveNoteCmd,
  moveNoteSemitonesCmd,
  resizeChordCmd,
  resizeNoteCmd,
  selectRangeCmd,
} from '@state/commands';
import {
  selectChords,
  selectHarmonyContext,
  selectMelodyNotes,
  selectSelection,
} from '@state/selectors';
import { store, type AppDispatch, type RootState } from '@app/store';
import { REDO_ACTION_TYPE, UNDO_ACTION_TYPE } from '@state/historyReducer';
import type { ProjectTransport } from '@audio/projectTransport';

/** The shortcut layer only toggles: pause/play/«starting» decisions live in
 *  the transport, not here. */
export type ShortcutTransport = Pick<ProjectTransport, 'toggle'>;

function isTypingTarget(target: EventTarget | null): boolean {
  // Duck-typed so the handler stays testable outside a DOM environment.
  const el = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown } | null;
  if (el === null || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT') {
    // A focused range slider (Громкость) is not text entry: ⌘Z/Space/Delete
    // must keep working after the user touches it. Its own arrows stay
    // native — the arrow cases below re-guard against the slider.
    return typeof el.type === 'string' ? el.type !== 'range' : true;
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** True when the event target is a range input (native arrow stepping). */
function isRangeTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; type?: unknown } | null;
  return (
    el !== null &&
    typeof el.tagName === 'string' &&
    el.tagName.toUpperCase() === 'INPUT' &&
    el.type === 'range'
  );
}

/** RevUI-3 belt-and-suspenders: events originating inside a [data-modal]
 *  dialog never trigger editor shortcuts (the dialog also stopPropagation()s
 *  every keydown; this guards against targets that bypass React bubbling). */
function isInsideModal(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (el === null || typeof el.closest !== 'function') return false;
  return el.closest('[data-modal]') !== null;
}

/** Space must keep its native button semantics: when a real <button> or
 *  link holds focus (toolbar tools, undo/redo, export), the keydown returns
 *  before preventDefault so the browser fires click. Note/chord blocks are
 *  role="button" DIVs (NoteBlock/ChordBlock) and intentionally do NOT match —
 *  commit 7e1efa6 made Space toggle playback while a lane block holds focus. */
function isInteractiveControlTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (el === null || typeof el.closest !== 'function') return false;
  return el.closest('button, a[href]') !== null;
}

/** Current selection with its document entity resolved (note/chord events). */
function resolveSelection(state: RootState) {
  const selection = selectSelection(state);
  if (selection === null || selection.kind === 'range') {
    return { selection, note: undefined, chord: undefined } as const;
  }
  if (selection.kind === 'note') {
    const note = selectMelodyNotes(state).find((n) => n.id === selection.id);
    return { selection, note, chord: undefined } as const;
  }
  const chord = selectChords(state).find((c) => c.id === selection.id);
  return { selection, note: undefined, chord } as const;
}

export function createEditorShortcutHandler(deps: {
  dispatch: AppDispatch;
  getState: () => RootState;
  transport: ShortcutTransport;
}) {
  return (event: {
    key: string;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    /** OS auto-repeat flag (SC-1): toggle/bounded-move keys ignore repeats.
     *  Optional because synthetic test events predate the guard. */
    repeat?: boolean;
    target: EventTarget | null;
    metaKey: boolean;
    preventDefault(): void;
  }): void => {
    if (isTypingTarget(event.target) || isInsideModal(event.target)) return;

    // Undo/redo history actions are dispatched directly (§3.15): they are
    // plain actions on the projectHistory wrapper, not command thunks.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      deps.dispatch({ type: event.shiftKey ? REDO_ACTION_TYPE : UNDO_ACTION_TYPE });
      return;
    }
    if (event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case ' ': {
        // A focused real button/link keeps native Space activation; only
        // otherwise (lane blocks included, per 7e1efa6) does Space toggle.
        if (isInteractiveControlTarget(event.target)) return;
        event.preventDefault();
        // SC-1: a toggle must fire once per physical press — holding Space
        // must not machine-gun play/pause via OS auto-repeat.
        if (event.repeat) return;
        void deps.transport.toggle(deps.getState().projectHistory.present);
        return;
      }

      case 'Delete':
      case 'Backspace': {
        event.preventDefault();
        const state = deps.getState();
        const { selection, note, chord } = resolveSelection(state);
        if (selection === null) return;
        if (selection.kind === 'range') {
          // SC-2 / §3.8 + §3.20: Delete over a range removes every covered
          // note AND chord as ONE undoable command; the command clears the
          // selection on success and rejects an empty coverage as a no-op.
          deps.dispatch(
            deleteEventsInRangeCmd({
              startTick: selection.startTick,
              endTick: selection.startTick + selection.durationTicks,
            }),
          );
          return;
        }
        if (selection.kind === 'note' && note !== undefined) {
          deps.dispatch(deleteNoteCmd({ id: note.id }));
        } else if (selection.kind === 'chord' && chord !== undefined) {
          deps.dispatch(deleteChordCmd({ id: chord.id }));
        }
        deps.dispatch(clearSelectionCmd());
        return;
      }

      case 'ArrowLeft':
      case 'ArrowRight': {
        // A focused slider consumes arrows natively (Громкость stepping);
        // the note/chord/range nudges below must not steal them.
        if (isRangeTarget(event.target)) return;
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const state = deps.getState();
        const { selection, note, chord } = resolveSelection(state);
        if (selection === null) return;
        event.preventDefault();
        if (event.shiftKey) {
          // Resize by one grid step; reducers clamp against neighbors.
          if (selection.kind === 'note' && note !== undefined) {
            const minDuration = NOTE_GRID;
            const next =
              direction > 0
                ? note.durationTicks + NOTE_GRID
                : Math.max(minDuration, note.durationTicks - NOTE_GRID);
            deps.dispatch(resizeNoteCmd({ id: note.id, newDurationTicks: next }));
          } else if (selection.kind === 'chord' && chord !== undefined) {
            const next =
              direction > 0
                ? chord.durationTicks + CHORD_GRID
                : Math.max(CHORD_GRID, chord.durationTicks - CHORD_GRID);
            deps.dispatch(resizeChordCmd({ id: chord.id, newDurationTicks: next }));
          }
          return;
        }
        if (selection.kind === 'note' && note !== undefined) {
          const newStartTick = Math.max(0, note.startTick + direction * NOTE_GRID);
          deps.dispatch(moveNoteCmd({ id: note.id, newStartTick, newMidi: note.midi }));
        } else if (selection.kind === 'chord' && chord !== undefined) {
          const newStartTick = Math.max(0, chord.startTick + direction * CHORD_GRID);
          deps.dispatch(moveChordCmd({ id: chord.id, newStartTick }));
        } else if (selection.kind === 'range') {
          // SC-3: clamp against project length like chord placement
          // (addChordRangeCmd) does — the highlighted range may never extend
          // past lengthTicks.
          const present = state.projectHistory.present;
          const maxStart =
            present === null
              ? 0
              : Math.max(0, projectLengthTicks(present) - selection.durationTicks);
          deps.dispatch(
            selectRangeCmd(
              clampTick(selection.startTick + direction * CHORD_GRID, 0, maxStart),
              selection.durationTicks,
            ),
          );
        }
        return;
      }

      case 'ArrowUp':
      case 'ArrowDown': {
        // Same slider guard as the horizontal case: native Громкость
        // stepping wins while the slider holds focus.
        if (isRangeTarget(event.target)) return;
        const delta = event.key === 'ArrowUp' ? 1 : -1;
        const state = deps.getState();
        const { selection, note } = resolveSelection(state);
        if (selection === null || selection.kind !== 'note' || note === undefined) return;
        event.preventDefault();
        if (event.altKey) {
          // SC-1: a bounded move fires once per physical press — holding
          // Alt+Up at midi 96 must not spam the out-of-range error toast.
          if (!event.repeat) {
            deps.dispatch(moveNoteSemitonesCmd({ id: note.id, delta }));
          }
          return;
        }
        // Diatonic step: spelling-aware target computed in the domain layer.
        const targetMidi = diatonicStepTargetMidi(
          note.midi,
          delta,
          selectHarmonyContext(state),
        );
        if (targetMidi !== null) {
          deps.dispatch(
            moveNoteCmd({ id: note.id, newStartTick: note.startTick, newMidi: targetMidi }),
          );
        }
        return;
      }

      case 'Escape':
        event.preventDefault();
        deps.dispatch(clearSelectionCmd());
        return;

      default:
        return;
    }
  };
}

/** React binding: installs the shortcut handler for the app's lifetime. */
export function useEditorShortcuts(): void {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const { transport } = getDependencies();
    const handler = createEditorShortcutHandler({
      dispatch,
      getState: () => store.getState(),
      transport,
    });
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);
}
