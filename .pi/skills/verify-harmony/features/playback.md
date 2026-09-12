# Control playback

The transport (Play, Pause, Stop; Space toggles) renders the project through the Tone.js engine — Synth for melody, PolySynth for harmony — from the current playhead. Pause/Stop preserve the playhead for resume; reaching the end rewinds to tick 0. Clicking the bar ruler seeks. Document edits during playback re-render from the playhead.

## Sub-features

- `playback-play` starts playback and advances the playhead.
- `playback-pause-resume` pauses and resumes from the same position.
- `playback-stop-resume` stops and resumes from the same position.
- `playback-seek` moves the playhead by clicking the bar ruler (`bar-ruler`).
- `playback-end-rewind` restarts at tick 0 after reaching the project end.
- `playback-audio-failure` shows an error plus `Повторить звук` retry when AudioContext init fails.

## How to get to it (user POV)

- Transport group (`Транспорт`) in the editor toolbar: `Играть`, `Пауза`, `Стоп` buttons, or Space to toggle.
- Click the bar ruler (`bar-ruler`) to move the playhead (`playhead`).
- Status text (`transport-status`) reports the engine state.

## Driving it with Playwright

Preconditions:

- Baseline state from the map README, plus one created project open in the editor with at least one melody note and one chord (drive `melody-draw` + `harmony-suggest` first — silence has no observable playhead motion to assert on).

- **Play.** Choose `Играть`. Run `page.getByRole('button', { name: 'Играть', exact: true }).click()`. `transport-status` leaves idle and the `playhead` position advances across two reads.
- **Pause/resume.** Choose `Пауза`, read the playhead, choose `Играть`. The playhead is stationary while paused and advances again after resume.
- **Stop/resume.** Choose `Стоп`, then `Играть`. Playback resumes from the preserved playhead, not tick 0.
- **Seek.** Click the bar ruler at an offset. The `playhead` position jumps to the click tick.
- **Proof.** `transport-status` text at each transition plus two playhead readings proving motion and stillness. Artifacts: `artifacts/playback/status.log`.

## Gotchas

- Headless Chromium may have no audio device: assert state transitions and playhead motion, never audible output.
- AudioContext init can fail in some environments — that lands in `playback-audio-failure` (error + `Повторить звук`), which is a valid terminal state, not a broken run. Editing, saving, and MIDI export still work there.
- Space toggles playback only when focus is not in a text field; prefer the explicit buttons in drives.
