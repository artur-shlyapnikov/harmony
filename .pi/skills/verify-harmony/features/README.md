# Harmony verification map

This directory is the maintained source for verifying the user-facing behavior of Harmony. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Serve a fresh production build on an isolated port: `npm run build`, then `npx vite preview --port 4321 --strictPort` (or another free port as `$VERIFY_PORT`; never share one instance between runs).
- Drive only that instance. Never drive a developer's `npm run dev` (:5173) server.
- Every drive starts with a fresh Playwright Chromium context (fresh empty `harmonic-editor` IndexedDB). No seed data.
- Run `node .pi/skills/verify-harmony/helpers/doctor.mjs http://localhost:$VERIFY_PORT` and require `READY`.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names, then `data-testid` handles, over CSS selectors, coordinates, or tab order. Lane pointer geometry is the documented exception (lanes are canvases of positioned divs).
- Treat every command as literal. Keep Russian button/field names and flags unchanged.
- Creation navigates list → editor only after the IndexedDB write: wait for the `/project\//` URL plus `melody-lane` visible (up to 15 s), never a fixed sleep.
- After any mutation, wait for `save-status` to read `Сохранено` before reloading or asserting persistence (the write is debounced; `Есть изменения` comes first).
- Re-render races: retry a null `boundingBox()` read (poll) instead of failing on it.
- Restore nothing (fresh context per run). Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the app identity visible.
- Mutation proof includes a read-only second view of the stored value (reload from IndexedDB, or MIDI bytes for export).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with Playwright` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Create and manage projects](./projects.md) covers dialog creation, open, duplicate, and delete from the project list.
- [Draw and edit melody notes](./melody.md) covers pointer-draw quantized notes, move/resize, and the note inspector.
- [Add and edit harmony chords](./harmony.md) covers range selection, suggestion cards, the chord picker, and the chord inspector.
- [Control playback](./playback.md) covers Play/Pause/Stop, playhead seek, and the audio-failure state.
- [Export MIDI](./midi-export.md) covers the download, track layout, and the empty-project file.
