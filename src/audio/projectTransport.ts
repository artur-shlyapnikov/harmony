/**
 * ProjectTransport — concrete playback orchestration (§3.17).
 *
 * The single owner of the play protocol: UI, shortcuts and store listeners
 * call transport operations instead of composing
 * `audio.play(renderProject(project), audio.getCurrentTick())` themselves.
 * Internally it owns the renderProject + AudioEngine + TransportStore
 * combination and hides:
 *
 *  - render-before-play and resume-tick selection (`play`);
 *  - the pause/play/«starting» toggle decision (`toggle`, the Space-key
 *    protocol: playing wins over a missing document; «starting» is ignored);
 *  - retry initialization with its error-status surfacing (`retry`);
 *  - the preserve-state stop vs reset-on-project-switch difference (`stop`
 *    keeps the playhead for the same session, `reset` — used by
 *    REPLACED_FROM_LOAD — halts any live OR paused playback AND clears it,
 *    so the loaded document's first Play starts at 0).
 *
 * No interface/factory hierarchy by design (§ conventions): one class, one
 * module singleton shared with AppDependencies. Snapshot/subscribe delegate
 * to the framework-external TransportStore so React consumers never import
 * TransportStore directly.
 */

import type { ProjectDocumentV1, Tick } from '@domain/model/project';
import type { PlaybackProject } from '@domain/model/playback';
import { renderProject } from '@domain/render/renderProject';
import { getAudioEngine, type AudioEngine } from './AudioEngine';
import {
  getTransportStore,
  type TransportSnapshot,
  type TransportStore,
} from './TransportStore';

/** Public snapshot contract — consumers import these from here, not from
 *  TransportStore (§ conventions: features never touch @audio internals). */
export type { TransportSnapshot, TransportStatus } from './TransportStore';

export class ProjectTransport {
  private readonly engine: AudioEngine;
  private readonly store: TransportStore;

  constructor(
    engine: AudioEngine = getAudioEngine(),
    store: TransportStore = getTransportStore(),
  ) {
    this.engine = engine;
    this.store = store;
  }

  /** Renders the document and starts playback from the preserved playhead. */
  async play(project: ProjectDocumentV1): Promise<void> {
    let playback: PlaybackProject;
    try {
      playback = renderProject(project);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось подготовить проект к воспроизведению';
      this.store.setStatus('error', message);
      return;
    }
    await this.engine.play(playback, this.engine.getCurrentTick());
  }

  /**
   * The Space-key protocol: pause while playing (even without an open
   * document), ignore while «starting» (an in-flight start owns the
   * transport), otherwise start playback of the given project.
   */
  async toggle(project: ProjectDocumentV1 | null): Promise<void> {
    const status = this.store.getSnapshot().status;
    if (status === 'playing') {
      this.pause();
      return;
    }
    if (project === null || status === 'starting') return;
    await this.play(project);
  }

  pause(): void {
    this.engine.pause();
  }

  /** Preserve-state halt: keeps the playhead so Play resumes where it left off. */
  stop(): void {
    this.engine.stop();
  }

  seek(tick: Tick): void {
    this.engine.seek(tick);
  }

  /**
   * Hot-swap of the scheduled playback during live edits (§3.17): re-renders
   * the document and re-runs the engine's clip-and-schedule pass from the
   * live playhead. No-op while the transport is not playing. A render
   * failure must never throw into the store listener (which would skip
   * autosave): keep the old schedule and surface the error status instead.
   */
  updateProject(project: ProjectDocumentV1): void {
    let playback: PlaybackProject;
    try {
      playback = renderProject(project);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось обновить воспроизведение';
      this.store.setStatus('error', message);
      return;
    }
    this.engine.updateProject(playback);
  }

  /**
   * Project switch (REPLACED_FROM_LOAD): fully reset the transport context —
   * halt any live OR paused playback AND clear the playhead (stop() alone
   * preserves the stored tick, so project B's first Play would resume from
   * project A's playhead). Nothing to reset on a clean idle transport, which
   * also keeps bare dependency stubs untouched.
   */
  reset(): void {
    const snapshot = this.store.getSnapshot();
    if (snapshot.status === 'idle' && snapshot.currentTick === 0) return;
    this.engine.resetForNewDocument();
  }

  /**
   * Retry Audio (§3.21 AudioContext unavailable): re-runs engine
   * initialization. Failures are already surfaced as the transport error
   * status — they must not propagate to the caller.
   */
  async retry(): Promise<void> {
    try {
      await this.engine.initialize();
    } catch {
      // State already surfaced as transport error; nothing further to do here.
    }
  }

  // Arrow-bound: safe to pass directly as the useSyncExternalStore pair
  // (mirrors the TransportStore contract underneath).
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  getSnapshot = (): TransportSnapshot => this.store.getSnapshot();
}

let singleton: ProjectTransport | null = null;

/** Lazily-created shared instance used by app dependencies (§3.17 singleton). */
export function getProjectTransport(): ProjectTransport {
  singleton ??= new ProjectTransport();
  return singleton;
}
