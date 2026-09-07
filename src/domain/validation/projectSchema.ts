/**
 * Zod validation schema for the canonical project document, V1 (§3.5).
 *
 * Structural validation only: ordering invariants (arrays sorted by startTick,
 * then id) are normalized by the timeline mutation layer, not here.
 */

import { z } from 'zod';

import { CHORD_TEMPLATES, type ChordTemplateId } from '../model/chord';
import type { PatternKind } from '../model/pattern';
import {
  MIDI_MAX,
  MIDI_MIN,
  type Accidental,
  type NoteLetter,
} from '../model/pitch';
import { MAX_BARS, MIN_BARS, CHORD_GRID, NOTE_GRID } from '../timeline/constants';

const NOTE_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const satisfies readonly NoteLetter[];
const ACCIDENTAL_VALUES = [-2, -1, 0, 1, 2] as const satisfies readonly Accidental[];
const PATTERN_KINDS: readonly PatternKind[] = [
  'block',
  'up',
  'down',
  'upDown',
  'bassChord',
  'oneFiveThreeFive',
];
const SUBDIVISIONS = [240, 480, 960] as const;
const OCTAVE_SPANS = [1, 2] as const;

export const spelledPitchClassSchema = z.object({
  letter: z.enum(NOTE_LETTERS),
  accidental: z.union(ACCIDENTAL_VALUES.map((a) => z.literal(a))),
});

export const chordSpecSchema = z.object({
  root: spelledPitchClassSchema,
  templateId: z.enum(
    CHORD_TEMPLATES.map((t) => t.id) as [ChordTemplateId, ...ChordTemplateId[]],
  ),
});

export const patternSpecSchema = z.object({
  kind: z.enum(PATTERN_KINDS as [PatternKind, ...PatternKind[]]),
  subdivisionTicks: z.union(SUBDIVISIONS.map((s) => z.literal(s))),
  gate: z.number().min(0.1).max(1),
  octaveSpan: z.union(OCTAVE_SPANS.map((s) => z.literal(s))),
  velocity: z.number().int().min(1).max(127),
});

/** §3.4/§3.18: ids must be unique within a lane — duplicate-id documents
 *  bypass the reducer invariant sweep on load and misbehave (e.g.
 *  deleteNote removes both rows), so they take the corrupt-project path. */
function uniqueIdsRefine(
  items: readonly { id: string }[],
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: 'duplicate event id',
      });
    }
    seen.add(item.id);
  });
}

export const melodyNoteEventSchema = z.object({
  id: z.string().min(1),
  startTick: z
    .number()
    .int()
    .min(0)
    .refine((ticks) => ticks % NOTE_GRID === 0, {
      message: `melody startTick must be a multiple of ${NOTE_GRID}`, // §3.4
    }),
  durationTicks: z
    .number()
    .int()
    .gt(0)
    .refine((ticks) => ticks % NOTE_GRID === 0, {
      message: `melody durationTicks must be a multiple of ${NOTE_GRID}`, // §3.4
    }),
  midi: z.number().int().min(MIDI_MIN).max(MIDI_MAX),
  velocity: z.number().int().min(1).max(127),
  spellingOverride: spelledPitchClassSchema.optional(),
});

export const chordEventSchema = z.object({
  id: z.string().min(1),
  startTick: z
    .number()
    .int()
    .min(0)
    .refine((ticks) => ticks % CHORD_GRID === 0, {
      message: `chord startTick must be a multiple of ${CHORD_GRID}`,
    }),
  durationTicks: z
    .number()
    .int()
    .gt(0)
    .refine((ticks) => ticks % CHORD_GRID === 0, {
      message: `chord durationTicks must be a multiple of ${CHORD_GRID}`,
    }),
  chord: chordSpecSchema,
  patternOverride: patternSpecSchema.optional(),
});

export const voicingProfileSchema = z.object({
  lowMidi: z.number().int().min(MIDI_MIN).max(MIDI_MAX),
  highMidi: z.number().int().min(MIDI_MIN).max(MIDI_MAX),
  maxVoices: z.literal(4), // §3.20
  maxSpanSemitones: z.literal(24),
  maxUpperGapSemitones: z.literal(12),
  maxBassGapSemitones: z.literal(16),
  centerMidi: z.literal(60),
});

export const projectDocumentV1Schema = z.object({
  schemaVersion: z.literal(1),

  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),

  timing: z.object({
    ppq: z.literal(960),
    bpm: z.number().min(40).max(240),
    timeSignature: z.object({
      numerator: z.literal(4),
      denominator: z.literal(4),
    }),
    bars: z.number().int().min(MIN_BARS).max(MAX_BARS),
  }),

  harmonyContext: z.object({
    tonic: spelledPitchClassSchema,
    mode: z.enum([
      'ionian',
      'dorian',
      'phrygian',
      'lydian',
      'mixolydian',
      'aeolian',
      'locrian',
    ]),
  }),

  melody: z.object({
    notes: z.array(melodyNoteEventSchema).superRefine(uniqueIdsRefine),
  }),

  harmony: z.object({
    chords: z.array(chordEventSchema).superRefine(uniqueIdsRefine),
    defaultPattern: patternSpecSchema,
    voicingProfile: voicingProfileSchema,
  }),
});

export const projectDocumentSchema = z.discriminatedUnion('schemaVersion', [
  projectDocumentV1Schema,
]);

export type ValidateResult<T> =
  | { ok: true; document: T }
  | { ok: false; error: string };

export function validateProjectDocument(
  raw: unknown,
): ValidateResult<z.output<typeof projectDocumentSchema>> {
  const parsed = projectDocumentSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, document: parsed.data };
  }
  return { ok: false, error: formatZodError(parsed.error) };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
