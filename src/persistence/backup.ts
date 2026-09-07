import { sanitizeTitle } from '@midi/exportMidi';

import { type ProjectDocumentV1 } from '@domain/model/project';

/** Pretty-printed backup JSON including the document schemaVersion. */
export function buildBackupPayload(project: ProjectDocumentV1): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Triggers a client-side download of the project as pretty-printed JSON.
 * No-op outside a browser environment.
 */
export function downloadProjectBackup(project: ProjectDocumentV1): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([buildBackupPayload(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${sanitizeTitle(project.title)}.json`;
  // Detached anchor.click() is ignored by Firefox/Safari: attach first.
  // Guarded for non-DOM test doubles that stub createElement without body.
  const body = document.body;
  if (body) {
    body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } else {
    anchor.click();
  }

  // Defer until the click has fully processed — revoking synchronously can
  // abort the download in some browsers (same pattern as downloadMidi.ts).
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
