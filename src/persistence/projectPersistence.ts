/**
 * Semantic persistence façade (§3.18): the ONE object feature code talks to
 * about projects. Internally it owns the raw repository AND the autosave
 * protocol — flush-before-read ordering (§3.16 stale-read race), deletion
 * fencing (§3.18 resurrection), duplicate freshness (§3.20) and stale-status
 * suppression across project switches (§3.15/§3.18 status epochs) — so no
 * consumer ever needs `generation()`/`discardFor()` or the error classes:
 * failures arrive as discriminated result kinds, save lifecycle as
 * projectId-tagged status events.
 */

import {
  type ProjectDocumentV1,
  type ProjectSummary,
} from '@domain/model/project';
import { createAutosave, type Autosave } from './autosave';
import {
  CorruptProjectError,
  ProjectNotFoundError,
  UnsupportedSchemaError,
  makeRepository,
  type ProjectRepository,
} from './ProjectRepository';

/** Stable open outcome — React components match kinds, never error classes. */
export type ProjectOpenResult =
  | { kind: 'ok'; document: ProjectDocumentV1 }
  /** No stored record under the requested id (deleted elsewhere, stale URL). */
  | { kind: 'notFound' }
  /** Validation failed after migration; `raw` preserves the stored payload. */
  | { kind: 'corrupt'; projectId: string; reason: string; raw: unknown }
  /** schemaVersion newer than this build; `raw` preserves the stored payload. */
  | {
      kind: 'unsupported';
      projectId: string;
      schemaVersion: number;
      reason: string;
      raw: unknown;
    }
  /** Storage failure (quota, private mode, closed database…). */
  | { kind: 'storageError'; cause?: unknown };

export type ProjectDuplicateResult =
  | { kind: 'ok'; project: ProjectDocumentV1 }
  | { kind: 'notFound' }
  | { kind: 'storageError'; cause?: unknown };

export type PersistenceStatusEvent = {
  /** The document this save belongs to — lets consumers ignore foreign saves. */
  projectId: string;
  status: 'saving' | 'saved' | 'error';
  errorMessage?: string;
};

export type PersistenceStatusListener = (event: PersistenceStatusEvent) => void;

export type ProjectPersistence = {
  list(): Promise<ProjectSummary[]>;
  /** Persists a brand-new document immediately (dialog stays open until settled). */
  create(project: ProjectDocumentV1): Promise<void>;
  /**
   * Safe transition to stored state: flushes every not-yet-persisted attempt
   * of the PREVIOUS session BEFORE reading storage, so the read can never
   * observe pre-edit data (§3.16). Never throws — maps every failure class
   * onto a stable result kind.
   */
  open(id: string): Promise<ProjectOpenResult>;
  /** Arms the debounced save for an accepted edit (§3.16). */
  scheduleSave(project: ProjectDocumentV1): void;
  /** Manual «Повторить»: identical re-arm of the debounced save (§3.18). */
  retrySave(project: ProjectDocumentV1): void;
  /** Copies the STORED record; flushes first so pending edits are copied too (§3.20). */
  duplicate(id: string, title: string): Promise<ProjectDuplicateResult>;
  /**
   * §3.18 deletion fencing: drops the deleted id's pending/parked saves
   * before removing the record, so a late autosave cannot resurrect it.
   */
  delete(id: string): Promise<void>;
  /**
   * §3.22 unload durability: fire-and-forget flush on pagehide/beforeunload/
   * visibilitychange. Status events still forward (the latest generation's
   * outcome is current information, not stale).
   */
  flushBeforeUnload(): Promise<boolean>;
  /**
   * §3.15/§3.18 project switch: freezes status forwarding for the previous
   * project's generations FIRST, then flushes its pending work. Resolves
   * false when that flush failed — the caller must surface a persistent
   * warning over the new session (the suppressed terminal event cannot).
   */
  flushOnProjectSwitch(): Promise<boolean>;
  subscribe(listener: PersistenceStatusListener): () => void;
};

/**
 * Single construction path for the app-wide persistence stack. The base
 * repository is injectable for tests; production uses Dexie. Autosave keeps
 * saving through the injected repository directly, so delete-fencing never
 * recurses.
 */
export function createProjectPersistence(
  opts: { repository?: ProjectRepository; delayMs?: number } = {},
): ProjectPersistence {
  const repository = opts.repository ?? makeRepository();

  const listeners = new Set<PersistenceStatusListener>();
  /** generation → projectId, recorded at schedule time for status tagging. */
  const generationProjects = new Map<number, string>();

  // §3.15/§3.18 stale-status suppression: statuses at or below the epoch set
  // by flushOnProjectSwitch() belong to the previously opened project (an
  // in-flight, queued or switch-flushed run settling later) and are dropped.
  // A fresh instance starts with no epoch and forwards everything.
  let statusEpoch: number | undefined;

  const autosave: Autosave = createAutosave(repository, {
    ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
    onStatus: (status, generation, errorMessage) => {
      if (statusEpoch === undefined || generation > statusEpoch) {
        const event: PersistenceStatusEvent = {
          projectId: generationProjects.get(generation) ?? '',
          status,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
        };
        for (const listener of listeners) listener(event);
      }
      // A terminal status ('saved'/'error') is the last event a generation
      // ever emits, so its schedule-time mapping can never be read again —
      // drop it here (even when epoch-suppressed) or the map grows by one
      // entry per scheduled save forever.
      if (status === 'saved' || status === 'error') {
        generationProjects.delete(generation);
      }
    },
  });

  function scheduleSave(project: ProjectDocumentV1): void {
    autosave.schedule(project);
    generationProjects.set(autosave.generation(), project.id);
  }

  async function flushBeforeRead(): Promise<void> {
    await autosave.flush();
  }

  return {
    list: () => repository.list(),

    // A new document has nothing pending in the autosave yet: plain save,
    // exactly like the dialog always did.
    create: (project) => repository.save(project),

    open: async (id) => {
      await flushBeforeRead();
      try {
        // load() migrates → validates → normalizes (sorting included), so
        // callers receive a ready-to-commit document with no extra passes.
        return { kind: 'ok', document: await repository.load(id) };
      } catch (error) {
        if (error instanceof CorruptProjectError) {
          return {
            kind: 'corrupt',
            projectId: error.details.projectId,
            reason: error.message,
            raw: error.details.raw,
          };
        }
        if (error instanceof UnsupportedSchemaError) {
          return {
            kind: 'unsupported',
            projectId: error.projectId,
            schemaVersion: error.schemaVersion,
            reason: error.message,
            raw: error.raw,
          };
        }
        if (error instanceof ProjectNotFoundError) {
          return { kind: 'notFound' };
        }
        return { kind: 'storageError', cause: error };
      }
    },

    scheduleSave,

    // §3.18 storage error: Retry is not a separate write path — it re-arms
    // the same debounced save, preserving FIFO order with later edits.
    retrySave: scheduleSave,

    duplicate: async (id, title) => {
      await flushBeforeRead();
      try {
        return { kind: 'ok', project: await repository.duplicate(id, title) };
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return { kind: 'notFound' };
        return { kind: 'storageError', cause: error };
      }
    },

    delete: async (id) => {
      // Fencing BEFORE removal (§3.18): neither the debounce-pending document
      // nor a run parked in the FIFO may re-put the record being deleted.
      autosave.discardFor?.(id);
      await repository.delete(id);
    },

    flushBeforeUnload: () => autosave.flush(),

    flushOnProjectSwitch: async () => {
      // Freeze the previous project's statuses BEFORE flushing: run() emits
      // 'saving' synchronously, and the flushed runs' terminal outcomes must
      // not paint the new session either. The boolean result carries the
      // failure past the frozen gate instead.
      statusEpoch = autosave.generation();
      return autosave.flush();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
