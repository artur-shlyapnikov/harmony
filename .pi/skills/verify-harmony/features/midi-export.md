# Export MIDI

Экспортировать MIDI downloads a `.mid` file named after the sanitized project title, rendered from the same event stream as playback: PPQ 960, tempo + 4/4 at tick 0, Melody track on channel 1, Harmony track on channel 2 with resolved voicings and pattern events. An empty project still yields a valid file with zero note events.

## Sub-features

- `midi-export-notes` downloads a file containing the drawn melody pitch and chord voicings.
- `midi-export-empty` downloads a valid file with zero note events for an event-free project.
- `midi-export-filename` names the file after the sanitized project title with `.mid`.

## How to get to it (user POV)

- In the editor toolbar, choose `Экспортировать MIDI`. The browser downloads the file.

## Driving it with Playwright

Preconditions:

- Baseline state from the map README, plus one created project titled with ASCII characters (filename assertion) containing one drawn C5 note and one applied chord.

- **Export.** Start the download wait, then choose export. Run `const dl = page.waitForEvent('download'); page.getByRole('button', { name: 'Экспортировать MIDI' }).click(); const download = await dl`. Suggested filename matches `/\.mid$/` and contains the sanitized title.
- **Header.** Read the downloaded bytes. First four bytes are `MThd`; parse chunks to find tracks named `Melody` and `Harmony` (FF 03 track-name meta).
- **Content.** The `Melody` track's note-on pitches equal the drawn notes (single C5 → `[72]`); every melody note-on is channel 0 and every harmony note-on is channel 1; both tracks are non-empty.
- **Empty project.** Create a second project with no events and export. The file is a valid `MThd` with zero note-on events.
- **Proof.** Keep the downloaded bytes (`artifacts/midi-export/project.mid`), plus a log of track names, channels, and pitches (`artifacts/midi-export/tracks.log`).

## Gotchas

- The download event must be armed before the click — reversing the order flakes.
- Assert on parsed track contents (names, channels, pitches), not file size: sizes shift with tempo/meta bytes.
- No MIDI key-signature event is written; do not assert one.
