/**
 * Typed command layer (§3.20 command seam): thin APPLICATION shells around
 * the domain ProjectEditor. Each shell reads the present document, runs
 * `applyProjectEdit`, maps rejection reasons to user-facing toast copy and
 * dispatches the resulting document ONLY on `applied`. Rejected and no-op
 * edits never reach dispatch; success is decided BEFORE any dispatch — no
 * object-identity probing.
 *
 * Toast-copy policy note: the shells below reproduce the historical
 * observable behavior exactly. In particular some commands treated a
 * semantic no-op as an error (`moveNote` onto its own position surfaced
 * «нет места между соседями» via the old identity protocol), while others
 * treat it as silent mutation economy (§3.8) — that split now lives in each
 * shell's `onUnchanged` choice instead of in reference equality.
 */

import type { ChordSpec } from '@domain/model/chord';
import type { PatternSpec } from '@domain/model/pattern';
import {
  type HarmonyContext,
  type ProjectDocumentV1,
  type Tick,
} from '@domain/model/project';
import {
  MIDI_MAX,
  MIDI_MIN,
  spelledName,
  type ModeId,
  type SpelledPitchClass,
  pitchClassOf,
} from '@domain/model/pitch';
import {
  MAX_BARS,
  MAX_CHORD_EVENTS,
  MAX_MELODY_NOTES,
  MIN_BARS,
} from '@domain/timeline/constants';
import { applyProjectEdit, type EditRejection, type ProjectEdit } from '@domain/editing/projectEditor';
import { modeScaleLetters } from '@domain/theory/tonalAdapter';
import { DOCUMENT_COMMITTED, REPLACED_FROM_LOAD } from './projectDocumentSlice';
import type { ActiveTool, SessionSelection } from './sessionSlice';
import type { AppDispatch, RootState } from '@app/store';
import { getDependencies } from '@app/dependencies';
import type { ProjectOpenResult } from '@persistence/projectPersistence';
import { pluralRu } from '@shared/labels';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Dispatch = AppDispatch;

type ToastAction = {
  type: 'session/toastPushed';
  payload: {
    toast: { id: string; kind: 'error' | 'info' | 'success'; message: string };
  };
};

function toast(kind: 'error' | 'info' | 'success', message: string): ToastAction {
  return {
    type: 'session/toastPushed',
    payload: { toast: { id: crypto.randomUUID(), kind, message } },
  };
}

function errorToast(message: string): ToastAction {
  return toast('error', message);
}

/** How a command shell reports an edit whose result is `unchanged`. */
type UnchangedPolicy =
  /** §3.8 mutation economy: silent success, no dispatch, no toast. */
  | 'silent'
  /** Legacy identity-protocol parity: the failure toast + `false`. */
  | 'failure';

/**
 * The one seam between commands and the store: no open project → shared
 * «Проект не открыт» toast; applied → single commit dispatch; unchanged →
 * per-command policy; rejected → reason-mapped (or default) error toast.
 */
type RunEditConfig = {
  failureMessage: string;
  onUnchanged?: UnchangedPolicy;
  reasonMessages?: {
    [K in EditRejection['kind']]?:
      | string
      | ((reason: Extract<EditRejection, { kind: K }>) => string);
  };
};

function runEdit(
  dispatch: Dispatch,
  getState: () => RootState,
  edit: ProjectEdit,
  config: RunEditConfig,
): boolean {
  const present = getState().projectHistory.present;
  if (present === null) {
    dispatch(errorToast('Проект не открыт'));
    return false;
  }
  const result = applyProjectEdit(present, edit);
  switch (result.kind) {
    case 'applied':
      dispatch({ type: DOCUMENT_COMMITTED, payload: { project: result.project, editKind: edit.kind } });
      return true;
    case 'unchanged':
      if ((config.onUnchanged ?? 'silent') === 'silent') return true;
      dispatch(errorToast(config.failureMessage));
      return false;
    case 'rejected': {
      // The map is keyed by the discriminant, so a hit is always the matching
      // message shape; TS cannot narrow through the dynamic key lookup.
      const mapped = config.reasonMessages?.[result.reason.kind] as
        | string
        | ((reason: never) => string)
        | undefined;
      const message =
        typeof mapped === 'function'
          ? mapped(result.reason as never)
          : (mapped ?? config.failureMessage);
      dispatch(errorToast(message));
      return false;
    }
  }
}

/**
 * One source of truth for the repetitive payload-to-thunk threading. Each
 * shell declares its static config plus a payload-to-edit builder. Exported
 * names and call signatures are unchanged.
 */
function defineEditCommand<Payload>(
  config: RunEditConfig,
  buildEdit: (payload: Payload) => ProjectEdit,
) {
  return (payload: Payload) =>
    (dispatch: Dispatch, getState: () => RootState): boolean =>
      runEdit(dispatch, getState, buildEdit(payload), config);
}

// ---------------------------------------------------------------------------
// Melody commands
// ---------------------------------------------------------------------------

export type DocumentAddNotePayload = {
  startTick: Tick;
  durationTicks: Tick;
  midi: number;
  velocity: number;
  /** Callers that need to know the created note (draw-then-select) pass the
   * id explicitly; by default the command mints one. */
  id?: string;
};

export const addNoteCmd = defineEditCommand<DocumentAddNotePayload>(
  {
    failureMessage: 'Не удалось добавить ноту',
    onUnchanged: 'failure',
    reasonMessages: {
      melody_limit: `Достигнут предел мелодии (${MAX_MELODY_NOTES} нот)`,
    },
  },
  (payload) => ({ kind: 'addNote', id: crypto.randomUUID(), ...payload }),
);

export const moveNoteCmd = defineEditCommand<{ id: string; newStartTick: Tick; newMidi: number }>(
  { failureMessage: 'Не удалось сдвинуть ноту: нет места между соседями', onUnchanged: 'failure' },
  (payload) => ({ kind: 'moveNote', ...payload }),
);

export const resizeNoteCmd = defineEditCommand<{ id: string; newDurationTicks: Tick }>(
  { failureMessage: 'Не удалось изменить длину ноты: мешает соседняя нота', onUnchanged: 'failure' },
  (payload) => ({ kind: 'resizeNote', ...payload }),
);

export const moveResizeNoteCmd = defineEditCommand<{ id: string; newStartTick: Tick; newDurationTicks: Tick }>(
  { failureMessage: 'Не удалось изменить ноту: мешает соседняя нота', onUnchanged: 'failure' },
  (payload) => ({ kind: 'moveResizeNote', ...payload }),
);

// SEL-1: a dangling selection left by this delete is repaired by the
// root reconcile choke point, not here.
export const deleteNoteCmd = defineEditCommand<{ id: string }>(
  { failureMessage: 'Нота не найдена', onUnchanged: 'failure' },
  (payload) => ({ kind: 'deleteNote', ...payload }),
);

/** §3.20 Delete over a range selection: removes ALL melody notes AND chords
 *  intersecting [startTick, endTick) as ONE undoable mutation (§3.8). A range
 *  covering nothing is a rejected no-op. On success the range selection is
 *  cleared by the root reconcile choke point (SEL-1). */
export const deleteEventsInRangeCmd = defineEditCommand<{ startTick: Tick; endTick: Tick }>(
  { failureMessage: 'В выделенном диапазоне нет событий', onUnchanged: 'failure' },
  (payload) => ({ kind: 'deleteEventsInRange', ...payload }),
);

export const setNoteVelocityCmd = defineEditCommand<{ id: string; velocity: number }>(
  {
    failureMessage: 'Нота не найдена',
    onUnchanged: 'failure',
    reasonMessages: {
      velocity_out_of_range: 'Громкость должна быть целым числом от 1 до 127',
    },
  },
  (payload) => ({ kind: 'setNoteVelocity', ...payload }),
);

export const setNoteSpellingOverrideCmd = defineEditCommand<{
  id: string;
  override: SpelledPitchClass | null;
}>(
  {
    failureMessage: 'Нота не найдена',
    // §3.8 mutation economy: re-selecting the current spelling is a silent
    // semantic no-op — report applied WITHOUT dispatching (no error toast).
    onUnchanged: 'silent',
  },
  (payload) => ({ kind: 'setNoteSpellingOverride', ...payload }),
);

export const moveNoteSemitonesCmd = defineEditCommand<{ id: string; delta: number }>(
  {
    failureMessage: 'Не удалось сдвинуть ноту',
    onUnchanged: 'failure',
    reasonMessages: {
      midi_out_of_range: (reason) =>
        `Не удалось сдвинуть ноту: MIDI ${reason.midi} вне диапазона ${MIDI_MIN}..${MIDI_MAX}`,
    },
  },
  (payload) => ({ kind: 'moveNoteSemitones', ...payload }),
);

// ---------------------------------------------------------------------------
// Harmony commands
// ---------------------------------------------------------------------------

export const addChordRangeCmd = defineEditCommand<{
  startTick: Tick;
  durationTicks: Tick;
  chord: ChordSpec;
}>(
  {
    failureMessage: 'Не удалось добавить аккорд: достигнут предел событий',
    onUnchanged: 'failure',
    reasonMessages: {
      chord_limit: `Достигнут предел гармонии (${MAX_CHORD_EVENTS} аккордов)`,
    },
  },
  (payload) => ({ kind: 'addChordRange', id: crypto.randomUUID(), ...payload }),
);

export const setChordSpecCmd = defineEditCommand<{ id: string; chord: ChordSpec }>(
  {
    failureMessage: 'Аккорд не найден',
    // §3.8 mutation economy: re-selecting the current spec is a silent
    // semantic no-op — report applied WITHOUT dispatching (no toast).
    onUnchanged: 'silent',
  },
  (payload) => ({ kind: 'setChordSpec', ...payload }),
);

export const deleteChordCmd = defineEditCommand<{ id: string }>(
  { failureMessage: 'Аккорд не найден', onUnchanged: 'failure' },
  (payload) => ({ kind: 'deleteChord', ...payload }),
);

export const moveChordCmd = defineEditCommand<{ id: string; newStartTick: Tick }>(
  { failureMessage: 'Не удалось сдвинуть аккорд: нет места между соседями', onUnchanged: 'failure' },
  (payload) => ({ kind: 'moveChord', ...payload }),
);

export const resizeChordCmd = defineEditCommand<{ id: string; newDurationTicks: Tick }>(
  { failureMessage: 'Не удалось изменить длину аккорда: мешает соседний аккорд', onUnchanged: 'failure' },
  (payload) => ({ kind: 'resizeChord', ...payload }),
);

/** Atomic left-edge resize: BOTH fields in ONE document mutation → ONE
 *  history entry (§3.7/§3.8). */
export const moveResizeChordCmd = defineEditCommand<{ id: string; newStartTick: Tick; newDurationTicks: Tick }>(
  { failureMessage: 'Не удалось изменить аккорд: мешает соседний аккорд', onUnchanged: 'failure' },
  (payload) => ({ kind: 'moveResizeChord', ...payload }),
);

export const setChordPatternOverrideCmd = defineEditCommand<{ id: string; pattern: PatternSpec | null }>(
  { failureMessage: 'Аккорд не найден', onUnchanged: 'silent' },
  (payload) => ({ kind: 'setChordPatternOverride', ...payload }),
);

// ---------------------------------------------------------------------------
// Global commands
// ---------------------------------------------------------------------------

/** §3.8 rename: one undoable title mutation. Empty/whitespace input is
 *  rejected with an error toast; re-entering the current title is a silent
 *  semantic no-op, mirroring changeBpmCmd's mutation economy. */
export const setTitleCmd = defineEditCommand<string>(
  {
    failureMessage: 'Не удалось переименовать проект',
    onUnchanged: 'silent',
    reasonMessages: {
      title_empty: 'Название не может быть пустым',
    },
  },
  (title) => ({ kind: 'setTitle', title }),
);

export const changeBpmCmd = defineEditCommand<number>(
  {
    failureMessage: 'Не удалось изменить темп',
    onUnchanged: 'silent',
    reasonMessages: {
      bpm_out_of_range: 'Темп должен быть от 40 до 240',
    },
  },
  (bpm) => ({ kind: 'setBpm', bpm }),
);

/** §3.8 «add/remove bars»: resizes the timeline as ONE undoable mutation.
 *  Out-of-range or non-integer input is rejected with an error toast (no
 *  dispatch), and re-entering the current bar count is a silent semantic
 *  no-op. */
export const setBarsCmd = defineEditCommand<number>(
  {
    failureMessage: 'Не удалось изменить количество тактов',
    onUnchanged: 'silent',
    reasonMessages: {
      bars_out_of_range: `Количество тактов должно быть целым числом от ${MIN_BARS} до ${MAX_BARS}`,
    },
  },
  (bars) => ({ kind: 'setBars', bars }),
);

export const setDefaultPatternCmd = defineEditCommand<PatternSpec>(
  { failureMessage: 'Не удалось изменить паттерн', onUnchanged: 'silent' },
  (pattern) => ({ kind: 'setDefaultPattern', pattern }),
);

/**
 * §3.14 transpose: computes the domain result against the present document
 * first; only a successful result is committed as one undoable action.
 */
export function transposeToTonicCmd(targetTonic: SpelledPitchClass) {
  return (dispatch: Dispatch, getState: () => RootState): boolean => {
    const applied = runEdit(
      dispatch,
      getState,
      { kind: 'transposeToTonic', targetTonic },
      {
        failureMessage: 'Не удалось транспонировать: результат нарушает инварианты проекта',
        onUnchanged: 'failure',
        reasonMessages: {
          transpose_out_of_range: (reason) => {
            const count = reason.offendingNoteIds.length;
            return `Не удалось транспонировать: ${count} ${pluralRu(count, 'нота выйдет', 'ноты выйдут', 'нот выйдут')} за диапазон`;
          },
          same_tonic: `Уже в тональности ${spelledName(targetTonic)}`,
        },
      },
    );
    if (applied) dispatch(toast('success', `Транспонировано в ${spelledName(targetTonic)}`));
    return applied;
  };
}

export const setModeCmd = defineEditCommand<ModeId>(
  { failureMessage: 'Не удалось изменить лад', onUnchanged: 'failure' },
  (mode) => ({ kind: 'setMode', mode }),
);

export function openProjectCmd(project: ProjectDocumentV1) {
  return (dispatch: Dispatch): void => {
    dispatch({ type: REPLACED_FROM_LOAD, payload: { project } });
    // §3.15 selection reset happens at the root reconcile choke point.
    dispatch({ type: 'session/projectOpened', payload: { projectId: project.id } });
  };
}

/**
 * THE single application use case for opening a stored project (§3.18 load
 * flow): asks the persistence façade for the document (flush-before-read,
 * migration, validation and normalization all inside) and, on success,
 * commits it exactly like a direct open — REPLACED_FROM_LOAD halts the
 * transport and flushes the previous project's pending work, then the
 * session resets. Failures come back as stable result kinds; callers map
 * them to their own UI outcomes (the list page's early corrupt/not-found
 * feedback AND the editor's load screen share this path). Never throws.
 *
 * Staleness guard: every started open bumps a monotonic epoch; if a newer
 * open has begun by the time this one resolves, its result is stale — it
 * commits NOTHING (no REPLACED_FROM_LOAD, no session reset) and resolves
 * `{ kind: 'stale' }`, which callers must ignore. Without this, slow-open A
 * resolving after fast-open B would replace B's document under /project/B,
 * and subsequent autosaves would land on the wrong project id.
 */

/** Monotonic open-generation counter shared by all `openProjectByIdCmd` calls. */
let openEpoch = 0;

/** Outcome of an open that a newer `openProjectByIdCmd` superseded. */
export type OpenProjectStaleResult = { kind: 'stale' };

export function openProjectByIdCmd(
  id: string,
): (dispatch: Dispatch) => Promise<ProjectOpenResult | OpenProjectStaleResult> {
  return async (dispatch) => {
    const epoch = ++openEpoch;
    const result = await getDependencies().projects.open(id);
    if (epoch !== openEpoch) return { kind: 'stale' };
    if (result.kind === 'ok') dispatch(openProjectCmd(result.document));
    return result;
  };
}

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

export function selectNoteCmd(id: string) {
  return (dispatch: Dispatch): void => {
    const selection: SessionSelection = { kind: 'note', id };
    dispatch({ type: 'session/selectionSet', payload: { selection } });
  };
}

export function selectChordCmd(id: string) {
  return (dispatch: Dispatch): void => {
    const selection: SessionSelection = { kind: 'chord', id };
    dispatch({ type: 'session/selectionSet', payload: { selection } });
  };
}

export function selectRangeCmd(startTick: Tick, durationTicks: Tick) {
  return (dispatch: Dispatch): void => {
    const selection: SessionSelection = { kind: 'range', startTick, durationTicks };
    dispatch({ type: 'session/selectionSet', payload: { selection } });
  };
}

export function clearSelectionCmd() {
  return (dispatch: Dispatch): void => {
    dispatch({ type: 'session/selectionSet', payload: { selection: null } });
  };
}

export function setActiveToolCmd(tool: ActiveTool) {
  return (dispatch: Dispatch): void => {
    dispatch({ type: 'session/activeToolSet', payload: { tool } });
  };
}

// ---------------------------------------------------------------------------
// Diatonic nudge (Up/Down shortcuts)
// ---------------------------------------------------------------------------

/**
 * Next (`delta: 1`) or previous (`delta: -1`) diatonic MIDI pitch of the
 * context mode; `null` when the step would leave 36..96. Chromatic notes
 * snap to the nearest scale pitch in the given direction.
 */
export function diatonicStepTargetMidi(
  midi: number,
  delta: 1 | -1,
  context: HarmonyContext,
): number | null {
  const scalePcs = modeScaleLetters(context).map(pitchClassOf);
  const scaleMidis: number[] = [];
  for (let octave = 2; octave <= 8; octave += 1) {
    for (const pc of scalePcs) {
      const candidate = octave * 12 + pc;
      if (candidate >= MIDI_MIN && candidate <= MIDI_MAX) scaleMidis.push(candidate);
    }
  }
  scaleMidis.sort((a, b) => a - b);

  let target: number | undefined;
  if (delta === 1) {
    target = scaleMidis.find((candidate) => candidate > midi);
  } else {
    for (let i = scaleMidis.length - 1; i >= 0; i -= 1) {
      if (scaleMidis[i]! < midi) {
        target = scaleMidis[i];
        break;
      }
    }
  }
  return target ?? null;
}
