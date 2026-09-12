# Harmony

Harmony is an experimental, local-first browser editor for melody and chord
progressions. It stores project documents in client-side IndexedDB. This
repository contains no account or application backend. The editor analyzes
chords in the selected key and mode, suggests chords, plays the rendered
project with Tone.js, and exports MIDI.

![Harmony editor](docs/images/editor-composing.png)

The current implementation is an MVP under active development. The user
interface is in Russian.

## Prerequisites

- Node.js 22.12.0 or newer.
- npm.
- A browser with IndexedDB. Playback also needs a working Web Audio
  AudioContext.
- The `just` command is optional for the repository recipes.
- Playwright browsers for end-to-end tests. Chromium is enough for the probe
  and screenshot scripts. The full end-to-end suite uses Chromium, Firefox,
  and WebKit.

## Install and run

From the repository root:

~~~text
npm ci
npm run dev
~~~

The Vite development server uses http://localhost:5173 by default.

The just setup recipe installs the npm dependencies from the lockfile and
Playwright Chromium:

~~~text
just setup
just dev
~~~

just dev uses port 5173 with --strictPort. It fails if that port is busy.

Build and preview the production bundle:

~~~text
npm run build
npx vite preview --port 4173 --strictPort
~~~

The build runs TypeScript checking and writes the bundle to dist/. The
Playwright configuration builds and serves this preview automatically for
end-to-end tests.

The repository also contains a static Worker deployment configuration:

~~~text
npm run deploy
just deploy-dry
~~~

npm run deploy builds the project and runs wrangler deploy. The checked-in
wrangler.jsonc serves dist/ as static assets with SPA history fallback.
just deploy-dry builds the project and validates the Wrangler deployment
without publishing it.

## Create a project

Open the development URL and create a project from the project list. The
dialog accepts:

- a title;
- one of the preset tonic names or a custom letter and accidental;
- one of seven modes: Ionian, Dorian, Phrygian, Lydian, Mixolydian, Aeolian,
  or Locrian;
- 1 to 128 bars.

New projects use C Ionian, 8 bars, 120 BPM, 4/4, empty melody and harmony
lanes, and the block default pattern. The project is saved to the
harmonic-editor IndexedDB database before the editor opens.

The project list can open, duplicate, and delete projects. Project rows show
the title, modification time, and, when the stored payload contains readable
metadata, the tonic, mode, bar count, and event counts.

## Work in the editor

### Melody

1. Select the Нота tool.
2. Press and drag in the empty Melody lane. The horizontal position snaps to
   240 ticks, which is one sixteenth note at PPQ 960. A click without a drag
   creates one grid step. Dragging sets the duration.
3. Drag a note body to move it. Drag its left or right edge to resize it.

New notes use the current mode for their pitch spelling. Melody notes use MIDI
36 through 96 and velocity 1 through 127. Selecting a note opens an inspector
with its effective spelling, MIDI number, duration, explicit accidental
override, velocity, and delete action.

The note lane colors each part of a note as a chord tone, available tension,
scale tone, or chromatic note. A note that crosses chord boundaries is split
into analysis spans without becoming multiple note events.

### Harmony and suggestions

Click or drag an empty area in the Harmony lane to select a range. The
selection snaps to 960 ticks, or one beat, and opens the suggestion panel.
Suggestion cards can be applied directly to the range. Each card has a
category, a chord symbol, a contextual Roman numeral, and up to two reasons.
The engine can return safe, smooth, strong, and color categories. It does
not show a color card when no candidate qualifies.

The Добавить аккорд action in the suggestion panel opens the chord picker for
the selected range. Double-click an existing chord block to open the same
picker for that chord. The picker provides:

- 12 root choices and the seven scale-degree choices for the current mode;
- chord families and 30 fixed chord templates;
- a formula preview and a two-octave piano preview.

An existing chord can be selected to open its inspector. The inspector edits
the root, template, and per-chord pattern override. Chord blocks show the
chord symbol and its contextual Roman numeral. Chord insertion and edits use
the one-beat chord grid. The current insertion path is range selection plus
suggestion or picker. The repository does not implement a separate
drag-to-draw chord gesture.

The voicing engine chooses a deterministic voicing for each chord from left to
right. A new project uses the G2 to G5 range, up to four voices, and a maximum
24-semitone span. The inspector shows the resolved MIDI notes and reports
optional chord tones that were left out.

### Key, mode, tempo, and patterns

The toolbar provides these project controls:

- Changing the key transposes all melody MIDI values and chord roots by the
  shortest signed semitone distance, then respells them in the new key. The
  operation is atomic. If any melody note would leave MIDI 36 through 96, the
  whole change is rejected.
- Changing the mode changes the harmonic context and re-runs note analysis.
  It does not move existing notes or change their MIDI values. New notes use
  the new mode for spelling.
- BPM accepts values from 40 through 240, including fractional values.
- The default pattern selector provides block, up, down, upDown, bassChord,
  and oneFiveThreeFive. A chord can inherit the default or select an override
  in its inspector.

The stored pattern also has subdivision, gate, octave span, and velocity
fields. The schema accepts subdivisions of 240, 480, or 960 ticks, gate values
from 0.1 through 1, octave span 1 or 2, and velocity 1 through 127. The
current UI exposes the pattern kind and inherit or override choice, but does
not provide controls for those four fields. New projects use a 480-tick
subdivision, gate 0.9, octave span 1, and velocity 80.

## Playback

The transport provides Play, Pause, and Stop. Press Space to toggle playback.
The audio engine uses a Tone.js Synth for the melody and a PolySynth for the
harmony.

Playback renders the project through src/domain/render/renderProject.ts. That
render includes resolved chord voicings and pattern events. The playhead can
be moved by clicking the bar ruler. Pause and Stop preserve the current
playhead, and the next Play resumes from it. When playback reaches the project
end, the next Play starts again at tick 0. Loading another project resets the
playhead.

Accepted document edits during playback re-render and reschedule events from
the current playhead. A note that ended before the playhead is skipped during
that reschedule. A note that crosses the playhead starts at the current
playhead position.

Audio initialization can fail when the browser cannot create or resume an
AudioContext. The transport then shows an error and a Retry Audio action.
Editing, saving, and MIDI export remain available in that state.

## MIDI export

Click Экспортировать MIDI in the editor toolbar. The browser downloads a file
named from the sanitized project title with a .mid extension.

The exporter consumes the same rendered event stream as playback. The file
contains:

- PPQ 960;
- a tempo event at tick 0;
- a 4/4 time signature at tick 0;
- a Melody track on MIDI channel 1;
- a Harmony track on MIDI channel 2.

The harmony track contains the resolved chord voicings and pattern events. A
project with no events still produces a valid MIDI file with zero note events.
MIDI export does not depend on audio initialization.

## Saving and recovery

Creating a project writes it immediately. Accepted document edits, including
undo and redo, use a 750 ms debounced autosave. The toolbar shows the save
state. The app also flushes pending saves when the page becomes hidden,
receives beforeunload, or receives pagehide.

If a save fails, the editor keeps the current document in memory and shows a
storage error banner. The banner offers a JSON backup download and a retry.
The backup contains the complete ProjectDocumentV1 document.

On open, stored data is checked against schema V1 and normalized by sorting
the two event lanes. There are currently no schema migrations. A corrupt
payload or a schema version newer than this build is not overwritten. The
project list offers raw JSON download, deletion, or creation of a new project
for that record.

Opening the same project in multiple browser tabs has no conflict resolution.
The last write that reaches IndexedDB wins.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Space | Play or pause |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Shift + Z | Redo |
| Delete or Backspace | Delete the selected note, chord, or range events |
| Left or Right | Move the selected event by one grid step |
| Shift + Left or Shift + Right | Resize the selected event by one grid step |
| Up or Down | Move a selected melody note by one diatonic step |
| Alt + Up or Alt + Down | Move a selected melody note by one semitone |
| Escape | Clear the selection or close a picker |

The shortcuts do not run while typing in a text input, textarea, select, or
content-editable element.

## Commands and development scripts

Run the npm scripts from the repository root:

| Command | Purpose |
| --- | --- |
| npm run dev | Start the Vite development server |
| npm run build | Typecheck and build dist/ |
| npm run typecheck | Run tsc --noEmit |
| npm run lint | Run ESLint with zero warnings allowed |
| npm test | Run the Vitest unit suites |
| npm run e2e | Build, serve the preview, and run Chromium, Firefox, and WebKit tests |
| npm run deploy | Build and run wrangler deploy |

Useful just recipes:

| Recipe | Purpose |
| --- | --- |
| just --list | List all recipes |
| just setup | Install dependencies and Chromium |
| just check | Run typecheck, lint, and unit tests |
| just ci | Run the check commands and the full end-to-end matrix |
| just browsers-all | Install Chromium, Firefox, and WebKit |
| just e2e-chromium | Run the end-to-end suite in Chromium |
| just e2e-headed | Run Chromium tests with a visible browser |
| just e2e-ui | Open the Playwright UI runner |
| just preview | Serve dist/ at http://localhost:4173 |
| just deploy-dry | Build and validate the Wrangler deployment without publishing |

The one-off browser scripts need the development server at
http://localhost:5173:

~~~text
just probe probe.mjs
just shots
~~~

scripts/probe.mjs creates a 16-bar project, draws two notes, and logs their
geometry. scripts/ux-shots.mjs saves editor screenshots to .ux-shots/. Both
scripts use Playwright Chromium.

## Repository map

- src/domain/ contains music theory, timeline editing, voicing,
  recommendations, pattern rendering, transposition, and validation.
- src/features/ contains the project list, editor lanes, inspectors,
  suggestions, and transport controls.
- src/state/ contains the Redux document history and session state.
- src/audio/ contains Tone.js playback and the external transport state.
- src/midi/ contains MIDI serialization and browser downloads.
- src/persistence/ contains Dexie storage, autosave, and backups.
- tests/ contains Vitest unit and component tests.
- e2e/ contains Playwright tests against the built preview.
- scripts/ contains the probe and UX screenshot scripts.
- wrangler.jsonc configures static asset deployment with SPA fallback.

renderProject is the shared boundary between the domain model and both
playback and MIDI export. The persisted document stores melody notes, chord
identities, timing, mode, and pattern settings. Resolved voicings, note
analysis, and playback events are derived when needed.

## Limits and current gaps

- Projects are limited to 128 bars, 2,000 melody notes, and 512 chord events.
- The document format supports one melody lane and one harmony lane.
- Timing is fixed at 4/4 and PPQ 960. BPM is limited to 40 through 240.
- Melody editing is limited to MIDI 36 through 96. Chord voicing uses the
  stored voicing profile and a maximum of four voices.
- Chords come from the fixed 30-template catalog. Free-form chord notation is
  not implemented.
- The repository implements MIDI export but no audio recording, MIDI import,
  MusicXML import, tempo maps, modulation workflow, cloud sync, collaboration,
  or multi-track instruments.
- Only schema V1 is accepted, and the migration list is empty.
- Playback requires a working browser audio context. MIDI export and editing
  can still work when audio initialization fails.
- The editor has no conflict resolution for simultaneous edits in multiple
  browser tabs.
- The current MIDI library does not preserve non-ASCII project titles in MIDI
  header metadata. The downloaded filename uses the sanitized project title.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks and repository
rules. The project is released under the [MIT License](LICENSE).
