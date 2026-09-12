# Add and edit harmony chords

Clicking or dragging an empty area of the Harmony lane selects a beat-snapped range and opens the suggestion panel with categorized chord cards (safe, smooth, strong, color). Cards apply directly; the Добавить аккорд action and double-clicking a chord open the chord picker (roots, scale degrees, families, 30 templates, piano preview).

## Sub-features

- `harmony-suggest` applies a suggestion card to a selected range.
- `harmony-picker-new` inserts a chord through the picker (Добавить аккорд).
- `harmony-picker-edit` changes an existing chord (double-click → picker → apply).
- `harmony-inspect` edits root, template, and pattern override in the chord inspector.
- `harmony-no-color` shows no color-category card when no candidate qualifies.

## How to get to it (user POV)

- In the editor, click or drag empty Harmony lane (`chord-lane`) space to select a range; the suggestion panel (`suggestion-panel`) opens.
- Choose a suggestion card button to apply it (`[data-chord-id]` block appears with symbol + Roman numeral).
- Choose `Добавить аккорд` in the suggestion panel for the picker, or double-click an existing chord block (`picker-root` → `picker-apply`).
- Click a chord block to open its inspector (`chord-inspector`).

## Driving it with Playwright

Preconditions:

- Baseline state from the map README, plus one created project open in the editor (`melody-lane` visible).

- **Select range.** Click empty chord lane. Read `chord-lane` box, then `page.mouse.click(box.x + 80, box.y + 28)`. `suggestion-panel` becomes visible.
- **Apply suggestion.** Choose the first card. Run `page.getByTestId('suggestion-panel').getByRole('button').first().click()`. `[data-chord-id]` count becomes 1 and the block shows a chord symbol.
- **Picker edit.** Double-click the chord block. Run `page.locator('[data-chord-id]').first().dblclick()`, then in `picker-root` choose root `D` and `picker-apply`. The block text changes and `chord-picker` count returns to 0.
- **Second range.** Click the lane at another offset (e.g. x + 260) and apply a card again. `[data-chord-id]` count becomes 2.
- **Inspector.** Click a chord block. `chord-inspector` appears with root, template, pattern override, resolved MIDI notes, and omitted tones.
- **Proof.** Screenshot + ARIA snapshot of the lane with applied chords, plus chord counts 0 → 1 → 2 across the steps. Reload after `Сохранено` restores both chords. Artifacts: `artifacts/harmony/lane.png`, `artifacts/harmony/lane.aria.txt`.

## Gotchas

- There is no drag-to-draw chord gesture: chords only enter via suggestion cards or the picker. The toolbar `Аккорд` button does not change this path.
- The chord grid is one beat (40 px at default zoom) — coarser than the 10 px melody grid. Offsets must land on distinct beats.
- Suggestion cards depend on nearby chords and melody context; the exact chord symbol varies, so assert counts and text-change, not a fixed symbol.
