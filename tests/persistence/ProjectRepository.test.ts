import 'fake-indexeddb/auto';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  createProjectDocument,
  projectLengthTicks,
  type ProjectDocumentV1,
} from '@domain/model/project';
import { CHORD_GRID, NOTE_GRID } from '@domain/timeline/constants';
import { db, type ProjectRecord } from '@persistence/db';
import {
  CorruptProjectError,
  DexieProjectRepository,
  makeRepository,
  UnsupportedSchemaError,
  type ProjectRepository,
} from '@persistence/ProjectRepository';
import { createAutosave, type SaveStatusListener } from '@persistence/autosave';
import { buildBackupPayload } from '@persistence/backup';

function makeDoc(title: string): ProjectDocumentV1 {
  return createProjectDocument({
    title,
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });
}

/** Drain pending microtasks so resolved promises settle. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(async () => {
  await Promise.all([db.table('projects').clear(), db.table('settings').clear()]);
});

describe('DexieProjectRepository', () => {
  let repository: DexieProjectRepository;

  beforeEach(() => {
    repository = new DexieProjectRepository();
  });

  it('round-trips save → load deep-equal', async () => {
    const doc = makeDoc('Round trip');
    doc.melody.notes.push({
      id: 'n1',
      startTick: 0,
      durationTicks: 960,
      midi: 60,
      velocity: 100,
    });

    await repository.save(doc);
    const loaded = await repository.load(doc.id);

    expect(loaded).toEqual(doc);
    expect(loaded.schemaVersion).toBe(1);
  });

  it('lists summaries sorted by updatedAt descending', async () => {
    const older = makeDoc('Older');
    const newer = makeDoc('Newer');
    const oldest = makeDoc('Oldest');

    const base = '2026-01-01T00:00:00.000Z';
    older.updatedAt = base;
    newer.updatedAt = '2026-03-01T00:00:00.000Z';
    oldest.updatedAt = '2025-12-01T00:00:00.000Z';

    // Insert in scrambled order to prove sorting comes from the query layer.
    await repository.save(newer);
    await repository.save(oldest);
    await repository.save(older);

    const summaries = await repository.list();

    expect(summaries.map((s) => s.title)).toEqual(['Newer', 'Older', 'Oldest']);
    expect(summaries.map((s) => s.id)).toEqual([
      newer.id,
      older.id,
      oldest.id,
    ]);
  });

  it('list summaries carry musical meta read off the stored payload', async () => {
    const doc = makeDoc('Meta');
    doc.timing.bars = 16;
    doc.melody.notes.push(
      { id: 'n1', startTick: 0, durationTicks: 960, midi: 60, velocity: 100 },
      { id: 'n2', startTick: NOTE_GRID, durationTicks: 960, midi: 62, velocity: 100 },
    );
    doc.harmony.chords.push(
      {
        id: 'c1',
        startTick: 0,
        durationTicks: CHORD_GRID,
        chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
      },
      {
        id: 'c2',
        startTick: CHORD_GRID,
        durationTicks: CHORD_GRID,
        chord: { root: { letter: 'G', accidental: 0 }, templateId: 'maj' },
      },
      {
        id: 'c3',
        startTick: CHORD_GRID * 2,
        durationTicks: CHORD_GRID,
        chord: { root: { letter: 'F', accidental: 0 }, templateId: 'maj' },
      },
    );
    await repository.save(doc);

    const summaries = await repository.list();
    expect(summaries[0]?.meta).toEqual({
      tonic: 'C',
      mode: 'ionian',
      bars: 16,
      chordCount: 3,
      noteCount: 2,
    });
  });

  it('a record whose payload is unreadable lists without meta instead of throwing', async () => {
    await repository.save(makeDoc('Good'));
    const corrupt: ProjectRecord = {
      id: 'bad',
      title: 'Bad',
      updatedAt: '2026-01-02T00:00:00.000Z',
      schemaVersion: 1,
      payload: { schemaVersion: 1, timing: { bars: 'many' } },
    };
    await db.table('projects').put(corrupt);

    const summaries = await repository.list();
    expect(summaries.map((s) => s.title)).toEqual(['Good', 'Bad']);
    expect(summaries.find((s) => s.id === 'good')?.meta).toBeUndefined();
    expect(summaries.find((s) => s.id === 'bad')?.meta).toBeUndefined();
  });

  it('every summarizePayload guard arm independently strips meta from a hostile record', async () => {
    const good = makeDoc('Good');
    good.timing.bars = 8;
    good.melody.notes.push({
      id: 'n1',
      startTick: 0,
      durationTicks: 960,
      midi: 60,
      velocity: 100,
    });
    good.harmony.chords.push({
      id: 'c1',
      startTick: 0,
      durationTicks: CHORD_GRID,
      chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
    });
    await repository.save(good);

    const hostile: Array<[string, (doc: ProjectDocumentV1) => void]> = [
      ['bad-bars-nan', (doc) => void (doc.timing.bars = Number.NaN)],
      ['bad-letter', (doc) => void (doc.harmonyContext.tonic.letter = 'H' as never)],
      ['bad-accidental-3', (doc) => void (doc.harmonyContext.tonic.accidental = 3 as never)],
      ['bad-tonic-null', (doc) => void (doc.harmonyContext.tonic = null as never)],
      ['bad-letter-proto', (doc) => void (doc.harmonyContext.tonic.letter = '__proto__' as never)],
      ['bad-letter-toString', (doc) => void (doc.harmonyContext.tonic.letter = 'toString' as never)],
      ['bad-accidental-float', (doc) => void (doc.harmonyContext.tonic.accidental = 1.5 as never)],
      ['bad-mode', (doc) => void (doc.harmonyContext.mode = 'ionian!' as never)],
      ['bad-notes', (doc) => void (doc.melody.notes = 'not-an-array' as never)],
      ['bad-chords', (doc) => void (doc.harmony.chords = {} as never)],
    ];
    let n = 0;
    for (const [id, mutate] of hostile) {
      const doc = structuredClone(good);
      mutate(doc);
      n += 1;
      await db.table('projects').put({
        id,
        title: `Bad ${n}`,
        updatedAt: `2026-01-${String(n + 2).padStart(2, '0')}T00:00:00.000Z`,
        schemaVersion: 1,
        payload: doc,
      });
    }

    // Non-object payloads take the early return: listed without meta, never thrown on.
    await db.table('projects').bulkPut([
      { id: 'bad-null', title: 'Bad null', updatedAt: '2026-01-13T00:00:00.000Z',
        schemaVersion: 1, payload: null },
      { id: 'bad-str', title: 'Bad str', updatedAt: '2026-01-14T00:00:00.000Z',
        schemaVersion: 1, payload: 'garbage' },
    ]);

    const summaries = await repository.list();
    expect(summaries).toHaveLength(13);
    expect(summaries.find((s) => s.id === good.id)?.meta).toEqual({
      tonic: 'C',
      mode: 'ionian',
      bars: 8,
      chordCount: 1,
      noteCount: 1,
    });
    for (const [id] of [...hostile, ['bad-null'], ['bad-str']] as Array<[string]>) {
      expect(summaries.find((s) => s.id === id)?.meta).toBeUndefined();
    }
    expect(summaries.map((s) => s.title)).toEqual([
      'Good',
      'Bad str',
      'Bad null',
      'Bad 10',
      'Bad 9',
      'Bad 8',
      'Bad 7',
      'Bad 6',
      'Bad 5',
      'Bad 4',
      'Bad 3',
      'Bad 2',
      'Bad 1',
    ]);
  });

  it('list omits the meta key entirely for rows without a readable payload', async () => {
    await repository.save(makeDoc('Good'));
    await db.table('projects').put({
      id: 'bare', title: 'Bare', updatedAt: '2026-01-02T00:00:00.000Z',
      schemaVersion: 1, payload: { schemaVersion: 1, timing: { bars: 'many' } },
    });

    const summaries = await repository.list();
    expect(Object.hasOwn(summaries.find((s) => s.id === 'bare')!, 'meta')).toBe(false);
    expect(Object.hasOwn(summaries.find((s) => s.id !== 'bare')!, 'meta')).toBe(true);
  });

  it('duplicate creates a new id/title/timestamps and persists the copy', async () => {
    const original = makeDoc('Original');
    await repository.save(original);

    const before = new Date().toISOString();
    const copy = await repository.duplicate(original.id, 'Copy');

    expect(copy.id).not.toBe(original.id);
    expect(copy.title).toBe('Copy');
    // Fresh timestamps, identical on the copy itself.
    expect(Date.parse(copy.createdAt)).toBeGreaterThanOrEqual(Date.parse(before));
    expect(copy.createdAt).toBe(copy.updatedAt);

    const persisted = await repository.load(copy.id);
    expect(persisted).toEqual(copy);

    const summaries = await repository.list();
    expect(summaries).toHaveLength(2);
  });

  it('duplicate is byte-faithful to the stored source apart from id/title/timestamps', async () => {
    const doc = makeDoc('Source');
    // Stored in non-canonical order with boundary values (startTick 0): the
    // copy must mirror the stored bytes, not a re-normalized view.
    doc.melody.notes.push(
      { id: 'n1', startTick: NOTE_GRID, durationTicks: NOTE_GRID * 2, midi: 64, velocity: 90 },
      { id: 'n2', startTick: 0, durationTicks: 960, midi: 60, velocity: 100 },
    );
    await repository.save(doc);

    const copy = await repository.duplicate(doc.id, 'Copy');

    const {
      id: _id,
      title: _title,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...sourceRest
    } = structuredClone(doc);
    const {
      id: copyId,
      title: copyTitle,
      createdAt: _copyCreatedAt,
      updatedAt: _copyUpdatedAt,
      ...copyRest
    } = copy;

    expect(copyId).not.toBe(doc.id);
    expect(copyTitle).toBe('Copy');
    expect(copyRest).toEqual(sourceRest);

    // The persisted copy round-trips identically once load() applies its
    // ordering normalization.
    const sortedCopy = structuredClone(copy);
    const byStartThenId = (a: { startTick: number; id: string }, b: { startTick: number; id: string }) =>
      a.startTick !== b.startTick ? a.startTick - b.startTick : a.id < b.id ? -1 : 1;
    sortedCopy.melody.notes.sort(byStartThenId);
    sortedCopy.harmony.chords.sort(byStartThenId);
    await expect(repository.load(copy.id)).resolves.toEqual(sortedCopy);
  });

  it('falls back to the record schemaVersion column when the payload omits it', async () => {
    const doc = makeDoc('No payload version');
    const payload = structuredClone(doc) as Record<string, unknown>;
    delete payload.schemaVersion;
    await db.table('projects').put({
      id: doc.id,
      title: doc.title,
      updatedAt: doc.updatedAt,
      schemaVersion: doc.schemaVersion,
      payload,
    });

    const loaded = await repository.load(doc.id);

    expect(loaded.schemaVersion).toBe(1);
    expect(loaded).toEqual(doc);
  });

  it('delete removes the project', async () => {
    const doc = makeDoc('Doomed');
    await repository.save(doc);
    await repository.delete(doc.id);

    await expect(repository.load(doc.id)).rejects.toThrow(/not found/);
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('load of corrupt payload throws CorruptProjectError with raw preserved and record untouched', async () => {
    const raw = { schemaVersion: 1, timing: { bpm: 999 }, title: 'Broken' };
    await db.table('projects').put({
      id: 'corrupt-1',
      title: 'Broken',
      updatedAt: '2026-02-02T00:00:00.000Z',
      schemaVersion: 1,
      payload: raw,
    });

    let caught: unknown;
    try {
      await repository.load('corrupt-1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CorruptProjectError);
    const corrupt = caught as CorruptProjectError;
    expect(corrupt.details.projectId).toBe('corrupt-1');
    expect(corrupt.details.raw).toEqual(raw);
    expect(corrupt.details.reason).toBeTruthy();

    // The raw record was NOT overwritten by the failed load.
    const stored = await db.table<ProjectRecord>('projects').get('corrupt-1');
    expect(stored?.payload).toEqual(raw);
  });

  it('load of a future schemaVersion throws UnsupportedSchemaError with raw preserved', async () => {
    const raw = { schemaVersion: 2, someFutureField: true };
    await db.table('projects').put({
      id: 'future-1',
      title: 'From the future',
      updatedAt: '2026-04-04T00:00:00.000Z',
      schemaVersion: 2,
      payload: raw,
    });

    let caught: unknown;
    try {
      await repository.load('future-1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnsupportedSchemaError);
    const unsupported = caught as UnsupportedSchemaError;
    expect(unsupported.schemaVersion).toBe(2);
    expect(unsupported.raw).toEqual(raw);
    expect(unsupported.raw).not.toBe(null);

    const stored = await db.table<ProjectRecord>('projects').get('future-1');
    expect(stored?.payload).toEqual(raw);
  });

  it('makeRepository returns the Dexie-backed implementation', () => {
    expect(makeRepository()).toBeInstanceOf(DexieProjectRepository);
  });
});

describe('createAutosave', () => {
  type SaveGate = { resolve: () => void };
  let saves: ProjectDocumentV1[];
  let gates: SaveGate[];

  /** Repository whose saves block until their gate is released. */
  function gatedRepository(): ProjectRepository {
    return {
      list: async () => [],
      load: async () => {
        throw new Error('not used');
      },
      save: (project) =>
        new Promise<void>((resolve) => {
          saves.push(project);
          gates.push({ resolve });
        }),
      delete: async () => {},
      duplicate: async () => {
        throw new Error('not used');
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    saves = [];
    gates = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function statusesOf(listenerCalls: Array<{ status: string; generation: number }>) {
    return listenerCalls
      .filter((c) => c.status === 'saved')
      .map((c) => c.status + ':' + c.generation);
  }

  function recordingListener() {
    const calls: Array<{ status: string; generation: number; errorMessage?: string }> = [];
    const listener: SaveStatusListener = (status, generation, errorMessage) => {
      calls.push({ status, generation, ...(errorMessage !== undefined && { errorMessage }) });
    };
    return { calls, listener };
  }

  it('debounces: no save before 750ms, one save after', async () => {
    const repo = gatedRepository();
    const autosave = createAutosave(repo);
    const doc = makeDoc('Debounce');

    autosave.schedule(doc);
    await vi.advanceTimersByTimeAsync(749);
    expect(saves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual(doc);
  });

  it('rapid schedules coalesce to a single save of the latest document', async () => {
    const repo = gatedRepository();
    const autosave = createAutosave(repo);

    autosave.schedule(makeDoc('v1'));
    autosave.schedule(makeDoc('v2'));
    autosave.schedule(makeDoc('v3'));

    await vi.advanceTimersByTimeAsync(750);

    expect(saves).toHaveLength(1);
    expect(saves[0]?.title).toBe('v3');
  });

  it('a stale-generation run emits no status under serialized runs (§3.16)', async () => {
    const repo = gatedRepository();
    const { calls, listener } = recordingListener();
    const autosave = createAutosave(repo, { onStatus: listener });

    autosave.schedule(makeDoc('first')); // generation 1
    await vi.advanceTimersByTimeAsync(750); // first save starts (slow)
    expect(gates).toHaveLength(1);

    autosave.schedule(makeDoc('second')); // generation 2
    await vi.advanceTimersByTimeAsync(750); // second run queues behind the in-flight first
    // Runs are serialized (§3.16/§3.18 last-write-wins): the newest document
    // must win in storage, so the second save cannot start until the slow
    // first one settles.
    expect(gates).toHaveLength(1);

    gates[0]?.resolve(); // stale one settles first here; status stays silent
    await drain();
    expect(gates).toHaveLength(2); // only now does the newer save start
    gates[1]?.resolve();
    await drain();

    expect(statusesOf(calls)).toEqual(['saved:2']);
    expect(calls.at(-1)?.status).toBe('saved');
    expect(calls.at(-1)?.generation).toBe(autosave.generation());
  });

  it('reports error status when the latest save fails', async () => {
    const failingRepo: ProjectRepository = {
      list: async () => [],
      load: async () => {
        throw new Error('not used');
      },
      save: async () => {
        throw new Error('quota exceeded');
      },
      delete: async () => {},
      duplicate: async () => {
        throw new Error('not used');
      },
    };
    const { calls, listener } = recordingListener();
    const autosave = createAutosave(failingRepo, { onStatus: listener });

    autosave.schedule(makeDoc('fails'));
    await vi.advanceTimersByTimeAsync(750);

    const last = calls.at(-1);
    expect(last?.status).toBe('error');
    expect(last?.generation).toBe(autosave.generation());
    expect(last?.errorMessage).toContain('quota exceeded');
  });

  it('cancel prevents the debounced save', async () => {
    const repo = gatedRepository();
    const autosave = createAutosave(repo);

    autosave.schedule(makeDoc('cancelled'));
    autosave.cancel();
    await vi.advanceTimersByTimeAsync(2000);

    expect(saves).toHaveLength(0);
  });

  it('flush saves immediately without waiting for the debounce', async () => {
    const repo = gatedRepository();
    const autosave = createAutosave(repo);

    autosave.schedule(makeDoc('urgent'));
    const flushPromise = autosave.flush();
    // Storage idle: the promoted save starts synchronously inside flush().
    expect(saves).toHaveLength(1);
    gates[0]?.resolve();
    await flushPromise;

    expect(saves[0]?.title).toBe('urgent');
  });
});

describe('buildBackupPayload', () => {
  it('produces pretty JSON containing title and schemaVersion 1', () => {
    const doc = makeDoc('Backup me');
    const payload = buildBackupPayload(doc);

    expect(JSON.parse(payload)).toEqual(doc);
    expect(payload).toContain('"schemaVersion": 1');
    expect(payload).toContain('"title": "Backup me"');
    expect(payload).toContain('\n'); // pretty-printed
  });
});

describe('load-path normalization (§3.18 step 5 «нормализовать arrays and ordering»)', () => {
  it('preserves valid events byte-faithfully, sorting both lanes on load', async () => {
    const repository = new DexieProjectRepository();
    const doc = createProjectDocument({
      title: 'Unsorted raw record',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
      bars: 2,
    });
    const lengthTicks = projectLengthTicks(doc); // 2 bars * 3840

    // Hand-crafted payload written straight into Dexie, bypassing the
    // repository save path entirely: grid-legal (§3.4) but unsorted arrays
    // and events at/beyond the project length.
    const payload = {
      ...structuredClone(doc),
      melody: {
        notes: [
          { id: 'n2', startTick: NOTE_GRID * 5, durationTicks: NOTE_GRID * 2, midi: 60, velocity: 100 },
          { id: 'n1', startTick: NOTE_GRID, durationTicks: NOTE_GRID * 3, midi: 62, velocity: 100 },
          { id: 'n3', startTick: lengthTicks, durationTicks: NOTE_GRID, midi: 67, velocity: 100 },
        ],
      },
      harmony: {
        ...doc.harmony,
        chords: [
          {
            id: 'c2',
            startTick: CHORD_GRID * 5,
            durationTicks: CHORD_GRID * 4,
            chord: { root: { letter: 'G', accidental: 0 }, templateId: 'maj' },
          },
          {
            id: 'c1',
            startTick: CHORD_GRID,
            durationTicks: CHORD_GRID * 2,
            chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
          },
          {
            id: 'c3',
            startTick: lengthTicks + CHORD_GRID,
            durationTicks: CHORD_GRID * 4,
            chord: { root: { letter: 'F', accidental: 0 }, templateId: 'maj' },
          },
        ],
      },
    };
    await db.table('projects').put({
      id: doc.id,
      title: doc.title,
      updatedAt: doc.updatedAt,
      schemaVersion: doc.schemaVersion,
      payload,
    });

    const loaded = await repository.load(doc.id);

    // Sorting only: grid-legal starts/durations are NOT quantized and events
    // at/beyond the project length are NOT trimmed.
    expect(loaded.melody.notes.map((n) => [n.id, n.startTick, n.durationTicks])).toEqual([
      ['n1', NOTE_GRID, NOTE_GRID * 3],
      ['n2', NOTE_GRID * 5, NOTE_GRID * 2],
      ['n3', lengthTicks, NOTE_GRID],
    ]);
    expect(loaded.harmony.chords.map((c) => [c.id, c.startTick, c.durationTicks])).toEqual([
      ['c1', CHORD_GRID, CHORD_GRID * 2],
      ['c2', CHORD_GRID * 5, CHORD_GRID * 4],
      ['c3', lengthTicks + CHORD_GRID, CHORD_GRID * 4],
    ]);

    // Byte-faithful apart from lane ordering.
    const expected = structuredClone(payload);
    expected.melody.notes.sort((a, b) =>
      a.startTick !== b.startTick ? a.startTick - b.startTick : a.id < b.id ? -1 : 1,
    );
    expected.harmony.chords.sort((a, b) =>
      a.startTick !== b.startTick ? a.startTick - b.startTick : a.id < b.id ? -1 : 1,
    );
    expect(loaded).toEqual(expected);
  });
});
