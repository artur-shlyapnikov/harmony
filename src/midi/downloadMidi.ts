/**
 * Browser-side MIDI download (§3.19 / §3.21).
 *
 * Renders the document through the unified renderer and triggers a
 * client-side download of `<sanitized-title>.mid`. Never throws: every
 * failure surfaces as `{ ok: false, error }`. An empty project exports
 * a valid zero-note file (both options allowed per §3.21) — warning the
 * user is the caller's job.
 */

import type { ProjectDocumentV1 } from '@domain/model/project';
import { renderProject } from '@domain/render/renderProject';

import {
  exportPlaybackProjectToMidi,
  sanitizeTitle,
} from './exportMidi';

export type DownloadMidiResult =
  | { ok: true; filename: string }
  | { ok: false; error: string };

function triggerDownload(bytes: Uint8Array, filename: string): void {
  const domDocument = globalThis.document;
  if (
    typeof window === 'undefined' ||
    typeof domDocument === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    // SSR/test environment: no DOM to attach an anchor to.
    return;
  }

  // `new Uint8Array(bytes)` yields Uint8Array<ArrayBuffer>, the exact
  // BlobPart TS requires (bytes itself may carry ArrayBufferLike).
  const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const anchor = domDocument.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  domDocument.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadProjectMidi(
  document: ProjectDocumentV1,
): Promise<DownloadMidiResult> {
  try {
    const playback = renderProject(document);
    const bytes = exportPlaybackProjectToMidi(playback, {
      title: document.title,
    });
    const filename = `${sanitizeTitle(document.title)}.mid`;
    triggerDownload(bytes, filename);
    return Promise.resolve({ ok: true, filename });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({ ok: false, error: message });
  }
}
