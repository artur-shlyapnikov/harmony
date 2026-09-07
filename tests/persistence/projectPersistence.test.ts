/**
 * Semantic persistence façade (§3.16/§3.18): the guarantees the decorated
 * repository used to provide at the composition root now live INSIDE
 * createProjectPersistence:
 *  - open()/duplicate() flush un-persisted autosave attempts BEFORE touching
 *    storage (stale-read race / duplicate freshness);
 *  - delete() discards not-yet-started autosave attempts for the deleted id
 *    only (deleted-project resurrection), leaving other ids' attempts alive;
 *  - status events carry projectId and a project-switch flush freezes stale
 *    generations while still reporting its own boolean outcome;
 *  - failures arrive as stable result kinds, never thrown error classes.
 *
 * The repository is injected with call-order recording fakes; autosave and
 * every fence under test are the real production implementations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import type { ProjectPersistence } from '../../src/persistence/projectPersistence';
import {
  CorruptProjectError,
  ProjectNotFoundError,
  UnsupportedSchemaError,
  type ProjectRepository,
} from '../../src/persistence/ProjectRepository';
import { createProjectDocument } from '../../src/domain/model/project';
import type { ProjectDocumentV1 } from '../../src/domain/model/project';

function makeDoc(title: string): ProjectDocumentV1 {
  return createProjectDocument({
    title,
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });
}

type RecordingBase = ProjectRepository & {
  /** Storage operations in exact issue/completion order. */
  order: string[];
  savedTitles: string[];
};

/** Base repository recording the order and payloads of storage operations. */
function installRecordingBase(): RecordingBase {
  const order: string[] = [];
  const savedTitles: string[] = [];
  const base = {
    order,
    savedTitles,
    list: vi.fn(async () => []),
    load: vi.fn(async (): Promise<ProjectDocumentV1> => {
      order.push('load');
      return makeDoc('загруженный');
    }),
    save: vi.fn(async (project: ProjectDocumentV1) => {
      savedTitles.push(project.title);
      order.push(`save:${project.title}`);
    }),
    delete: vi.fn(async () => {
      order.push('delete');
    }),
    duplicate: vi.fn(async (_id: string, newTitle: string): Promise<ProjectDocumentV1> => {
      order.push('duplicate');
      return { ...makeDoc('исходник'), title: newTitle };
    }),
  };
  return base;
}

type SaveGate = {
  project: ProjectDocumentV1;
  /** Commits the parked save (records + resolves). */
  release: () => void;
};

type GatedBase = RecordingBase & {
  /** One gate per repository.save() call, in issue order. */
  gates: SaveGate[];
};

/**
 * Base repository whose saves park mid-flight until their gate is released —
 * needed to hold the autosave FIFO busy so a second attempt sits QUEUED and a
 * third stays debounce-PENDING at the same time (the autosave has a single
 * pending slot, so pending attempts alone can never overlap).
 */
function installGatedBase(): GatedBase {
  const base = installRecordingBase() as GatedBase;
  const gates: SaveGate[] = [];
  base.gates = gates;
  base.save = vi.fn(
    (project: ProjectDocumentV1): Promise<void> =>
      new Promise<void>((resolve) => {
        gates.push({
          project,
          release: () => {
            base.savedTitles.push(project.title);
            base.order.push(`save:${project.title}`);
            resolve();
          },
        });
      }),
  );
  return base;
}

describe('persistence façade fencing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('J1: open runs after the scheduled save reaches storage', async () => {
    const base = installRecordingBase();
    const projects = createProjectPersistence({ repository: base });

    // An accepted edit is debounced (its timer has NOT fired yet) when a cold
    // open arrives. The open must observe the persisted edit, so the façade
    // has to flush before delegating to repository.load.
    projects.scheduleSave({ ...makeDoc('редактировано'), id: 'p1' });
    const result = await projects.open('other');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.document.title).toBe('загруженный');
    expect(base.order).toEqual(['save:редактировано', 'load']);
  });

  it("FNC-E1: after delete fencing, flush() still resolves true — no spurious failure banner", async () => {
    const base = installGatedBase();
    const projects = createProjectPersistence({ repository: base });

    // A DISCARDED attempt is neither saved nor failed: deleting its project
    // must leave the next unload-flush reporting success («false means the
    // latest generation FAILED», §3.16).
    projects.scheduleSave({ ...makeDoc('удаляемый'), id: 'gone' });
    await projects.delete('gone');

    await vi.advanceTimersByTimeAsync(2000);
    expect(base.save).not.toHaveBeenCalled();
    await expect(projects.flushBeforeUnload()).resolves.toBe(true);
    expect(base.save).not.toHaveBeenCalled();
  });

  it("J2/J3: delete discards the deleted id's queued AND pending attempts, others still save", async () => {
    const base = installGatedBase();
    const projects = createProjectPersistence({ repository: base });

    // An older save occupies the FIFO (parked mid-save at its gate)…
    projects.scheduleSave({ ...makeDoc('ранний'), id: 'early' });
    await vi.advanceTimersByTimeAsync(750);
    // …so the deleted project's attempt sits QUEUED behind it…
    projects.scheduleSave({ ...makeDoc('удаляемый'), id: 'gone' });
    await vi.advanceTimersByTimeAsync(750);
    // …while another project's edit stays debounce-PENDING.
    projects.scheduleSave({ ...makeDoc('живой'), id: 'kept' });

    await projects.delete('gone');

    // The queued attempt for the deleted id must never reach storage.
    base.gates[0]?.release(); // ранний commits
    await vi.advanceTimersByTimeAsync(750); // живой reaches storage
    base.gates[1]?.release();

    expect(base.delete).toHaveBeenCalledWith('gone');
    expect(base.savedTitles).toEqual(['ранний', 'живой']);
  });

  it("FNC-Q1: deleting one project must not touch ANOTHER project's attempt parked in the FIFO (id-scoped discard, queued side)", async () => {
    const base = installGatedBase();
    const projects = createProjectPersistence({ repository: base });

    // The QUEUED slot belongs to a DIFFERENT id than the one being deleted,
    // so only an id-SCOPED discard leaves both survivors alive.
    projects.scheduleSave({ ...makeDoc('ранний'), id: 'early' });
    await vi.advanceTimersByTimeAsync(750); // ранний parks mid-flight at gates[0]
    projects.scheduleSave({ ...makeDoc('живой'), id: 'kept' });
    await vi.advanceTimersByTimeAsync(750); // живой's timer fires → kept sits QUEUED behind gates[0]
    // удаляемый stays debounce-PENDING.
    projects.scheduleSave({ ...makeDoc('удаляемый'), id: 'gone' });

    await projects.delete('gone');

    base.gates[0]?.release(); // ранний commits
    await vi.advanceTimersByTimeAsync(750); // живой reaches storage
    base.gates[1]?.release(); // живой commits

    expect(base.delete).toHaveBeenCalledWith('gone');
    expect(base.savedTitles).toEqual(['ранний', 'живой']);
  });

  it('J4: duplicate sees the debounce-pending document data first', async () => {
    const base = installRecordingBase();
    const projects = createProjectPersistence({ repository: base });

    projects.scheduleSave({ ...makeDoc('правка до копии'), id: 'src' });

    const result = await projects.duplicate('src', 'Копия');

    expect(result).toMatchObject({ kind: 'ok' });
    if (result.kind === 'ok') expect(result.project.title).toBe('Копия');
    // The copy must include the pending edit, so flush happens before duplicate.
    expect(base.order).toEqual(['save:правка до копии', 'duplicate']);
  });

  it('FNC-L1: a FAILED pre-open flush does not block or reject the open — storage is still read', async () => {
    const base = installRecordingBase();
    // One-shot storage failure. Adaptation note: vitest's
    // mockRejectedValueOnce would REPLACE the recording implementation for
    // that call, leaving `order` blind to the attempted save — so the
    // once-implementation mirrors installRecordingBase's recording and
    // THEN rejects, keeping the ordering proof honest.
    vi.mocked(base.save).mockImplementationOnce(async (project) => {
      base.savedTitles.push(project.title);
      base.order.push(`save:${project.title}`);
      throw new Error('quota exceeded');
    });
    const projects = createProjectPersistence({ repository: base });

    // An accepted edit is debounce-PENDING (timer NOT fired) when a cold
    // open arrives. The façade flushes first: flush promotes the attempt
    // directly (§3.22), the promoted save rejects, flush resolves false —
    // and the open proceeds to read storage anyway instead of propagating
    // the failure.
    projects.scheduleSave({ ...makeDoc('правка до сбоя'), id: 'p1' });

    const result = await projects.open('other');

    expect(result.kind).toBe('ok');
    // BOTH: the flush was attempted BEFORE the read (order), and its
    // failure neither rejected the open nor skipped the storage read.
    expect(base.order).toEqual(['save:правка до сбоя', 'load']);
  });

  it('create() saves immediately without flushing (a new document has nothing pending)', async () => {
    const base = installRecordingBase();
    const projects = createProjectPersistence({ repository: base });

    projects.scheduleSave({ ...makeDoc('чужая правка'), id: 'p1' });
    const fresh = makeDoc('новый');
    await projects.create(fresh);

    expect(base.order).toEqual(['save:новый']);
    expect(base.save).toHaveBeenCalledWith(fresh);
  });

  it('delete() rethrows storage failures so callers keep the diagnostic message', async () => {
    const base = installRecordingBase();
    vi.mocked(base.delete).mockRejectedValueOnce(new Error('indexeddb readonly'));
    const projects = createProjectPersistence({ repository: base });

    await expect(projects.delete('gone')).rejects.toThrow('indexeddb readonly');
  });
});

describe('persistence façade open/duplicate result mapping', () => {
  it('maps a validation failure onto kind corrupt with the raw payload preserved', async () => {
    const raw = { schemaVersion: 1, melody: 'not-an-object' };
    const base = installRecordingBase();
    vi.mocked(base.load).mockRejectedValueOnce(
      new CorruptProjectError({ projectId: 'bad', raw, reason: 'schema mismatch' }),
    );
    const projects = createProjectPersistence({ repository: base });

    const result = await projects.open('bad');

    expect(result).toEqual({
      kind: 'corrupt',
      projectId: 'bad',
      reason: 'project bad is corrupt: schema mismatch',
      raw,
    });
  });

  it('maps a future schemaVersion onto kind unsupported with the raw payload preserved', async () => {
    const raw = { schemaVersion: 99 };
    const base = installRecordingBase();
    vi.mocked(base.load).mockRejectedValueOnce(new UnsupportedSchemaError('future', 99, raw));
    const projects = createProjectPersistence({ repository: base });

    const result = await projects.open('future');

    expect(result).toEqual({
      kind: 'unsupported',
      projectId: 'future',
      schemaVersion: 99,
      reason: 'project future uses schemaVersion 99, which is not supported by this build',
      raw,
    });
  });

  it('maps a missing record onto kind notFound', async () => {
    const base = installRecordingBase();
    vi.mocked(base.load).mockRejectedValueOnce(new ProjectNotFoundError('gone'));
    const projects = createProjectPersistence({ repository: base });

    expect(await projects.open('gone')).toEqual({ kind: 'notFound' });
  });

  it('duplicate maps typed failures onto result kinds instead of throwing classes', async () => {
    const base = installRecordingBase();
    const projects = createProjectPersistence({ repository: base });

    vi.mocked(base.duplicate).mockRejectedValueOnce(new ProjectNotFoundError('gone'));
    expect(await projects.duplicate('gone', 'К')).toEqual({ kind: 'notFound' });

    const quota = new Error('quota exceeded');
    vi.mocked(base.duplicate).mockRejectedValueOnce(quota);
    expect(await projects.duplicate('a', 'К')).toEqual({ kind: 'storageError', cause: quota });
  });

  it('open flushes BEFORE reading storage even when the previous flush failed ordering-wise', async () => {
    // Companion to FNC-L1 at the mapping layer: the storage error of a LOAD
    // itself must surface as storageError, never reject the caller.
    const base = installRecordingBase();
    vi.mocked(base.load).mockRejectedValueOnce(new Error('The database connection is closing'));
    const projects = createProjectPersistence({ repository: base });

    const result = await projects.open('x');
    expect(result.kind).toBe('storageError');
  });
});

describe('persistence façade status events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function collect(projects: ProjectPersistence): Array<{ projectId: string; status: string }> {
    const seen: Array<{ projectId: string; status: string }> = [];
    projects.subscribe((event) => seen.push({ projectId: event.projectId, status: event.status }));
    return seen;
  }

  it('tags every lifecycle event with the scheduled document’s projectId', async () => {
    const base = installGatedBase();
    const projects = createProjectPersistence({ repository: base });
    const seen: Array<{ projectId: string; status: string }> = [];
    projects.subscribe((event) => seen.push({ projectId: event.projectId, status: event.status }));

    projects.scheduleSave({ ...makeDoc('первый'), id: 'one' });
    await vi.advanceTimersByTimeAsync(750);
    base.gates[0]?.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([
      { projectId: 'one', status: 'saving' },
      { projectId: 'one', status: 'saved' },
    ]);
  });

  it('suppresses statuses of a previous project after flushOnProjectSwitch, surfacing only its boolean outcome', async () => {
    const base = installGatedBase();
    const projects = createProjectPersistence({ repository: base });
    const events = collect(projects);

    // A's edit parks mid-flight at its gate…
    projects.scheduleSave({ ...makeDoc('А'), id: 'a' });
    await vi.advanceTimersByTimeAsync(750);
    // …and the switch happens while it is still in flight: nothing pending,
    // so the switch-flush resolves true immediately and freezes A's generation.
    await expect(projects.flushOnProjectSwitch()).resolves.toBe(true);

    events.length = 0;
    // A settles with a rejection AFTER the switch: no event may leak out.
    base.gates[0]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);

    // B's own save forwards normally afterwards.
    projects.scheduleSave({ ...makeDoc('Б'), id: 'b' });
    await vi.advanceTimersByTimeAsync(750);
    base.gates[1]?.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((e) => e.projectId === 'b' && e.status === 'saved')).toBe(true);
  });

  it('flushOnProjectSwitch resolves false when the flushed previous-project edit fails', async () => {
    const failing = installRecordingBase();
    vi.mocked(failing.save).mockRejectedValue(
      new Error('quota exceeded for the previous project'),
    );
    const projects = createProjectPersistence({ repository: failing });
    const events = collect(projects);

    // The previous project's last edit is armed but unsaved at switch time.
    projects.scheduleSave({ ...makeDoc('А'), id: 'a' });
    const ok = await projects.flushOnProjectSwitch();

    expect(ok).toBe(false);
    // The failed run's own terminal event stays below the epoch — the caller
    // surfaces the warning from the boolean instead (no double reporting).
    expect(events).toEqual([]);
  });

  it('flushBeforeUnload does NOT freeze statuses: the latest outcome still forwards', async () => {
    const projects = createProjectPersistence({ repository: installRecordingBase() });
    const events = collect(projects);

    projects.scheduleSave(makeDoc('перед выгрузкой'));
    await expect(projects.flushBeforeUnload()).resolves.toBe(true);

    expect(events.some((e) => e.status === 'saved')).toBe(true);
  });

  it('subscribe returns an unsubscribe that detaches the listener', async () => {
    const projects = createProjectPersistence({ repository: installRecordingBase() });
    const events: string[] = [];
    const unsubscribe = projects.subscribe((event) => events.push(event.status));

    unsubscribe();
    projects.scheduleSave(makeDoc('тихий'));
    await vi.advanceTimersByTimeAsync(750);

    expect(events).toEqual([]);
  });
});

describe('persistence façade production default (§3.16)', () => {
  it('without an explicit delay, the debounced save fires at the 750 ms default and not before', async () => {
    vi.useFakeTimers();
    try {
      const base = installRecordingBase();
      const projects = createProjectPersistence({ repository: base });
      const doc = makeDoc('Тест');

      projects.scheduleSave(doc);
      await vi.advanceTimersByTimeAsync(749);
      expect(base.save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(base.save).toHaveBeenCalledTimes(1);
      expect(base.save).toHaveBeenCalledWith(doc);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('persistence façade flush ordering (§3.22 × §3.16)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('FLUSH-ORDER: promoted attempts keep generation order against saves scheduled mid-flush', async () => {
    const base = installGatedBase();
    const projects = createProjectPersistence({ repository: base });

    // An older save occupies the FIFO (parked mid-flight at gates[0])…
    projects.scheduleSave({ ...makeDoc('ранний'), id: 'p' });
    await vi.advanceTimersByTimeAsync(750);
    // …a newer attempt sits QUEUED behind it…
    projects.scheduleSave({ ...makeDoc('промо'), id: 'p' });
    await vi.advanceTimersByTimeAsync(750);
    // …and a third stays debounce-PENDING. flush() promotes BOTH промо and
    // отложенный and runs them as one gate-holding session; while the
    // promoted puts are still settling, another edit is scheduled and its
    // debounce fires — its queue task must buffer on the write gate and land
    // AFTER the promoted attempts, never beside them.
    projects.scheduleSave({ ...makeDoc('отложенный'), id: 'p' });

    const flushing = projects.flushBeforeUnload();
    projects.scheduleSave({ ...makeDoc('новый'), id: 'p' }); // newest generation

    base.gates[0]?.release(); // ранний commits; FIFO advances to промо
    await vi.advanceTimersByTimeAsync(750); // новый's timer fires mid-flush
    base.gates[1]?.release(); // промо commits
    await vi.advanceTimersByTimeAsync(0); // отложенный issues
    base.gates[2]?.release(); // отложенный commits
    await vi.advanceTimersByTimeAsync(0); // новый issues last
    // Issue order must follow generation order: under the ungated inline
    // flush, отложенный's put was issued AFTER новый's (the debounced task
    // executed while the promoted put was mid-flight), letting the stale
    // payload commit last on disk.
    expect(base.gates.map((g) => g.project.title)).toEqual([
      'ранний',
      'промо',
      'отложенный',
      'новый',
    ]);

    base.gates[3]?.release(); // новый commits LAST with the newest payload
    await expect(flushing).resolves.toBe(true);
    expect(base.savedTitles).toEqual(['ранний', 'промо', 'отложенный', 'новый']);
  });
});

describe('persistence façade status map hygiene', () => {
  it('prunes the generation→projectId mapping once a terminal status has been forwarded', async () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(Map.prototype, 'set');
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    try {
      const base = installRecordingBase();
      const projects = createProjectPersistence({ repository: base, delayMs: 5 });
      const events: string[] = [];
      projects.subscribe((event) => events.push(`${event.projectId}:${event.status}`));

      projects.scheduleSave({ ...makeDoc('подрезанный'), id: 'p1' });
      expect(setSpy).toHaveBeenCalledWith(1, 'p1');

      await vi.advanceTimersByTimeAsync(10);

      // The terminal event forwarded to listeners, then the entry dropped:
      // without pruning the entry for generation 1 would outlive its only
      // reader and accumulate one per scheduled save forever.
      expect(events).toEqual(['p1:saving', 'p1:saved']);
      expect(deleteSpy).toHaveBeenCalledWith(1);

      // Later generations still tag correctly after earlier entries were pruned.
      projects.scheduleSave({ ...makeDoc('второй'), id: 'p2' });
      expect(setSpy).toHaveBeenCalledWith(2, 'p2');
      await vi.advanceTimersByTimeAsync(10);
      expect(events).toEqual(['p1:saving', 'p1:saved', 'p2:saving', 'p2:saved']);
      expect(deleteSpy).toHaveBeenCalledWith(2);
    } finally {
      setSpy.mockRestore();
      deleteSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
