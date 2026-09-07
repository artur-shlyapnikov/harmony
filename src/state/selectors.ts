/**
 * Derived selectors (§3.16): core state readers plus memoized projections
 * (voicings, chord labels, note analysis, recommendations). Derived data is
 * never stored — recomputed only when its inputs change.
 */

import { createSelector } from '@reduxjs/toolkit';

import type { ChordEvent, HarmonyContext, MelodyNoteEvent, ProjectDocumentV1, Tick } from '@domain/model/project';
import type { ChordSpec } from '@domain/model/chord';
import type { PatternSpec } from '@domain/model/pattern';
import { DEFAULT_VIEWPORT, type SessionSelection, type ViewportState, type Toast } from './sessionSlice';
import { createProjectDocument } from '@domain/model/project';
import { projectLengthTicks } from '@domain/model/project';
import { resolveProgressionVoicings, type ResolvedVoicing } from '@domain/voicing/resolveProgression';
import { analyzeChordInContext } from '@domain/theory/romanNumerals';
import { analyzeNoteSpans, type NoteHarmonySpan } from '@domain/theory/noteAnalysis';
import { chordSymbol } from '@domain/model/chord';
import { pitchClassOf } from '@domain/model/pitch';
import { TICKS_PER_BAR } from '@domain/timeline/constants';
import {
  recommendChords,
  type ChordRecommendation,
  type RecommendationRequest,
} from '@domain/recommendations/recommendChords';
import type { RootState } from '@app/store';

// ---------------------------------------------------------------------------
// Core selectors
// ---------------------------------------------------------------------------

export const selectPresentProject = (state: RootState): ProjectDocumentV1 | null =>
  state.projectHistory.present;

export const selectHasProject = (state: RootState): boolean =>
  state.projectHistory.present !== null;

const EMPTY_NOTES: readonly MelodyNoteEvent[] = Object.freeze([]);
const EMPTY_CHORDS: readonly ChordEvent[] = Object.freeze([]);

/** Fallback document so core selectors stay total when no project is open.
 * Created once (frozen) so memoized selectors see a stable reference. */
const EMPTY_PROJECT: ProjectDocumentV1 = Object.freeze(
  createProjectDocument({ title: '', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' }),
);

export const selectMelodyNotes = (state: RootState): readonly MelodyNoteEvent[] =>
  state.projectHistory.present?.melody.notes ?? EMPTY_NOTES;

export const selectChords = (state: RootState): readonly ChordEvent[] =>
  state.projectHistory.present?.harmony.chords ?? EMPTY_CHORDS;

export const selectHarmonyContext = (state: RootState) =>
  (state.projectHistory.present ?? EMPTY_PROJECT).harmonyContext;

export const selectTiming = createSelector([selectPresentProject], (present) => ({
  bpm: present?.timing.bpm ?? 120,
  bars: present?.timing.bars ?? 8,
  ppq: present?.timing.ppq ?? 960,
}));

export const selectLengthTicks = createSelector([selectPresentProject], (present) =>
  present === null ? 0 : projectLengthTicks(present),
);

export const selectDefaultPattern = (state: RootState): PatternSpec =>
  (state.projectHistory.present ?? EMPTY_PROJECT).harmony.defaultPattern;

export const selectVoicingProfile = (state: RootState) =>
  (state.projectHistory.present ?? EMPTY_PROJECT).harmony.voicingProfile;

// ---------------------------------------------------------------------------
// Session selectors
// ---------------------------------------------------------------------------

export const selectActiveProjectId = (state: RootState): string | undefined =>
  state.session.activeProjectId;

export const selectSelection = (state: RootState): SessionSelection => state.session.selection;

export const selectActiveTool = (state: RootState) => state.session.activeTool;

export const selectSaveStatus = (state: RootState) => state.session.saveStatus;

export const selectViewport = (state: RootState): ViewportState =>
  state.session.viewport ?? DEFAULT_VIEWPORT;

export const selectToasts = (state: RootState): readonly Toast[] => state.session.toasts;

export const selectPersistenceError = (state: RootState): string | undefined =>
  state.session.persistenceError;

// ---------------------------------------------------------------------------
// Derived: voicings (§3.11)
// ---------------------------------------------------------------------------

export const selectResolvedVoicings: (state: RootState) => ResolvedVoicing[] =
  createSelector([selectChords, selectVoicingProfile], (chords, profile) =>
    resolveProgressionVoicings([...chords], profile),
  );

export const selectVoicingByChordId: (
  state: RootState,
) => Map<string, ResolvedVoicing> = createSelector([selectResolvedVoicings], (voicings) => {
  const byId = new Map<string, ResolvedVoicing>();
  for (const voicing of voicings) byId.set(voicing.chordEventId, voicing);
  return byId;
});

// ---------------------------------------------------------------------------
// Derived: chord labels (symbol + roman numeral)
// ---------------------------------------------------------------------------

export type ChordLabel = { symbol: string; roman: string };

export const selectChordLabels: (state: RootState) => Map<string, ChordLabel> =
  createSelector([selectChords, selectHarmonyContext], (chords, context) => {
    const labels = new Map<string, ChordLabel>();
    for (const chord of chords) {
      labels.set(chord.id, {
        symbol: chordSymbol(chord.chord),
        roman: analyzeChordInContext(chord.chord, context).label,
      });
    }
    return labels;
  });

// ---------------------------------------------------------------------------
// Derived: melody note harmony analysis (§3.10)
// ---------------------------------------------------------------------------

/** Last inputs behind a note's cached analysis; reference-compared on reuse. */
type CachedSpans = {
  /** Full chord-timeline reference: O(1) hit for commits that leave chords untouched. */
  chords: readonly ChordEvent[];
  /** Chord events overlapping the note, in array order — the minimal key: a
   *  note's spans depend only on these (non-overlapping chords contribute no
   *  segment boundaries and never win chordOverlapping inside the note).
   *  Chord events are immutable, so reference equality implies same content. */
  overlapping: readonly ChordEvent[];
  context: HarmonyContext;
  spans: NoteHarmonySpan[];
};

const spanCache = new WeakMap<MelodyNoteEvent, CachedSpans>();

function chordsOverlappingNote(
  chords: readonly ChordEvent[],
  fromTick: Tick,
  toTick: Tick,
): ChordEvent[] {
  const out: ChordEvent[] = [];
  for (const chord of chords) {
    if (chord.startTick < toTick && chord.startTick + chord.durationTicks > fromTick) {
      out.push(chord);
    }
  }
  return out;
}

function sameChords(a: readonly ChordEvent[], b: readonly ChordEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const selectNoteAnalysisMap: (
  state: RootState,
) => Map<string, NoteHarmonySpan[]> = createSelector(
  [selectMelodyNotes, selectChords, selectHarmonyContext],
  (notes, chords, context) => {
    const map = new Map<string, NoteHarmonySpan[]>();
    for (const note of notes) {
      // Per-note memo, three tiers: an untouched note keeps its object
      // reference across immutable document edits. (1) Chord timeline and
      // context unchanged → O(1) reuse. (2) Chord timeline changed → reuse
      // anyway when the note's overlapping chord set is reference-identical
      // (an edit elsewhere in the song), keeping span arrays reference-stable
      // so NoteBlock's memo skips unaffected blocks. (3) Otherwise reanalyze.
      // One chord edit re-renders only the blocks it can actually recolor.
      const cached = spanCache.get(note);
      let spans: NoteHarmonySpan[];
      if (cached !== undefined && cached.context === context) {
        if (cached.chords === chords) {
          spans = cached.spans;
        } else {
          const overlapping = chordsOverlappingNote(
            chords,
            note.startTick,
            note.startTick + note.durationTicks,
          );
          spans = sameChords(cached.overlapping, overlapping)
            ? cached.spans
            : analyzeNoteSpans(note, chords, context);
          spanCache.set(note, { chords, overlapping, context, spans });
        }
      } else {
        spans = analyzeNoteSpans(note, chords, context);
        spanCache.set(note, {
          chords,
          overlapping: chordsOverlappingNote(
            chords,
            note.startTick,
            note.startTick + note.durationTicks,
          ),
          context,
          spans,
        });
      }
      map.set(note.id, spans);
    }
    return map;
  },
);

// ---------------------------------------------------------------------------

export type TargetRange = { startTick: number; durationTicks: number };

function sameSpec(a: ChordSpec, b: ChordSpec): boolean {
  return a.templateId === b.templateId && pitchClassOf(a.root) === pitchClassOf(b.root);
}

/**
 * Factory-style memoized selector: `createSelectRecommendations()` returns a
 * `(state, targetRange)` selector building the full §3.12 request — previous/
 * next chord adjacency, last two distinct specs, melody within ±1 bar — and
 * running the synchronous recommendation engine with `complexity: 'rich'`.
 */
export function createSelectRecommendations(): (
  state: RootState,
  targetRange: TargetRange,
) => ChordRecommendation[] {
  return createSelector(
    [selectPresentProject, (_state: RootState, targetRange: TargetRange) => targetRange],
    (present, targetRange): ChordRecommendation[] => {
      if (present === null || targetRange.durationTicks <= 0) return [];

      const chords = present.harmony.chords;
      const endTick = targetRange.startTick + targetRange.durationTicks;

      const endingBefore = chords.filter((chord) => chord.startTick + chord.durationTicks <= targetRange.startTick);
      const startingAfter = chords.filter((chord) => chord.startTick >= endTick);

      // A chord straddling a range edge sounds at that boundary, so it is the
      // closest harmony there — even though it satisfies neither predicate
      // above — and takes precedence over strictly-before/after chords.
      const straddlingStart = chords.find(
        (chord) => chord.startTick < targetRange.startTick && chord.startTick + chord.durationTicks > targetRange.startTick,
      );
      const straddlingEnd = chords.find(
        (chord) => chord.startTick < endTick && chord.startTick + chord.durationTicks > endTick,
      );

      const previousChord: ChordSpec | undefined = straddlingStart?.chord ?? endingBefore.at(-1)?.chord;
      const nextChord: ChordSpec | undefined = straddlingEnd?.chord ?? startingAt(startingAfter, endTick)?.chord;

      const recentChords: ChordSpec[] = [];
      for (let i = endingBefore.length - 1; i >= 0 && recentChords.length < 2; i -= 1) {
        const spec = endingBefore[i]!.chord;
        if (!recentChords.some((recent) => sameSpec(recent, spec))) recentChords.push(spec);
      }

      const windowStart = Math.max(0, targetRange.startTick - TICKS_PER_BAR);
      const windowEnd = endTick + TICKS_PER_BAR;
      const melodyNotes = present.melody.notes.filter(
        (note) => note.startTick + note.durationTicks > windowStart && note.startTick < windowEnd,
      );

      const request: RecommendationRequest = {
        context: present.harmonyContext,
        targetRange: { startTick: targetRange.startTick, durationTicks: targetRange.durationTicks },
        ...(previousChord !== undefined && { previousChord }),
        ...(nextChord !== undefined && { nextChord }),
        recentChords,
        melodyNotes,
        complexity: 'rich',
      };
      return recommendChords(request);
    },
  );
}

/** First chord starting exactly at `endTick`, else the earliest after it. */
function startingAt(chords: readonly ChordEvent[], endTick: number): ChordEvent | undefined {
  return chords.find((chord) => chord.startTick === endTick) ?? chords[0];
}
