/**
 * Canonical project document (§3.5) and factory.
 */

import {
  type ChordSpec,
} from './chord';
import { type PatternSpec, DEFAULT_PATTERN } from './pattern';
import { type ModeId, type SpelledPitchClass } from './pitch';
import { INITIAL_BARS, TICKS_PER_BAR } from '../timeline/constants';

export type Tick = number;

export type HarmonyContext = {
  tonic: SpelledPitchClass;
  mode: ModeId;
};

export type MelodyNoteEvent = {
  id: string;
  startTick: Tick;
  durationTicks: Tick;
  /** 36..96 */
  midi: number;
  /** 1..127 */
  velocity: number;
  spellingOverride?: SpelledPitchClass;
};

export type ChordEvent = {
  id: string;
  startTick: Tick;
  durationTicks: Tick;
  chord: ChordSpec;
  patternOverride?: PatternSpec;
};

/**
 * Engine-facing constraint set (§3.11). The voicing engine only reads these
 * bounds; documents may carry any values within the schema's ranges.
 */
export type VoicingConstraints = {
  lowMidi: number;
  highMidi: number;
  maxVoices: number;
  maxSpanSemitones: number;
  maxUpperGapSemitones: number;
  maxBassGapSemitones: number;
  centerMidi: number;
};

/** Document profile (§3.20): fixed literal bounds on top of the constraints. */
export type VoicingProfile = VoicingConstraints & {
  maxVoices: 4;
  maxSpanSemitones: 24;
  maxUpperGapSemitones: 12;
  maxBassGapSemitones: 16;
  centerMidi: 60; // C4
};

export const DEFAULT_VOICING_PROFILE = Object.freeze({
  lowMidi: 43, // G2
  highMidi: 79, // G5
  maxVoices: 4,
  maxSpanSemitones: 24,
  maxUpperGapSemitones: 12,
  maxBassGapSemitones: 16,
  centerMidi: 60,
} as const) satisfies VoicingProfile;

export type ProjectDocumentV1 = {
  schemaVersion: 1;

  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;

  timing: {
    ppq: 960;
    bpm: number; // 40...240
    timeSignature: {
      numerator: 4;
      denominator: 4;
    };
    bars: number; // 1...128
  };

  harmonyContext: HarmonyContext;

  melody: {
    notes: MelodyNoteEvent[];
  };

  harmony: {
    chords: ChordEvent[];
    defaultPattern: PatternSpec;
    voicingProfile: VoicingProfile;
  };
};

export type ProjectSummary = {
  id: string;
  title: string;
  updatedAt: string;
  /**
   * Musical meta for list rows, read off the stored payload (§3.18 list path).
   * Omitted when the payload is unreadable — the row still renders title/date.
   */
  meta?: {
    /** Canonical short name, e.g. "C", "Bb" (spelledName of harmonyContext.tonic). */
    tonic: string;
    mode: ModeId;
    bars: number;
    chordCount: number;
    noteCount: number;
  };
};

export function createProjectDocument(input: {
  title: string;
  tonic: SpelledPitchClass;
  mode: HarmonyContext['mode'];
  bars?: number;
}): ProjectDocumentV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,

    id: crypto.randomUUID(),
    title: input.title,
    createdAt: now,
    updatedAt: now,

    timing: {
      ppq: 960,
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      bars: input.bars ?? INITIAL_BARS,
    },

    harmonyContext: {
      tonic: input.tonic,
      mode: input.mode,
    },

    melody: {
      notes: [],
    },

    harmony: {
      chords: [],
      defaultPattern: structuredClone(DEFAULT_PATTERN),
      voicingProfile: structuredClone(DEFAULT_VOICING_PROFILE),
    },
  };
}

/** Bar count → total document length in ticks: bars * ticksPerBar (3840). */
export function barsToLengthTicks(bars: number): Tick {
  return bars * TICKS_PER_BAR;
}

/** Total document length in ticks (§3.5): barsToLengthTicks(doc.timing.bars). */
export function projectLengthTicks(doc: ProjectDocumentV1): Tick {
  return barsToLengthTicks(doc.timing.bars);
}

