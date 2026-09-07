/**
 * Backup download (§3.18): the object URL must be revoked DEFERRED via
 * setTimeout 0 — revoking synchronously after anchor.click() can abort the
 * download in some browsers (same pattern as @midi/downloadMidi).
 */
import { describe, expect, it } from 'vitest';

import { createProjectDocument } from '@domain/model/project';
import { buildBackupPayload, downloadProjectBackup } from '@persistence/backup';

describe('buildBackupPayload', () => {
  it('pretty-prints the document JSON', () => {
    const doc = createProjectDocument({
      title: 'Резервная Копия',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    expect(buildBackupPayload(doc)).toBe(JSON.stringify(doc, null, 2));
  });
});

describe('downloadProjectBackup', () => {
  it('downloads the JSON and defers revokeObjectURL via setTimeout 0 (RevUI-6)', () => {
    const doc = createProjectDocument({
      title: 'Резервная Копия',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });

    const clicks: string[] = [];
    const revoked: string[] = [];
    const anchors: Array<{ href: string; download: string }> = [];
    const deferred: Array<() => void> = [];
    const fakeWindow = { setTimeout: (fn: () => void) => deferred.push(fn) };
    const fakeDocument = {
      createElement: () => {
        const anchor = { href: '', download: '', click: () => clicks.push(anchor.download) };
        anchors.push(anchor);
        return anchor;
      },
    };
    const fakeUrl = {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: (url: string) => revoked.push(url),
    };
    const prevWindow = globalThis.window;
    const prevDoc = globalThis.document;
    const prevUrl = globalThis.URL;
    Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, URL: fakeUrl });

    try {
      downloadProjectBackup(doc);

      expect(clicks).toEqual(['Резервная Копия.json']);
      expect(anchors[0]!.href).toBe('blob:mock');
      // NOT revoked synchronously — that can abort the download.
      expect(revoked).toEqual([]);

      // Flushing the deferred task revokes exactly once.
      for (const fn of deferred) fn();
      expect(revoked).toEqual(['blob:mock']);
    } finally {
      Object.assign(globalThis, { window: prevWindow, document: prevDoc, URL: prevUrl });
    }
  });
  it('sanitizes the project title in anchor.download like the MIDI path', () => {
    const doc = createProjectDocument({
      title: '  a/b:c*d?e"f<g>h|i\\j  ',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    const clicks: string[] = [];
    const fakeWindow = { setTimeout: () => undefined };
    const fakeDocument = {
      createElement: () => {
        const anchor = { href: '', download: '', click: () => clicks.push(anchor.download) };
        return anchor;
      },
    };
    const fakeUrl = {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => undefined,
    };
    const prevWindow = globalThis.window;
    const prevDoc = globalThis.document;
    const prevUrl = globalThis.URL;
    Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, URL: fakeUrl });

    try {
      downloadProjectBackup(doc);
      // Same sanitizer as downloadMidi; whitespace-garbage collapses to
      // letters/digits only.
      expect(clicks).toEqual(['a b c d e f g h i j.json']);
    } finally {
      Object.assign(globalThis, { window: prevWindow, document: prevDoc, URL: prevUrl });
    }
  });
  it('keeps the sanitized filename for path-hostile titles', () => {
    const doc = createProjectDocument({
      title: 'a/b:c',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    const clicks: string[] = [];
    const fakeWindow = { setTimeout: () => undefined };
    const fakeDocument = {
      createElement: () => {
        const anchor = { href: '', download: '', click: () => clicks.push(anchor.download) };
        return anchor;
      },
    };
    const fakeUrl = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => undefined };
    const prevWindow = globalThis.window;
    const prevDoc = globalThis.document;
    const prevUrl = globalThis.URL;
    Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, URL: fakeUrl });
    try {
      downloadProjectBackup(doc);
      expect(clicks).toEqual(['a b c.json']);
    } finally {
      Object.assign(globalThis, { window: prevWindow, document: prevDoc, URL: prevUrl });
    }
  });
});
