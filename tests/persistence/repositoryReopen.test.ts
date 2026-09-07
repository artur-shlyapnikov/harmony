/**
 * Repository reopen-once recovery (§3.18): Dexie fast-fails every operation
 * after a failed open (DatabaseClosedError) and never retries the open
 * itself. The repository must reopen explicitly and retry, or a transient
 * storage failure wedges autosave and «Повторить» for the whole session.
 */
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectDocument } from '@domain/model/project';
import { db, type ProjectRecord } from '@persistence/db';
import { DexieProjectRepository } from '@persistence/ProjectRepository';

const doc = () =>
  createProjectDocument({
    title: 'Переоткрытие',
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });

beforeEach(async () => {
  await db.delete({ disableAutoOpen: false });
  await db.open();
});

describe('DexieProjectRepository dead-open recovery', () => {
  it('reopens and retries a save that hit a closed database', async () => {
    // db.close() leaves autoOpen=false: the next operation rejects with
    // DatabaseClosedError WITHOUT attempting an open — Dexie's documented
    // post-close behaviour and the exact wedge the retry must escape.
    db.close();
    const repo = new DexieProjectRepository();

    await repo.save(doc());

    const stored = await db.table<ProjectRecord>('projects').get('nonexistent-id');
    expect(stored).toBeUndefined();
    const rows = await db.table<ProjectRecord>('projects').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Переоткрытие');
  });

  it('reopens and retries list() the same way', async () => {
    const repo = new DexieProjectRepository();
    await repo.save(doc());
    db.close();

    const summaries = await repo.list();

    expect(summaries).toHaveLength(1);
  });

  it('propagates the fresh error when the reopen itself fails', async () => {
    db.close();
    const repo = new DexieProjectRepository();
    vi.spyOn(db, 'open').mockRejectedValueOnce(new Error('storage still broken'));

    // only withReopen routes through db.open(); the mocked rejection proves
    // the retry path ran and surfaced the fresh failure instead of the
    // stale DatabaseClosedError.
    await expect(repo.save(doc())).rejects.toThrow('storage still broken');
  });

  it('does not retry a save for unrelated errors', async () => {
    const repo = new DexieProjectRepository();
    const put = vi.spyOn(db.table('projects'), 'put');
    put.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'DataCloneError' }));

    await expect(repo.save(doc())).rejects.toThrow('boom');
    // one failed attempt, no reopen-driven second attempt
    expect(put).toHaveBeenCalledTimes(1);
  });
});
