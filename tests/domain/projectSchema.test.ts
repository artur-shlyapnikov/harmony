import { describe, expect, it } from 'vitest';

import { createProjectDocument, projectLengthTicks } from '@domain/model/project';
import { chordSymbol } from '@domain/model/chord';
import { pitchClassOf, spelledName, parseSpelled } from '@domain/model/pitch';
import { migrateDocument } from '@domain/validation/migrations';
import {
  projectDocumentSchema,
  validateProjectDocument,
} from '@domain/validation/projectSchema';

function validDoc() {
  return createProjectDocument({
    title: 'Test Project',
    tonic: { letter: 'F', accidental: 1 },
    mode: 'aeolian',
    bars: 8,
  });
}

function clone(doc: unknown): Record<string, unknown> {
  return structuredClone(doc) as Record<string, unknown>;
}

describe('validateProjectDocument', () => {
  it('accepts a freshly created minimal document', () => {
    const result = validateProjectDocument(validDoc());
    expect(result.ok).toBe(true);
  });

  it('round-trips a factory document through the schema unchanged', () => {
    const doc = validDoc();
    const result = validateProjectDocument(doc);
    assertOk(result);
    expect(result.document).toEqual(doc);
  });

  it('rejects a wrong schemaVersion', () => {
    const doc = clone(validDoc());
    doc.schemaVersion = 2;
    expect(validateProjectDocument(doc).ok).toBe(false);

    doc.schemaVersion = '1';
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('rejects bpm out of range', () => {
    for (const bpm of [39, 241]) {
      const doc = clone(validDoc());
      (doc.timing as Record<string, unknown>).bpm = bpm;
      expect(validateProjectDocument(doc).ok).toBe(false);
    }
  });

  it('accepts fractional bpm within the range (§3.5 has no integrality)', () => {
    const doc = clone(validDoc());
    (doc.timing as Record<string, unknown>).bpm = 120.5;
    expect(validateProjectDocument(doc).ok).toBe(true);

    // Range checks stay: fractional values outside 40..240 are rejected.
    for (const bpm of [39.5, 240.5]) {
      const ranged = clone(validDoc());
      (ranged.timing as Record<string, unknown>).bpm = bpm;
      expect(validateProjectDocument(ranged).ok).toBe(false);
    }
  });

  it('rejects bars out of range', () => {
    for (const bars of [0, -1, 129]) {
      const doc = clone(validDoc());
      (doc.timing as Record<string, unknown>).bars = bars;
      expect(validateProjectDocument(doc).ok).toBe(false);
    }
  });

  it('rejects melody midi outside 36..96', () => {
    const doc = clone(validDoc());
    (doc.melody as { notes: unknown[] }).notes = [
      {
        id: crypto.randomUUID(),
        startTick: 0,
        durationTicks: 480,
        midi: 35,
        velocity: 80,
      },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);

    ((doc.melody as { notes: unknown[] }).notes[0] as { midi: number }).midi = 97;
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('rejects negative or zero durationTicks', () => {
    const doc = clone(validDoc());
    (doc.melody as { notes: unknown[] }).notes = [
      {
        id: crypto.randomUUID(),
        startTick: 0,
        durationTicks: -240,
        midi: 60,
        velocity: 80,
      },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('rejects melody events off the §3.4 note grid (240)', () => {
    const doc = clone(validDoc());
    const notes = doc.melody as { notes: unknown[] };

    // Invalid: durationTicks is not a NOTE_GRID multiple…
    notes.notes = [
      { id: crypto.randomUUID(), startTick: 0, durationTicks: 137, midi: 60, velocity: 80 },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);

    // …and invalid: startTick is not a NOTE_GRID multiple.
    notes.notes = [
      { id: crypto.randomUUID(), startTick: 137, durationTicks: 480, midi: 60, velocity: 80 },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);

    // Valid fixture: both fields on the grid.
    notes.notes = [
      { id: crypto.randomUUID(), startTick: 240, durationTicks: 480, midi: 60, velocity: 80 },
    ];
    expect(validateProjectDocument(doc).ok).toBe(true);
  });

  it('rejects chord durationTicks not a multiple of 960', () => {
    const doc = clone(validDoc());
    (doc.harmony as { chords: unknown[] }).chords = [
      {
        id: crypto.randomUUID(),
        startTick: 0,
        durationTicks: 480,
        chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
      },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('rejects chord startTick not a multiple of 960', () => {
    const doc = clone(validDoc());
    (doc.harmony as { chords: unknown[] }).chords = [
      {
        id: crypto.randomUUID(),
        startTick: 480,
        durationTicks: 960,
        chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
      },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);

    // Valid fixture: startTick on the chord grid.
    (doc.harmony as { chords: unknown[] }).chords = [
      {
        id: crypto.randomUUID(),
        startTick: 960,
        durationTicks: 960,
        chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
      },
    ];
    expect(validateProjectDocument(doc).ok).toBe(true);
  });

  it('rejects an unknown chord templateId', () => {
    const doc = clone(validDoc());
    (doc.harmony as { chords: unknown[] }).chords = [
      {
        id: crypto.randomUUID(),
        startTick: 0,
        durationTicks: 3840,
        chord: { root: { letter: 'C', accidental: 0 }, templateId: 'power' },
      },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('rejects a bad letter', () => {
    const doc = clone(validDoc());
    (doc.harmonyContext as Record<string, unknown>).tonic = {
      letter: 'H',
      accidental: 0,
    };
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('rejects accidental beyond ±2', () => {
    for (const accidental of [-3, 3]) {
      const doc = clone(validDoc());
      (doc.harmonyContext as Record<string, unknown>).tonic = {
        letter: 'C',
        accidental,
      };
      expect(validateProjectDocument(doc).ok).toBe(false);
    }
  });

  it('rejects a non-literal voicing profile (maxVoices must be 4, §3.20)', () => {
    const doc = clone(validDoc());
    const harmony = doc.harmony as Record<string, unknown>;
    (harmony.voicingProfile as Record<string, unknown>).maxVoices = 5;
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('still validates structurally with unsorted arrays (sorting normalized elsewhere)', () => {
    const laterId = crypto.randomUUID();
    const earlierId = crypto.randomUUID();
    const doc = clone(validDoc());
    (doc.melody as { notes: unknown[] }).notes = [
      { id: laterId, startTick: 1920, durationTicks: 480, midi: 64, velocity: 90 },
      { id: earlierId, startTick: 0, durationTicks: 480, midi: 60, velocity: 80 },
    ];
    (doc.harmony as { chords: unknown[] }).chords = [
      {
        id: laterId,
        startTick: 3840,
        durationTicks: 3840,
        chord: { root: { letter: 'G', accidental: 0 }, templateId: '7' },
      },
      {
        id: earlierId,
        startTick: 0,
        durationTicks: 3840,
        chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
      },
    ];

    const result = validateProjectDocument(doc);
    expect(result.ok).toBe(true);
  });
  // Runtime-narrowed mutation of cloned documents: boundary tests must be
  // able to plant ILLEGAL values (e.g. subdivisionTicks 360) that the
  // static PatternSpec union would reject at compile time.
  function rawDoc(): Record<string, unknown> {
    return structuredClone(validDoc());
  }

  function asRecord(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected a plain object node');
    }
    return value as Record<string, unknown>;
  }

  /** Fresh cloned document carrying exactly one probe note with `velocity`. */
  function docWithMelodyVelocity(velocity: number): Record<string, unknown> {
    const doc = rawDoc();
    const notes = asRecord(doc.melody).notes;
    if (!Array.isArray(notes)) throw new Error('expected melody.notes array');
    notes.push({
      id: crypto.randomUUID(),
      startTick: 0,
      durationTicks: 480,
      midi: 60,
      velocity,
    });
    return doc;
  }

  function defaultPatternOf(doc: Record<string, unknown>): Record<string, unknown> {
    return asRecord(asRecord(doc.harmony).defaultPattern);
  }

  it.each([0, 0.5, 128, 127.5])(
    'rejects melody velocity %f outside 1..127 at both bounds (§3.5)',
    (velocity) => {
      const doc = docWithMelodyVelocity(velocity);
      expect(validateProjectDocument(doc).ok).toBe(false);
    },
  );

  it.each([1, 127])(
    'accepts boundary melody velocity %i and round-trips unchanged (§3.5)',
    (velocity) => {
      const doc = docWithMelodyVelocity(velocity);
      const result = validateProjectDocument(doc);
      expect(result.ok).toBe(true);
      assertOk(result);
      expect(result.document).toEqual(doc);
    },
  );

  it('accepts pattern gate exactly 0.1 and 1, rejects 0.099 and 1.001 (§3.6)', () => {
    for (const gate of [0.1, 1]) {
      const doc = rawDoc();
      defaultPatternOf(doc).gate = gate;
      expect(validateProjectDocument(doc).ok).toBe(true);
    }
    for (const gate of [0.099, 1.001]) {
      const doc = rawDoc();
      defaultPatternOf(doc).gate = gate;
      expect(validateProjectDocument(doc).ok).toBe(false);
    }
  });

  it('admits only subdivisionTicks 240, 480 and 960 (§3.6)', () => {
    for (const subdivisionTicks of [240, 480, 960]) {
      const doc = rawDoc();
      defaultPatternOf(doc).subdivisionTicks = subdivisionTicks;
      expect(validateProjectDocument(doc).ok).toBe(true);
    }
    for (const subdivisionTicks of [120, 1920, 360]) {
      const doc = rawDoc();
      defaultPatternOf(doc).subdivisionTicks = subdivisionTicks;
      expect(validateProjectDocument(doc).ok).toBe(false);
    }
  });

  it('admits only octaveSpan 1 and 2 (§3.6)', () => {
    for (const octaveSpan of [1, 2]) {
      const doc = rawDoc();
      defaultPatternOf(doc).octaveSpan = octaveSpan;
      expect(validateProjectDocument(doc).ok).toBe(true);
    }
    for (const octaveSpan of [0, 3]) {
      const doc = rawDoc();
      defaultPatternOf(doc).octaveSpan = octaveSpan;
      expect(validateProjectDocument(doc).ok).toBe(false);
    }
  });

  it.each([0, 128])('rejects pattern velocity %f outside 1..127 (§3.6 mirrors §3.5)', (velocity) => {
    const doc = rawDoc();
    defaultPatternOf(doc).velocity = velocity;
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it.each([1, 127])(
    'accepts boundary pattern velocity %i and round-trips unchanged (§3.6 mirrors §3.5)',
    (velocity) => {
      const doc = rawDoc();
      defaultPatternOf(doc).velocity = velocity;
      const result = validateProjectDocument(doc);
      expect(result.ok).toBe(true);
      assertOk(result);
      expect(result.document).toEqual(doc);
    },
  );


  function docWithChordPatternOverride(
    patternOverride: unknown,
  ): Record<string, unknown> {
    const doc = rawDoc();
    (asRecord(doc.harmony).chords as unknown[]).push({
      id: crypto.randomUUID(),
      startTick: 0,
      durationTicks: 960,
      chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
      patternOverride,
    });
    return doc;
  }
  const VALID_OVERRIDE = {
    kind: 'up',
    subdivisionTicks: 480,
    gate: 0.8,
    octaveSpan: 1,
    velocity: 80,
  };
  it('accepts a chord event carrying a valid patternOverride and round-trips it unchanged (§3.6 embedding)', () => {
    const doc = docWithChordPatternOverride(VALID_OVERRIDE);
    const result = validateProjectDocument(doc);
    expect(result.ok).toBe(true);
    assertOk(result);
    // Deep equality against the input proves the optional embedded spec
    // survives validation untouched.
    expect(result.document).toEqual(doc);
  });

  it.each([
    ['gate 1.001', { ...VALID_OVERRIDE, gate: 1.001 }],
    ['subdivisionTicks 360', { ...VALID_OVERRIDE, subdivisionTicks: 360 }],
    ['octaveSpan 3', { ...VALID_OVERRIDE, octaveSpan: 3 }],
    ['velocity 0', { ...VALID_OVERRIDE, velocity: 0 }],
  ])('rejects an embedded patternOverride with illegal %s (§3.6 embedding)', (_label, badPattern) => {
    expect(validateProjectDocument(docWithChordPatternOverride(badPattern)).ok).toBe(false);
  });
  it.each([40, 240])('accepts bpm exactly %f and round-trips unchanged (§3.5)', (bpm) => {
    const doc = rawDoc();
    asRecord(doc.timing).bpm = bpm;
    const result = validateProjectDocument(doc);
    expect(result.ok).toBe(true);
    assertOk(result);
    expect(result.document).toEqual(doc);
  });

  it.each([39.9, 240.1])('rejects bpm %f just past the range edges (§3.5)', (bpm) => {
    const doc = rawDoc();
    asRecord(doc.timing).bpm = bpm;
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it.each([1, 128])('accepts bars exactly %i and round-trips unchanged (§3.5)', (bars) => {
    const doc = rawDoc();
    asRecord(doc.timing).bars = bars;
    const result = validateProjectDocument(doc);
    expect(result.ok).toBe(true);
    assertOk(result);
    expect(result.document).toEqual(doc);
  });

  it.each([0, 129])('rejects bars %i just past the range edges (§3.5)', (bars) => {
    const doc = rawDoc();
    asRecord(doc.timing).bars = bars;
    expect(validateProjectDocument(doc).ok).toBe(false);
  });


});

describe('migrateDocument', () => {
  it('validates a V1 document without migrations', () => {
    const result = migrateDocument(validDoc());
    expect(result.ok).toBe(true);
  });

  it('rejects invalid documents', () => {
    const doc = clone(validDoc());
    doc.schemaVersion = 99;
    expect(migrateDocument(doc).ok).toBe(false);
  });
});

describe('createProjectDocument', () => {
  it('produces defaults per contract and round-trips through the schema', () => {
    const doc = createProjectDocument({
      title: 'New Song',
      tonic: { letter: 'B', accidental: -1 },
      mode: 'ionian',
    });

    expect(doc.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(doc.createdAt).toBe(doc.updatedAt);
    expect(doc.timing.ppq).toBe(960);
    expect(doc.timing.bars).toBe(8);
    expect(doc.timing.bpm).toBe(120);
    expect(doc.melody.notes).toEqual([]);
    expect(doc.harmony.chords).toEqual([]);
    expect(doc.harmony.defaultPattern).toEqual({
      kind: 'block',
      subdivisionTicks: 480,
      gate: 0.9,
      octaveSpan: 1,
      velocity: 80,
    });
    expect(doc.harmony.voicingProfile).toEqual({
      lowMidi: 43,
      highMidi: 79,
      maxVoices: 4,
      maxSpanSemitones: 24,
      maxUpperGapSemitones: 12,
      maxBassGapSemitones: 16,
      centerMidi: 60,
    });
    expect(projectDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('computes length ticks from bars', () => {
    expect(projectLengthTicks(validDoc())).toBe(8 * 3840);
  });
});

describe('pitch helpers', () => {
  it('maps spelled pitches to pitch classes', () => {
    expect(pitchClassOf({ letter: 'C', accidental: 0 })).toBe(0);
    expect(pitchClassOf({ letter: 'F', accidental: 1 })).toBe(6);
    expect(pitchClassOf({ letter: 'B', accidental: -1 })).toBe(10);
    expect(spelledName({ letter: 'B', accidental: -1 })).toBe('Bb');
  });

  it('parses canonical names and rejects garbage', () => {
    expect(parseSpelled('F#')).toEqual({ letter: 'F', accidental: 1 });
    expect(parseSpelled('Bb')).toEqual({ letter: 'B', accidental: -1 });
    expect(parseSpelled('H')).toBeNull();
    expect(parseSpelled('E###')).toBeNull();
  });
});

describe('chordSymbol', () => {
  it('combines root name and display suffix', () => {
    expect(
      chordSymbol({ root: { letter: 'F', accidental: 1 }, templateId: 'min7' }),
    ).toBe('F#m7');
    expect(
      chordSymbol({ root: { letter: 'C', accidental: 0 }, templateId: 'maj' }),
    ).toBe('C');
  });
});

describe('lane id uniqueness (§3.18 corrupt-project recovery)', () => {
  it('rejects a document with duplicate melody note ids', () => {
    const doc = clone(validDoc());
    const note = { id: 'dup', startTick: 0, durationTicks: 240, midi: 60, velocity: 90 };
    (doc.melody as { notes: unknown[] }).notes = [note, { ...note, startTick: 240 }];
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('rejects a document with duplicate chord ids', () => {
    const doc = clone(validDoc());
    const chord = {
      id: 'dup-chord',
      startTick: 0,
      durationTicks: 960,
      chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
    };
    (doc.harmony as { chords: unknown[] }).chords = [
      chord,
      { ...chord, startTick: 960 },
    ];
    expect(validateProjectDocument(doc).ok).toBe(false);
  });

  it('still accepts unique ids within each lane', () => {
    const doc = clone(validDoc());
    const note = { startTick: 0, durationTicks: 240, midi: 60, velocity: 90 };
    (doc.melody as { notes: unknown[] }).notes = [
      { ...note, id: 'a' },
      { ...note, id: 'b', startTick: 240 },
    ];
    const chord = {
      startTick: 0,
      durationTicks: 960,
      chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
    };
    (doc.harmony as { chords: unknown[] }).chords = [
      { ...chord, id: 'c1' },
      { ...chord, id: 'c2', startTick: 960 },
    ];
    expect(validateProjectDocument(doc).ok).toBe(true);
  });
});

describe('validateProjectDocument boundaries (round 4)', () => {
  // Factory-produced documents are structurally known; each mutation below
  // names the lane it rewrites via a single checked-at-write-site const.
  function docWithMelodyOverride(spellingOverride: unknown): Record<string, unknown> {
    const doc = clone(validDoc());
    // The factory document's melody lane is a known object with a notes array.
    const melody = doc.melody as { notes: unknown[] };
    melody.notes = [
      {
        id: crypto.randomUUID(),
        startTick: 0,
        durationTicks: 480,
        midi: 65,
        velocity: 80,
        spellingOverride,
      },
    ];
    return doc;
  }

  // SCH-O7: the OPTIONAL spellingOverride embedding path on the MELODY lane
  // (tonic-level letter/accidental cases above are harmonyContext, not this).
  it('accepts a melody event carrying a valid spellingOverride and round-trips it unchanged (§3.5 embedding)', () => {
    const doc = docWithMelodyOverride({ letter: 'F', accidental: 1 });
    const result = validateProjectDocument(doc);
    expect(result.ok).toBe(true);
    assertOk(result);
    expect(result.document).toEqual(doc);
  });

  it.each([
    ['a bad letter', { letter: 'H', accidental: 0 }],
    ['accidental beyond +2', { letter: 'C', accidental: 3 }],
    ['accidental beyond -2', { letter: 'C', accidental: -3 }],
    ['a non-object override', 'F#'],
  ] as const)('rejects an embedded melody spellingOverride with %s (§3.5 embedding)', (_label, badOverride) => {
    expect(validateProjectDocument(docWithMelodyOverride(badOverride)).ok).toBe(false);
  });

  // SCH-M8: the document envelope (§3.5/§3.18) — min(1) title/id and
  // RFC3339-with-offset datetimes.
  it.each([
    ['an empty title', (doc: Record<string, unknown>) => {
      doc.title = '';
    }],
    ['an empty id', (doc: Record<string, unknown>) => {
      doc.id = '';
    }],
    ['a date-only createdAt (no offset)', (doc: Record<string, unknown>) => {
      doc.createdAt = '2024-01-01';
    }],
    ['a non-date updatedAt', (doc: Record<string, unknown>) => {
      doc.updatedAt = 'not-a-date';
    }],
  ])('rejects document metadata with %s', (_label, mutate) => {
    const doc = clone(validDoc());
    mutate(doc);
    expect(validateProjectDocument(doc).ok).toBe(false);
  });
});

describe('validateProjectDocument boundaries (round 5)', () => {
  // SCH-B10: the §3.5 canonical midi range has an ACCEPT side through the
  // validate path — inward drift of .min(36)/.max(96) must fail something.
  // Complements (does not repeat) the 35/97 rejects in the midi test above.
  it.each([36, 96])('accepts melody midi at exactly %i and round-trips it unchanged (§3.5)', (midi) => {
    const doc = clone(validDoc());
    // Factory document: the melody lane node is structurally known.
    const melody = doc.melody as { notes: unknown[] };
    melody.notes = [
      { id: crypto.randomUUID(), startTick: 0, durationTicks: 480, midi, velocity: 80 },
    ];
    const result = validateProjectDocument(doc);
    expect(result.ok).toBe(true);
    assertOk(result);
    expect(result.document).toEqual(doc);
  });

  it('rejects a voicing-profile lowMidi/highMidi outside the canonical range (§3.5)', () => {
    const low = clone(validDoc());
    // Factory document: harmony.voicingProfile is a known object node.
    const lowProfile = (low.harmony as { voicingProfile: Record<string, unknown> }).voicingProfile;
    lowProfile.lowMidi = 35;
    expect(validateProjectDocument(low).ok).toBe(false);

    const high = clone(validDoc());
    // Factory document: harmony.voicingProfile is a known object node.
    const highProfile = (
      high.harmony as { voicingProfile: Record<string, unknown> }
    ).voicingProfile;
    highProfile.highMidi = 97;
    expect(validateProjectDocument(high).ok).toBe(false);
  });

  // SCH-D1: the envelope datetimes parse z.string().datetime({ offset: true })
  // — an offset-form RFC3339 timestamp must be accepted and survive the
  // validate path unchanged; removing `offset: true` fails cell 1 only.
  it('accepts offset-form RFC3339 createdAt/updatedAt and round-trips them unchanged (§3.5)', () => {
    const doc = clone(validDoc());
    doc.createdAt = '2026-01-01T12:00:00+02:00';
    doc.updatedAt = '2026-01-01T12:00:00+02:00';
    const result = validateProjectDocument(doc);
    expect(result.ok).toBe(true);
    assertOk(result);
    expect(result.document.createdAt).toBe('2026-01-01T12:00:00+02:00');
    expect(result.document.updatedAt).toBe('2026-01-01T12:00:00+02:00');
  });

  it('still rejects a timestamp with time but no zone (§3.5 negative control)', () => {
    const doc = clone(validDoc());
    doc.createdAt = '2026-01-01T12:00:00';
    expect(validateProjectDocument(doc).ok).toBe(false);
  });
});

function assertOk<T>(
  result: { ok: true; document: T } | { ok: false; error: string },
): asserts result is { ok: true; document: T } {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
}
