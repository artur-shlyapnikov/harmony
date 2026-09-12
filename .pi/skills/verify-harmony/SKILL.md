---
name: verify-harmony
description: "Drive the Harmony local-first browser editor (React/Vite SPA, Russian UI) with Playwright: launch an isolated preview, exercise create/compose/play/export flows, capture proof. Use whenever verifying Harmony behavior end to end."
---

# Verify Harmony

Harmony is a local-first browser editor for melody and chord progressions
(React 19 + Vite, UI in Russian). There is no account or application backend:
projects live in the client-side IndexedDB database `harmonic-editor`, audio
renders with Tone.js, MIDI export downloads a `.mid` file. The static Worker
deploy (`wrangler.jsonc` serving `dist/`) is not driven by this skill.

## Launch

Verification never touches a developer's dev server. It serves a fresh
production build on its own port:

```text
npm run build
npx vite preview --port 4321 --strictPort
```

Port `4321` is the verification port. `--strictPort` makes a busy port fail
instead of silently shifting. If `4321` is taken by another verification run,
pick a different free port and use it as `$VERIFY_PORT` everywhere below —
never share one preview instance between two runs.

Ready means: `GET http://localhost:$VERIFY_PORT/` returns 200 and the page
shows the `Новый проект` button (aria-label `Новый проект`, document title
`Harmonic Editor`). Teardown is killing the `vite preview` process this run
started (see Cleanup). Verification uses the preview build because that is
what `playwright.config.ts` serves for e2e; `npm run dev` (:5173) stays
reserved for human development.

No env vars, seed data, or auth are needed. Every drive starts with a fresh
Playwright browser context, which is a fresh empty IndexedDB — no seeding
step exists because project creation itself is feature `projects-create`.

## Doctor

Run the read-only check first whenever anything looks off, before driving:

```text
node .pi/skills/verify-harmony/helpers/doctor.mjs http://localhost:4321
```

It prints `READY <url>` (exit 0) only when the URL answers 200, the document
title is `Harmonic Editor`, and the project list renders a `Новый проект`
button. Anything else prints `NOT READY: <reason>` (exit 1): do not drive,
re-run Launch and confirm the preview PID is yours.

## Drive

Harness is Playwright (`@playwright/test`, Chromium) with Node scripts in
`helpers/`. Real handles from this repo — use them literally, do not invent
selectors:

- Routes: `/` project list, `/project/:id` editor. Creation navigates
  list → editor after the IndexedDB write; wait for `/project\//` URL plus
  `melody-lane` visible (up to 15 s under parallel load), never a fixed sleep.
- Project list: `Новый проект` button; dialog fields `Название`,
  `Количество тактов` (tonic `Тоника`, mode `Лад` keep defaults); `Создать`
  button (exact name).
- Editor lanes: `melody-lane`, `chord-lane` test ids. Melody tool:
  `tool-draw-note` (check `aria-pressed="true"` after click). Notes:
  `[data-note-id]` groups, `[data-role="note-body"]` for geometry.
  Geometry at default zoom 40 px/beat: 1 bar = 160 px, melody grid step
  (240 ticks) = 10 px, chord grid (960 ticks) = 40 px.
- Harmony: click empty `chord-lane` to select a range → `suggestion-panel`
  appears → its first button applies a chord (`[data-chord-id]`).
  Double-click a chord block opens the picker (`picker-root`,
  `picker-apply`, `chord-picker` closes on apply).
- Inspectors: `note-inspector` / `inspector-note-name` (e.g. `C5`),
  `chord-inspector`. Save state: `save-status` reads `Есть изменения` then
  `Сохранено` (debounced write — always wait for `Сохранено` before reload).
- Transport: `group[aria-label="Транспорт"]` buttons `Играть`, `Пауза`,
  `Стоп`; status `transport-status`. Export: `Экспортировать MIDI` button
  triggers a real download (`*.mid`, `MThd` magic).
- Re-render races: a one-shot `boundingBox()` can return null after a
  re-render. Retry the read (poll) instead of asserting on the first null —
  see `drive-compose.mjs`.

One-shot drive of the compose slice (create → note → chord → screenshot):

```text
node .pi/skills/verify-harmony/helpers/drive-compose.mjs http://localhost:4321 ./artifacts/compose-proof
```

For any other mapped feature, follow its file under `features/` with the same
conventions (fresh context, role/test-id handles, explicit waits).

## Evidence

Proof standards (non-negotiable):

- Exercise the real user path: pointer drags on lanes, real button clicks,
  real dialog input — never IndexedDB `put`, store dispatches, or
  test-only endpoints to set state.
- Capture the action and the resulting state, not just the final screen:
  e.g. note count before/after the drag, chord count before/after applying
  the suggestion, save-status transition `Есть изменения` → `Сохранено`.
- Verify side effects alongside what is visible: MIDI download bytes
  (`MThd` header, `Melody`/`Harmony` track names, expected pitches), and
  reload-restore from IndexedDB (counts survive `page.reload()` after
  `Сохранено`).
- Audio is headless-hostile: assert transport state transitions and
  `transport-status` text, never audible output. No mocks sit behind these
  paths (no network backend exists to mock); the only accepted simulation is
  a headless browser in place of a speaker.
- This repo has no dry-run/test mode, so there is nothing to distrust on
  that front. If one is ever added, verify what it skips by observing
  (files, downloads, IndexedDB refs), not by trusting its name.

Artifacts go to `./artifacts/<feature>/` under the repo root (screenshots
`.png`, ARIA snapshots `.aria.txt`, MIDI bytes `.mid`, drive logs
`.log`). That directory is the proof location named by Cleanup.

## Cleanup

Kill only what this run started: the `vite preview` PID recorded at Launch
(`kill <pid>`, then confirm the port is closed). Never `pkill`/kill by
process name — a developer's dev server or another run may match. Close the
Playwright browser at the end of every drive script (including on failure)
so Chromium never lingers. Fresh contexts leave no profile or IndexedDB
residue on disk to scrub; failed-run scratch (half-created projects) dies
with the context. Cleanup removes instances and scratch state, never the
evidence: `./artifacts/` survives teardown.

## Helpers

Both helpers are executable Node scripts; invocations are shown in
Doctor/Drive. They take `(baseURL, outDir?)` positionally and exit non-zero
with the failure on stderr.

- `helpers/doctor.mjs` — read-only readiness probe (HTTP + one page load,
  fresh context, no mutations). Prints `READY` or `NOT READY: <reason>`.
- `helpers/drive-compose.mjs` — drives feature `melody-draw` + `harmony-add`
  end to end (create project → draw note → suggestion chord → waits for
  `Сохранено` → screenshot + ARIA snapshot into outDir). The reference
  recipe for writing drives of other mapped features.
