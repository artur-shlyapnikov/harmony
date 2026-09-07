/**
 * Application-wide dependency container: lazy singletons for persistence and
 * audio playback. UI components never construct these directly — they call
 * `getDependencies()` (§4 Application bootstrap). Persistence (repository +
 * autosave + fencing + status events) is published ONLY through the semantic
 * façade; nothing outside src/persistence touches the repository or autosave.
 * Playback is likewise published only through the ProjectTransport façade;
 * nothing outside src/audio touches the AudioEngine.
 */

import { getProjectTransport, type ProjectTransport } from '@audio/projectTransport';
import { downloadProjectBackup } from '@persistence/backup';
import {
  createProjectPersistence,
  type ProjectPersistence,
} from '@persistence/projectPersistence';
import type { DownloadMidiResult } from '@midi/downloadMidi';
import type { ProjectDocumentV1 } from '@domain/model/project';

// Stable result unions are the façade's public contract — re-exported so
// feature modules can type-match outcomes without importing @persistence/*.
export type {
  PersistenceStatusEvent,
  ProjectDuplicateResult,
  ProjectOpenResult,
} from '@persistence/projectPersistence';

export interface AppDependencies {
  /** Semantic project persistence: open/save/duplicate/delete + status events. */
  projects: ProjectPersistence;
  transport: ProjectTransport;
  /** §3.20 backup export: pretty-printed JSON download. */
  downloadBackup: (project: ProjectDocumentV1) => void;
  /** §3.20 MIDI export: renders and downloads a .mid file. */
  downloadMidi: (project: ProjectDocumentV1) => Promise<DownloadMidiResult>;
}

// §3.17: the transport (and its AudioEngine) is a singleton created at
// application bootstrap — when this module is first imported — not lazily on
// first Play. The constructors have no side effects and Tone.js is not even
// imported until the engine's first initialize() (dynamic import), so eager
// construction cannot change observable audio behaviour or load audio code
// into non-playback graphs.
const bootstrapTransport: ProjectTransport = getProjectTransport();

let instance: AppDependencies | null = null;

/** Lazily creates the single shared instance on first use. */
export function getDependencies(): AppDependencies {
  if (instance === null) {
    instance = {
      projects: createProjectPersistence(),
      transport: bootstrapTransport,
      downloadBackup: downloadProjectBackup,
      // §3.20 MIDI export is a cold path: the @tonejs/midi graph (~70 kB
      // source) loads on first export instead of riding in the main bundle.
      downloadMidi: (project) =>
        import('@midi/downloadMidi').then((midi) => midi.downloadProjectMidi(project)),
    };
  }
  return instance;
}
/** Test seam: replace the container (pass null to reset the singleton). */
export function setDependenciesForTesting(dependencies: AppDependencies | null): void {
  instance = dependencies;
}
