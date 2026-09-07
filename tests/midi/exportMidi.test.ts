import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';

import type {
  ChordEvent,
  MelodyNoteEvent,
  ProjectDocumentV1,
  VoicingProfile,
} from '@domain/model/project';
import { createProjectDocument } from '@domain/model/project';
import type {
  PlaybackNote,
  PlaybackProject,
} from '@domain/model/playback';
import { renderProject } from '@domain/render/renderProject';
import { comparePlaybackNotes } from '@domain/render/validatePlayback';
import {
  exportPlaybackProjectToMidi,
  MidiExportError,
  sanitizeTitle,
} from '@midi/exportMidi';
import { downloadProjectMidi } from '@midi/downloadMidi';

const PPQ = 960;
const TICKS_PER_BAR = PPQ * 4;

function note(partial: Partial<PlaybackNote> & Pick<PlaybackNote, 'midi'>): PlaybackNote {
  return {
    track: 'melody',
    startTick: 0,
    durationTicks: PPQ,
    velocity: 100,
    sourceEventId: `id-${partial.midi}`,
    ...partial,
  };
}

function makeProject(
  notes: PlaybackNote[],
  overrides?: Partial<Pick<PlaybackProject, 'bpm' | 'lengthTicks'>>,
): PlaybackProject {
  return {
    ppq: PPQ,
    bpm: 90,
    timeSignature: [4, 4],
    lengthTicks: 2 * TICKS_PER_BAR,
    notes: [...notes].sort(comparePlaybackNotes),
    ...overrides,
  };
}

function makeDoc(overrides?: {
  title?: string;
  melody?: MelodyNoteEvent[];
  chords?: ChordEvent[];
}): ProjectDocumentV1 {
  const doc = createProjectDocument({
    title: overrides?.title ?? 'Экспорт Тест',
    tonic: { letter: 'C', accidental: 0 },
    mode: 'ionian',
  });
  if (overrides?.melody) doc.melody.notes = overrides.melody;
  if (overrides?.chords) doc.harmony.chords = overrides.chords;
  return doc;
}

function melodyEvent(
  id: string,
  startTick: number,
  durationTicks: number,
  midi: number,
  velocity: number,
): MelodyNoteEvent {
  return { id, startTick, durationTicks, midi, velocity };
}

function chordEvent(id: string, startTick: number, durationTicks: number): ChordEvent {
  return {
    id,
    startTick,
    durationTicks,
    chord: { root: { letter: 'C', accidental: 0 }, templateId: 'maj' },
  };
}

describe('exportPlaybackProjectToMidi — round-trip', () => {
  const project = makeProject([
    note({ track: 'melody', midi: 60, startTick: 0, durationTicks: 960, velocity: 100 }),
    note({ track: 'melody', midi: 64, startTick: 1920, durationTicks: 480, velocity: 64 }),
    note({ track: 'harmony', midi: 48, startTick: 0, durationTicks: 1920, velocity: 80, sourceEventId: 'c1' }),
    note({ track: 'harmony', midi: 55, startTick: 960, durationTicks: 960, velocity: 96, sourceEventId: 'c1' }),
  ]);
  const bytes = exportPlaybackProjectToMidi(project, { title: 'Мой Проект!' });
  const parsed = new Midi(bytes);
  const asciiParsed = new Midi(exportPlaybackProjectToMidi(project, { title: 'My Project!' }));

  it('writes header PPQ 960, tempo, 4/4 signature and the raw project title', () => {
    expect(parsed.header.ppq).toBe(PPQ);
    expect(parsed.header.tempos).toHaveLength(1);
    // Tempo is stored as integer microseconds per beat; assert within
    // that quantization (60e6/90 truncates to 666666 -> 90.00009).
    expect(parsed.header.tempos[0]!.bpm).toBeCloseTo(90, 2);
    expect(parsed.header.timeSignatures[0]!.timeSignature).toEqual([4, 4]);
    // §3.19: sanitization applies ONLY to the download filename; the
    // header meta name carries the project title verbatim.
    expect(asciiParsed.header.name).toBe('My Project!');
  });

  it('round-trips special characters into the header name while the filename stays sanitized', () => {
    const title = 'C# Jam!';
    const bytes = exportPlaybackProjectToMidi(project, { title });
    const parsed = new Midi(bytes);

    // Header carries the raw project title, including '#' and '!'.
    expect(parsed.header.name).toBe(title);

    // Filename sanitization (downloadMidi.ts) is untouched: '#'/'' are
    // stripped and whitespace collapsed for `<sanitized-title>.mid`.
    expect(sanitizeTitle(title)).toBe('C Jam');
  });

  it('exports a unicode-titled project as a valid, note-exact file', () => {
    // The unicode title survives in the download filename. The header
    // meta text degrades deterministically: @tonejs/midi truncates each
    // char to its low byte ('Мой Проект!' -> '\u001c>9 \u001f@>5:B!').
    // HIST-D17: this pins the knowingly-lossy CURRENT library encoding;
    // a library update fixing UTF-8 should flip this pin deliberately.
    expect(parsed.header.name).toBe('\u001c>9 \u001f@>5:B!');

    // Hard invariants regardless of header encoding choice: note bytes
    // stay exact and the degradation is confined to the header meta.
    const [melody, harmony] = parsed.tracks;
    expect(melody!.notes.map((n) => n.midi)).toEqual([60, 64]);
    expect(harmony!.notes.map((n) => n.midi)).toEqual([48, 55]);
    expect(parsed.tracks.map((t) => t.name)).toEqual(['Melody', 'Harmony']);
  });

  it('preserves velocities at the schema bounds 1 and 127 byte-exact through export and re-parse', () => {
    // exportMidi.ts round-trips via Math.round(v * 127); pin that claim
    // at the §3.5 schema extremes.
    const boundsProject = makeProject([
      note({ track: 'melody', midi: 60, startTick: 0, durationTicks: 960, velocity: 1 }),
      note({ track: 'melody', midi: 64, startTick: 1920, durationTicks: 480, velocity: 127 }),
    ]);
    const parsedBounds = new Midi(exportPlaybackProjectToMidi(boundsProject));

    expect(parsedBounds.tracks[0]!.notes.map((n) => Math.round(n.velocity * 127))).toEqual([
      1,
      127,
    ]);
    // No overflow past the normalized ceiling: raw parsed velocity of
    // the 127 note is exactly 1.
    expect(parsedBounds.tracks[0]!.notes[1]!.velocity).toBe(1);
  });

  it('produces exactly two named tracks with separated channels', () => {
    expect(parsed.tracks).toHaveLength(2);
    expect(parsed.tracks[0]!.name).toBe('Melody');
    expect(parsed.tracks[0]!.channel).toBe(0);
    expect(parsed.tracks[1]!.name).toBe('Harmony');
    expect(parsed.tracks[1]!.channel).toBe(1);
  });

  it('preserves note counts, pitches and velocities per track', () => {
    const [melody, harmony] = parsed.tracks;

    expect(melody!.notes.map((n) => n.midi)).toEqual([60, 64]);
    expect(harmony!.notes.map((n) => n.midi)).toEqual([48, 55]);
    expect(melody!.notes.map((n) => Math.round(n.velocity * 127))).toEqual([100, 64]);
    expect(harmony!.notes.map((n) => Math.round(n.velocity * 127))).toEqual([80, 96]);
  });

  it('round-trips tick positions exactly at bpm 90 / ppq 960', () => {
    const expected: Array<{ track: number; midi: number; startTick: number; durationTicks: number }> = [
      { track: 0, midi: 60, startTick: 0, durationTicks: 960 },
      { track: 0, midi: 64, startTick: 1920, durationTicks: 480 },
      { track: 1, midi: 48, startTick: 0, durationTicks: 1920 },
      { track: 1, midi: 55, startTick: 960, durationTicks: 960 },
    ];

    for (const exp of expected) {
      const actual = parsed.tracks[exp.track]!.notes.find((n) => n.midi === exp.midi)!;
      expect(actual.ticks).toBe(exp.startTick);
      expect(actual.durationTicks).toBe(exp.durationTicks);
    }
  });
});

describe('exportPlaybackProjectToMidi — validation', () => {
  it('throws MidiExportError listing issues when a note exceeds project length', () => {
    const project = makeProject([
      note({ midi: 60, startTick: 7300, durationTicks: 1000 }),
    ]);

    expect(() => exportPlaybackProjectToMidi(project)).toThrow(MidiExportError);
    try {
      exportPlaybackProjectToMidi(project);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MidiExportError);
      if (error instanceof MidiExportError) {
        expect(error.issues.map((issue) => issue.code)).toEqual(['beyond_length']);
      }
    }
  });
});

describe('exportPlaybackProjectToMidi — empty project', () => {
  it('exports a valid file with two empty tracks', () => {
    const bytes = exportPlaybackProjectToMidi(makeProject([]));
    const parsed = new Midi(bytes);

    expect(parsed.header.ppq).toBe(PPQ);
    expect(parsed.tracks).toHaveLength(2);
    expect(parsed.tracks[0]!.notes).toHaveLength(0);
    expect(parsed.tracks[1]!.notes).toHaveLength(0);
  });
});

describe('sanitizeTitle', () => {
  it.each([
    ['Мой Проект! v2?', 'Мой Проект v2'],
    ['My Song: "final" <mix>', 'My Song final mix'],
    ['a   b\t\tc', 'a b c'],
    ['keep_-42_x', 'keep_-42_x'],
    ['!!!', 'untitled'],
    ['', 'untitled'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeTitle(input)).toBe(expected);
  });
});

describe('downloadProjectMidi', () => {
  it('renders internally and reports the sanitized .mid filename', async () => {
    const doc = makeDoc({ title: 'Мой Проект! v2' });
    const result = await downloadProjectMidi(doc);

    expect(result).toEqual({ ok: true, filename: 'Мой Проект v2.mid' });
  });

  it('succeeds on an empty project (caller warns per §3.21)', async () => {
    const result = await downloadProjectMidi(makeDoc());

    expect(result.ok).toBe(true);
  });

  it('returns ok:false with error message when rendering fails', async () => {
    const doc = makeDoc({ chords: [chordEvent('c1', 0, TICKS_PER_BAR)] });
    // Break the profile so the voicing resolver throws inside renderProject.
    doc.harmony.voicingProfile = null as unknown as VoicingProfile;

    const result = await downloadProjectMidi(doc);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('triggers an anchor download with the MIDI blob in a DOM', async () => {
    const clicks: string[] = [];
    const revoked: string[] = [];
    const anchors: Array<{ href: string; download: string }> = [];
    const fakeWindow = {
      setTimeout: (fn: () => void) => fn(),
    };
    const fakeDocument = {
      createElement: () => {
        const anchor = {
          href: '',
          download: '',
          click: () => clicks.push(anchor.download),
          remove: () => undefined,
        };
        anchors.push(anchor);
        return anchor;
      },
      body: { appendChild: () => undefined },
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
      const result = await downloadProjectMidi(makeDoc({ title: 'Dom Song' }));
      expect(result).toEqual({ ok: true, filename: 'Dom Song.mid' });
      expect(clicks).toEqual(['Dom Song.mid']);
      expect(anchors[0]!.href).toBe('blob:mock');
      expect(revoked).toEqual(['blob:mock']);
    } finally {
      Object.assign(globalThis, { window: prevWindow, document: prevDoc, URL: prevUrl });
    }
  });
});

describe('exportPlaybackProjectToMidi — renderProject parity', () => {
  it('exports a rendered document with identical notes in both tracks', () => {
    const doc = makeDoc({
      title: 'Паритет',
      melody: [melodyEvent('m1', 0, 480, 72, 77)],
      chords: [chordEvent('c1', 0, TICKS_PER_BAR)],
    });
    doc.harmony.defaultPattern = {
      kind: 'block',
      subdivisionTicks: 480,
      gate: 0.5,
      octaveSpan: 1,
      velocity: 70,
    };

    const playback = renderProject(doc);
    const parsed = new Midi(exportPlaybackProjectToMidi(playback, { title: doc.title }));

    const playbackByTrack = {
      melody: playback.notes.filter((n) => n.track === 'melody'),
      harmony: playback.notes.filter((n) => n.track === 'harmony'),
    };
    expect(playbackByTrack.melody.length).toBeGreaterThan(0);
    expect(playbackByTrack.harmony.length).toBeGreaterThan(0);

    expect(parsed.tracks[0]!.name).toBe('Melody');
    expect(parsed.tracks[0]!.notes.map((n) => n.midi)).toEqual(
      playbackByTrack.melody.map((n) => n.midi),
    );
    expect(parsed.tracks[0]!.notes.map((n) => Math.round(n.velocity * 127))).toEqual(
      playbackByTrack.melody.map((n) => n.velocity),
    );

    expect(parsed.tracks[1]!.name).toBe('Harmony');
    expect(parsed.tracks[1]!.notes.map((n) => n.midi)).toEqual(
      playbackByTrack.harmony.map((n) => n.midi),
    );
    expect(parsed.tracks[1]!.notes.map((n) => Math.round(n.velocity * 127))).toEqual(
      playbackByTrack.harmony.map((n) => n.velocity),
    );
  });
});
