# Draw and edit melody notes

With the Нота tool active, pressing and dragging in the empty Melody lane creates a note snapped to the 240-tick grid (10 px at default zoom); a click without drag makes one grid step. Notes can be moved by the body, resized by the edges, and inspected for spelling, MIDI number, duration, accidental override, and velocity.

## Sub-features

- `melody-draw` draws a quantized note with press-drag (or single click).
- `melody-move` drags a note body to a new time/pitch.
- `melody-resize` drags a note edge to change duration.
- `melody-inspect` shows spelling, MIDI, duration, accidental, velocity in the inspector.
- `melody-delete` removes the note via the inspector action.

## How to get to it (user POV)

- In the editor (`/project/:id`), choose the `Нота` tool (`tool-draw-note`), then press-drag in the Melody lane (`melody-lane`).
- Click a note body (`[data-role="note-body"]`) to select it and open the note inspector (`note-inspector`).
- Drag the body to move, drag an edge to resize, delete from the inspector.

## Driving it with Playwright

Preconditions:

- Baseline state from the map README, plus one created project open in the editor (`melody-lane` visible).
- `Нота` tool activated: `page.getByTestId('tool-draw-note').click()`, assert `aria-pressed="true"`.

- **Draw note.** Pointer-drag across the lane. Read `melody-lane` box, then `page.mouse.move(box.x + 20, box.y + 174); page.mouse.down(); page.mouse.move(box.x + 100, box.y + 174, { steps: 4 }); page.mouse.up()`. Exactly one `[data-note-id]` appears; the body rect starts ~20 px into the lane and is ~80 px wide (±1 px).
- **Inspect.** Click the note body. `note-inspector` appears and `inspector-note-name` reads `C5` (C Ionian default).
- **Move.** Drag the body to a new position. The body rect offset changes and `save-status` flips `Есть изменения` → `Сохранено`.
- **Resize.** Drag a note edge horizontally. The body width changes by a multiple of ~10 px (one grid step).
- **Delete.** Choose the inspector delete action. `[data-note-id]` count returns to 0.
- **Proof.** Screenshot + ARIA snapshot of the lane with the drawn note, plus note count before/after. Reload after `Сохранено` restores the same count. Artifacts: `artifacts/melody/lane.png`, `artifacts/melody/lane.aria.txt`.

## Gotchas

- A plain `lane.click()` draws only one grid step — duration needs a real drag with steps.
- `boundingBox()` on a note can return null right after a re-render; poll-retry the read.
- Assert geometry on `[data-role="note-body"]`, not `[data-note-id]`: outline stroke and stems expand the group box.
- Pitch rows are diatonic (12 px each), not chromatic: y=174 hits C5 only in C Ionian at default scroll/zoom.
