import {
  type ProjectDocumentV1,
  type ProjectSummary,
} from '@domain/model/project';
import { LETTER_SEMITONES, MODE_IDS, spelledName } from '@domain/model/pitch';
import type { Accidental, ModeId, NoteLetter } from '@domain/model/pitch';
import { migrateDocument } from '@domain/validation/migrations';
import { sortEvents } from '@domain/timeline/intervalOps';
import { db, type ProjectRecord } from './db';

/** Contract for project persistence (§3.18). */
export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<ProjectDocumentV1>;
  save(project: ProjectDocumentV1): Promise<void>;
  delete(id: string): Promise<void>;
  duplicate(id: string, newTitle: string): Promise<ProjectDocumentV1>;
}

export type CorruptProjectErrorDetails = {
  projectId: string;
  raw: unknown;
  reason: string;
};

/** Validation failed after migration; `details.raw` preserves the stored record untouched. */
export class CorruptProjectError extends Error {
  readonly details: CorruptProjectErrorDetails;

  constructor(details: CorruptProjectErrorDetails) {
    super(`project ${details.projectId} is corrupt: ${details.reason}`);
    this.name = 'CorruptProjectError';
    this.details = details;
  }
}

/** Document schemaVersion is newer than this build understands. Raw payload preserved. */
export class UnsupportedSchemaError extends Error {
  readonly projectId: string;
  readonly schemaVersion: number;
  readonly raw: unknown;

  constructor(projectId: string, schemaVersion: number, raw: unknown) {
    super(
      `project ${projectId} uses schemaVersion ${schemaVersion}, which is not supported by this build`,
    );
    this.name = 'UnsupportedSchemaError';
    this.projectId = projectId;
    this.schemaVersion = schemaVersion;
    this.raw = raw;
  }

}

/** No stored record under the requested id (deleted elsewhere, stale URL). */
export class ProjectNotFoundError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`project ${projectId} not found`);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}

/**
 * List-row meta read straight off the stored payload — pre-migration, no Zod:
 * v1 field paths are stable, and the summary must never throw on one corrupt
 * record (the row simply loses its meta line, title/date still render).
 */
function summarizePayload(payload: unknown): ProjectSummary['meta'] {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const doc = payload as {
    timing?: { bars?: unknown };
    harmonyContext?: { tonic?: { letter?: unknown; accidental?: unknown }; mode?: unknown };
    melody?: { notes?: unknown };
    harmony?: { chords?: unknown };
  };
  const bars = doc.timing?.bars;
  const tonic = doc.harmonyContext?.tonic;
  const mode = doc.harmonyContext?.mode;
  const notes = doc.melody?.notes;
  const chords = doc.harmony?.chords;
  if (
    typeof bars !== 'number' ||
    !Number.isFinite(bars) ||
    typeof tonic !== 'object' || tonic === null ||
    typeof tonic.letter !== 'string' ||
    !Object.hasOwn(LETTER_SEMITONES, tonic.letter) ||
    typeof tonic.accidental !== 'number' ||
    !Number.isInteger(tonic.accidental) ||
    Math.abs(tonic.accidental) > 2 ||
    typeof mode !== 'string' ||
    !MODE_IDS.includes(mode as ModeId) ||
    !Array.isArray(notes) ||
    !Array.isArray(chords)
  ) {
    return undefined;
  }
  return {
    tonic: spelledName({ letter: tonic.letter as NoteLetter, accidental: tonic.accidental as Accidental }),
    mode: mode as ModeId,
    bars,
    chordCount: chords.length,
    noteCount: notes.length,
  };
}

const projectsTable = () => db.table<ProjectRecord>('projects');

/**
 * §3.18 step 5 «нормализовать arrays and ordering» on the load path.
 * After migration + validation succeed, both event lanes are restored to
 * canonical ordering (startTick, then id). Normalization is deliberately
 * NOT lossy: schema validation already enforces tick bounds and duration
 * rules, so grid quantization / trimming would only corrupt valid
 * hand-edited or legacy payloads.
 */
function normalizeDocument(document: ProjectDocumentV1): ProjectDocumentV1 {
  return {
    ...document,
    melody: {
      ...document.melody,
      notes: sortEvents(document.melody.notes),
    },
    harmony: {
      ...document.harmony,
      chords: sortEvents(document.harmony.chords),
    },
  };
}

/**
 * §3.18 steps 2–4: detect schemaVersion → run the migration chain → Zod
 * validate. The persisted record column `schemaVersion` (written by
 * `save()`) decides when the payload itself carries no numeric version.
 * Throws before any mutation; the stored record is never touched.
 */
function migrateStoredPayload(record: ProjectRecord): Promise<ProjectDocumentV1> {
  const raw = record.payload;
  const rawVersion =
    typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? raw.schemaVersion : null;
  const payloadVersion = typeof rawVersion === 'number' ? rawVersion : null;
  const version = payloadVersion ?? record.schemaVersion;

  if (version !== null && version > 1) {
    // Never overwritten; surfaced so the UI can offer "download raw JSON".
    throw new UnsupportedSchemaError(record.id, version, raw);
  }

  let candidate = raw;
  if (payloadVersion === null && typeof candidate === 'object' && candidate !== null) {
    candidate = { ...(candidate as Record<string, unknown>), schemaVersion: record.schemaVersion };
  }

  const result = migrateDocument(candidate);
  if (!result.ok) {
    throw new CorruptProjectError({
      projectId: record.id,
      raw,
      reason: result.error,
    });
  }
  return Promise.resolve(result.document as ProjectDocumentV1);
}

/**
 * Dexie never retries a failed open: after one open failure every later
 * operation fast-fails with DatabaseClosedError (wrapping the stale open
 * error) until db.open() is called explicitly. A transient storage failure
 * (quota freed, a competing tab's versionchange settled) must not wedge
 * autosave and the storage banner's «Повторить» for the rest of the
 * session, so repository operations reopen once and retry.
 */
const DEAD_OPEN_ERROR_NAMES: Record<string, true> = {
  DatabaseClosedError: true,
  OpenFailedError: true,
};

async function withReopen<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (!(error instanceof Error) || DEAD_OPEN_ERROR_NAMES[error.name] !== true) throw error;
    await db.open();
    return op();
  }
}

function readStored(id: string): Promise<ProjectRecord | undefined> {
  return withReopen(() => projectsTable().get(id));
}

export class DexieProjectRepository implements ProjectRepository {
  async list(): Promise<ProjectSummary[]> {
    const records = await withReopen(() => projectsTable().toArray());
    return records
      .map((r) => {
        // exactOptionalPropertyTypes: absent meta omits the key entirely.
        const meta = summarizePayload(r.payload);
        return meta === undefined
          ? { id: r.id, title: r.title, updatedAt: r.updatedAt }
          : { id: r.id, title: r.title, updatedAt: r.updatedAt, meta };
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async load(id: string): Promise<ProjectDocumentV1> {
    const record = await readStored(id);
    if (record === undefined) {
      throw new ProjectNotFoundError(id);
    }
    return normalizeDocument(await migrateStoredPayload(record));
  }

  async duplicate(id: string, newTitle: string): Promise<ProjectDocumentV1> {
    // Byte-faithful copy (§3.18): raw record → migrations/validation →
    // persist under a new id/title. Never routed through load()'s
    // normalization.
    const record = await readStored(id);
    if (record === undefined) {
      throw new ProjectNotFoundError(id);
    }
    const source = await migrateStoredPayload(record);
    const now = new Date().toISOString();
    const copy: ProjectDocumentV1 = {
      ...source,
      id: crypto.randomUUID(),
      title: newTitle,
      createdAt: now,
      updatedAt: now,
    };
    await this.save(copy);
    return copy;
  }

  async save(project: ProjectDocumentV1): Promise<void> {
    // structured-clone-safe plain object: strip any class wrappers / frozen refs.
    const payload = structuredClone(project) as unknown;
    const record: ProjectRecord = {
      id: project.id,
      title: project.title,
      updatedAt: project.updatedAt,
      schemaVersion: project.schemaVersion,
      payload,
    };
    await withReopen(() => projectsTable().put(record));
  }

  async delete(id: string): Promise<void> {
    await withReopen(() => projectsTable().delete(id));
  }

}

/** Dependency-injection seam for tests and autosave listeners. */
export function makeRepository(): ProjectRepository {
  return new DexieProjectRepository();
}
