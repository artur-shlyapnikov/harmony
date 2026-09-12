# Create and manage projects

Creating a project from the project list opens the editor on a fresh document (defaults C Ionian, 8 bars, 120 BPM, 4/4, empty lanes). The list can also open, duplicate, and delete projects; rows show title, modification time, and stored metadata.

## Sub-features

- `projects-create` creates a project from the dialog and lands in the editor.
- `projects-create-validation` rejects out-of-range bar counts with an inline error.
- `projects-open` reopens an existing project from its row.
- `projects-duplicate` copies a project into a new row.
- `projects-delete` removes a project from the list.

## How to get to it (user POV)

- Choose the `Новый проект` button on the `/` project list, fill the dialog, choose `Создать`.
- Choose a project row (title element `project-row-title`) to open it.
- Use the row actions for duplicate and delete.
- Dialog fields: `Название`, tonic `Тоника` (letter `Буква тоники`, accidental `Альтерация тоники`), mode `Лад`, `Количество тактов` (1–128).

## Driving it with Playwright

Preconditions:

- Baseline state from the map README (isolated preview, fresh context, doctor `READY`).
- Project list is empty (fresh context guarantees this).

- **Create project.** Choose `Новый проект`, fill `Название`, choose `Создать`. Run `page.getByRole('button', { name: 'Новый проект' }).click()`, `page.getByLabel('Название').fill('Verify Sonata')`, `page.getByRole('button', { name: 'Создать', exact: true }).click()`. URL matches `/project\//` and `melody-lane` becomes visible (up to 15 s).
- **Validation.** Reopen the dialog and enter an out-of-range bar count. Run `page.getByLabel('Количество тактов').fill('999')`. An inline error about the 1–128 range appears and the project is not created.
- **Open.** Return to `/` and choose the row. Run `page.goto('/')`, `page.getByTestId('project-row-title').first().click()`. The editor opens on the same project (URL id matches).
- **Duplicate.** Choose the row duplicate action back on `/`. A second row with the same title appears; opening it shows the same content.
- **Delete.** Choose the row delete action. The row disappears; reload keeps it gone (IndexedDB read-back).
- **Proof.** Screenshot + ARIA snapshot of the list showing the created row. Artifacts: `artifacts/projects/list.png`, `artifacts/projects/list.aria.txt`.

## Gotchas

- Creation writes IndexedDB before navigating: asserting only the click races the write. Wait for the URL and `melody-lane`.
- `Создать` must be the exact-name match; other buttons contain similar text.
- Bar count is validated inline in the dialog — a rejected value never reaches the editor, so assert the dialog error, not a missing row.
