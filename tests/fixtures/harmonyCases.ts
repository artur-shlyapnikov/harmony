/**
 * Curated harmony recommendation cases (§3.12 test fixtures).
 *
 * Each case is a complete RecommendationRequest seed plus optional
 * expectations. Pure data — no logic.
 */

import type { ChordSpec, ChordTemplateId } from '@domain/model/chord';
import {
  type HarmonyContext,
  type MelodyNoteEvent,
} from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';

export type HarmonyCase = {
  name: string;
  context: HarmonyContext;
  previousChord?: ChordSpec;
  recentChords: ChordSpec[];
  melodyNotes: MelodyNoteEvent[];
  complexity: 'basic' | 'rich';
  expectRomanInSuggestions?: string[];
  expectNoColor?: boolean;
  expectContains?: { rootPc: number; templateId: ChordTemplateId }[];
};

const spec = (
  root: string,
  templateId: ChordTemplateId,
): ChordSpec => ({ root: parseRoot(root), templateId });


function parseRoot(name: string) {
  const parsed = parseSpelled(name);
  if (!parsed) throw new Error(`Invalid fixture root spelling: ${name}`);
  return parsed;
}

let noteCounter = 0;

function note(
  startTick: number,
  durationTicks: number,
  midi: number,
): MelodyNoteEvent {
  noteCounter += 1;
  return {
    id: `fixture-note-${noteCounter}`,
    startTick,
    durationTicks,
    midi,
    velocity: 100,
  };
}

const CURATED_CASES: HarmonyCase[] = [
  {
    name: 'C ionian ii–V–I jazz context',
    context: { tonic: parseRoot('C'), mode: 'ionian' },
    previousChord: spec('D', 'min7'),
    recentChords: [spec('D', 'min7'), spec('C', 'maj')],
    melodyNotes: [],
    complexity: 'basic',
    expectRomanInSuggestions: ['V'],
  },
  {
    // F4 (65) and A4 (69): third and fifth of Dm7 — the D minor family must
    // win the melody component outright.
    name: 'C ionian melody F4/A4 over Dm7 target',
    context: { tonic: parseRoot('C'), mode: 'ionian' },
    recentChords: [],
    melodyNotes: [note(0, 1920, 65), note(1920, 1920, 69)],
    complexity: 'rich',
    expectContains: [
      { rootPc: 2, templateId: 'min7' },
      { rootPc: 2, templateId: 'min9' },
    ],
  },
  {
    name: 'A aeolian Am→? expecting E major dominant',
    context: { tonic: parseRoot('A'), mode: 'aeolian' },
    previousChord: spec('A', 'min'),
    recentChords: [spec('A', 'min')],
    melodyNotes: [],
    complexity: 'basic',
    expectContains: [{ rootPc: 4, templateId: '7' }],
  },
  {
    name: 'D dorian i–IV vamp with characteristic sixth',
    context: { tonic: parseRoot('D'), mode: 'dorian' },
    previousChord: spec('D', 'min7'),
    recentChords: [spec('D', 'min7'), spec('G', 'maj')],
    melodyNotes: [note(0, 960, 71)], // B4 — the characteristic natural 6th
    complexity: 'basic',
  },
  {
    name: 'E phrygian rich palette with bII',
    context: { tonic: parseRoot('E'), mode: 'phrygian' },
    previousChord: spec('E', 'min'),
    recentChords: [spec('E', 'min')],
    melodyNotes: [],
    complexity: 'rich',
    expectContains: [{ rootPc: 5, templateId: 'maj' }],
  },
  {
    name: 'G mixolydian bVII flavor',
    context: { tonic: parseRoot('G'), mode: 'mixolydian' },
    previousChord: spec('G', 'maj'),
    recentChords: [spec('G', 'maj'), spec('C', 'maj')],
    melodyNotes: [],
    complexity: 'basic',
    expectContains: [{ rootPc: 5, templateId: 'maj' }],
  },
  {
    name: 'bVII borrowed in C ionian rich',
    context: { tonic: parseRoot('C'), mode: 'ionian' },
    previousChord: spec('C', 'maj'),
    recentChords: [spec('C', 'maj')],
    melodyNotes: [],
    complexity: 'rich',
    expectContains: [{ rootPc: 10, templateId: 'maj' }],
  },
  {
    name: 'B locrian rich without color candidates',
    context: { tonic: parseRoot('B'), mode: 'locrian' },
    previousChord: spec('B', 'dim'),
    recentChords: [spec('B', 'dim')],
    melodyNotes: [],
    complexity: 'rich',
    expectNoColor: true,
  },
  {
    name: 'First chord with empty history',
    context: { tonic: parseRoot('C'), mode: 'ionian' },
    recentChords: [],
    melodyNotes: [],
    complexity: 'basic',
  },
  {
    // F#4 (66) clashes chromatically against every C ionian candidate.
    name: 'Chromatic F#4 clash over C ionian target',
    context: { tonic: parseRoot('C'), mode: 'ionian' },
    recentChords: [],
    melodyNotes: [note(0, 1920, 66)],
    complexity: 'basic',
  },
  {
    name: 'F lydian rich exploration',
    context: { tonic: parseRoot('F'), mode: 'lydian' },
    previousChord: spec('F', 'maj7'),
    recentChords: [spec('F', 'maj7')],
    melodyNotes: [note(0, 960, 78)], // F#5 — the characteristic #4
    complexity: 'rich',
  },
];

// ---------------------------------------------------------------------------
// Hardening sweep matrix (§5 risk-1): declarative coverage expansion.
// Still pure data — every entry keeps the HarmonyCase shape.
// ---------------------------------------------------------------------------

type ModeSeed = {
  mode: HarmonyCase['context']['mode'];
  tonic: string;
  tonicChord: [string, ChordTemplateId];
  vampPartner: [string, ChordTemplateId];
  functionalChord: [string, ChordTemplateId];
  /** Characteristic modal tone for vamp melodies (midi). */
  characteristicMidi: number;
  /** Out-of-scale clash note (midi). */
  clashMidi: number;
  borrowed: [string, ChordTemplateId];
};

const SEED_IONIAN: ModeSeed = { mode: 'ionian', tonic: 'C', tonicChord: ['C', 'maj'], vampPartner: ['F', 'maj'], functionalChord: ['D', 'min7'], characteristicMidi: 71, clashMidi: 66, borrowed: ['Bb', 'maj'] };
const SEED_DORIAN: ModeSeed = { mode: 'dorian', tonic: 'D', tonicChord: ['D', 'min7'], vampPartner: ['G', 'maj'], functionalChord: ['E', 'min7'], characteristicMidi: 71, clashMidi: 70, borrowed: ['Bb', 'maj'] };
const SEED_PHRYGIAN: ModeSeed = { mode: 'phrygian', tonic: 'E', tonicChord: ['E', 'min'], vampPartner: ['F', 'maj'], functionalChord: ['F', 'maj'], characteristicMidi: 65, clashMidi: 66, borrowed: ['A', 'maj'] };
const SEED_LYDIAN: ModeSeed = { mode: 'lydian', tonic: 'F', tonicChord: ['F', 'maj7'], vampPartner: ['G', 'maj'], functionalChord: ['G', 'maj'], characteristicMidi: 71, clashMidi: 70, borrowed: ['Ab', 'maj'] };
const SEED_MIXOLYDIAN: ModeSeed = { mode: 'mixolydian', tonic: 'G', tonicChord: ['G', 'maj'], vampPartner: ['C', 'maj'], functionalChord: ['D', 'min'], characteristicMidi: 65, clashMidi: 66, borrowed: ['Bb', 'maj'] };
const SEED_AEOLIAN: ModeSeed = { mode: 'aeolian', tonic: 'A', tonicChord: ['A', 'min'], vampPartner: ['F', 'maj'], functionalChord: ['D', 'min7'], characteristicMidi: 68, clashMidi: 73, borrowed: ['D', 'maj'] };
const SEED_LOCRIAN: ModeSeed = { mode: 'locrian', tonic: 'B', tonicChord: ['B', 'dim'], vampPartner: ['C', 'maj'], functionalChord: ['C', 'maj'], characteristicMidi: 72, clashMidi: 70, borrowed: ['G', 'maj'] };

const MODE_SEEDS: ModeSeed[] = [
  SEED_IONIAN,
  SEED_DORIAN,
  SEED_PHRYGIAN,
  SEED_LYDIAN,
  SEED_MIXOLYDIAN,
  SEED_AEOLIAN,
  SEED_LOCRIAN,
];

function contextOf(seed: ModeSeed): HarmonyContext {
  return { tonic: parseRoot(seed.tonic), mode: seed.mode };
}

function spec2(chord: [string, ChordTemplateId]): ChordSpec {
  return spec(chord[0], chord[1]);
}

const sweepCases: HarmonyCase[] = [];

// All 7 modes × {first-chord empty history, functional cadence seed,
// modal vamp with characteristic tone, chromatic melody clash,
// borrowed-rich palette}.
for (const seed of MODE_SEEDS) {
  const label = `${seed.tonic} ${seed.mode}`;
  sweepCases.push(
    {
      name: `${label}: first chord, empty history`,
      context: contextOf(seed),
      recentChords: [],
      melodyNotes: [],
      complexity: 'basic',
    },
    {
      name: `${label}: functional ${seed.functionalChord[0]} cadence seed`,
      context: contextOf(seed),
      previousChord: spec2(seed.functionalChord),
      recentChords: [spec2(seed.functionalChord)],
      melodyNotes: [],
      complexity: 'basic',
    },
    {
      name: `${label}: ${seed.tonicChord[0]}–${seed.vampPartner[0]} vamp with characteristic tone`,
      context: contextOf(seed),
      previousChord: spec2(seed.tonicChord),
      recentChords: [spec2(seed.tonicChord), spec2(seed.vampPartner)],
      melodyNotes: [note(0, 960, seed.characteristicMidi)],
      complexity: 'basic',
    },
    {
      name: `${label}: chromatic melody clash`,
      context: contextOf(seed),
      recentChords: [],
      melodyNotes: [note(0, 1920, seed.clashMidi)],
      complexity: 'basic',
    },
    {
      name: `${label}: borrowed-rich palette with ${seed.borrowed[0]}${seed.borrowed[1]}`,
      context: contextOf(seed),
      previousChord: spec2(seed.tonicChord),
      recentChords: [spec2(seed.tonicChord), spec2(seed.borrowed)],
      melodyNotes: [],
      complexity: 'rich',
    },
  );
}

// ionian + aeolian extras: secondary-dominant contexts and
// rich-complexity multi-borrowed palettes.
sweepCases.push(
  {
    name: 'C ionian: secondary dominant V/V chain',
    context: contextOf(SEED_IONIAN),
    previousChord: spec('D', '7'),
    recentChords: [spec('D', '7'), spec('G', 'maj')],
    melodyNotes: [],
    complexity: 'rich',
  },
  {
    name: 'A aeolian: secondary dominant V/V chain',
    context: contextOf(SEED_AEOLIAN),
    previousChord: spec('B', '7'),
    recentChords: [spec('B', '7'), spec('E', 'maj')],
    melodyNotes: [],
    complexity: 'rich',
  },
  {
    name: 'C ionian: rich multi-borrowed complexity',
    context: contextOf(SEED_IONIAN),
    previousChord: spec('C', 'maj'),
    recentChords: [spec('C', 'maj'), spec('Ab', 'maj'), spec('Bb', 'maj')],
    melodyNotes: [],
    complexity: 'rich',
  },
  {
    name: 'A aeolian: rich multi-borrowed complexity',
    context: contextOf(SEED_AEOLIAN),
    previousChord: spec('A', 'min'),
    recentChords: [spec('A', 'min'), spec('D', 'maj'), spec('F', 'maj')],
    melodyNotes: [],
    complexity: 'rich',
  },
);

// Degenerate melody shapes over established progressions.
for (const seed of [SEED_IONIAN, SEED_DORIAN, SEED_AEOLIAN]) {
  const label = `${seed.tonic} ${seed.mode}`;
  const established = (): Pick<
    HarmonyCase,
    'context' | 'previousChord' | 'recentChords' | 'complexity'
  > => ({
    context: contextOf(seed),
    previousChord: spec2(seed.tonicChord),
    recentChords: [spec2(seed.tonicChord), spec2(seed.vampPartner)],
    complexity: 'basic',
  });
  sweepCases.push(
    { name: `${label}: degenerate empty melody`, ...established(), melodyNotes: [] },
    {
      name: `${label}: degenerate single-note melody`,
      ...established(),
      melodyNotes: [note(480, 120, 64)],
    },
    {
      name: `${label}: degenerate full-bar melody`,
      ...established(),
      melodyNotes: [note(0, 3840, 64)],
    },
    {
      name: `${label}: degenerate offbeat-only melody`,
      ...established(),
      melodyNotes: [note(240, 240, 62), note(720, 240, 64), note(1200, 240, 67)],
    },
  );
}
for (const seed of [SEED_PHRYGIAN, SEED_LYDIAN, SEED_MIXOLYDIAN, SEED_LOCRIAN]) {
  const label = `${seed.tonic} ${seed.mode}`;
  const established = (): Pick<
    HarmonyCase,
    'context' | 'previousChord' | 'recentChords' | 'complexity'
  > => ({
    context: contextOf(seed),
    previousChord: spec2(seed.tonicChord),
    recentChords: [spec2(seed.tonicChord), spec2(seed.vampPartner)],
    complexity: 'basic',
  });
  sweepCases.push(
    {
      name: `${label}: degenerate single-note melody`,
      ...established(),
      melodyNotes: [note(480, 120, 64)],
    },
    {
      name: `${label}: degenerate full-bar melody`,
      ...established(),
      melodyNotes: [note(0, 3840, 64)],
    },
  );
}

export const HARMONY_CASES: HarmonyCase[] = [...CURATED_CASES, ...sweepCases];
