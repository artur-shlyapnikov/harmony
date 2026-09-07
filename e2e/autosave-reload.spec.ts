/**
 * Autosave + reload persistence (E2E): after an edit, the save-status
 * indicator reaches «Сохранено» (autosave debounce 750 ms); a page reload
 * restores the exact same content (note count and positions) from IndexedDB.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

async function createProject(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByLabel('Название').fill(title);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  // Full-suite runs put 9 chromium workers on this machine; the
  // create→IndexedDB→navigate chain needs more than the 5 s default.
  await expect(page).toHaveURL(/\/project\//, { timeout: 15_000 });
  await expect(page.getByTestId('melody-lane')).toBeVisible({ timeout: 15_000 });
}

async function drawNote(page: Page, x1: number, y1: number, x2: number): Promise<void> {
  await page.getByTestId('tool-draw-note').click();
  const box = await stableBox(page.getByTestId('melody-lane'));
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  await page.mouse.move(box.x + x2, box.y + y1, { steps: 4 });
  await page.mouse.up();
}

async function noteGeometry(page: Page): Promise<{ count: number; boxes: { x: number; y: number }[] }> {
  const laneBox = await stableBox(page.getByTestId('melody-lane'));
  const notes = page.locator('[data-note-id]');
  const count = await notes.count();
  const boxes: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const box = await stableBox(
      notes.nth(index).locator('[data-role="note-body"]').first(),
    );
    // note-body rect excludes the selection outline/stems that expand the
    // [data-note-id] group bbox; selection is dropped on reload.
    boxes.push({ x: Math.round(box.x - laneBox.x), y: Math.round(box.y - laneBox.y) });
  }
  return { count, boxes };
}

/** Retrying non-null box read (E2E-LAZY-4): a re-render can make a one-shot
 * `(await locator.boundingBox())!` snapshot return null; `expect.poll` waits
 * the transient null out instead. */
async function stableBox(locator: Locator): Promise<{ x: number; y: number }> {
  let box: { x: number; y: number } | null = null;
  await expect
    .poll(async () => {
      const next = await locator.boundingBox();
      if (next !== null) box = { x: next.x, y: next.y };
      return box;
    })
    .not.toBeNull();
  if (box === null) throw new Error('stableBox: element never rendered a box');
  return box;
}

test.describe('autosave + reload', () => {
  test('edits persist across reload once save status reports saved', async ({ page }) => {
    await createProject(page, 'Autosave Probe');
    await drawNote(page, 20, 174, 100);

    // The transient «Есть изменения» state is deliberately not asserted: under
    // worker load the first save-status poll can start after the 750 ms
    // debounce already committed, so only the durable «Сохранено» end state
    // is race-free (E2E-RACE-2).
    await expect(page.getByTestId('save-status')).toHaveText('Сохранено', { timeout: 10_000 });
    const afterFirstEdit = await noteGeometry(page);
    expect(afterFirstEdit.count).toBe(1);

    await page.reload();
    await expect(page.locator('[data-note-id]')).toHaveCount(1);
    expect(await noteGeometry(page)).toEqual(afterFirstEdit);

    await drawNote(page, 360, 222, 420);
    // A second edit updates the persisted document too.
    // Durable state only — see the E2E-RACE-2 note at the first save.
    await expect(page.getByTestId('save-status')).toHaveText('Сохранено', { timeout: 10_000 });
    const afterSecondEdit = await noteGeometry(page);
    expect(afterSecondEdit.count).toBe(2);

    await page.reload();
    await expect(page.locator('[data-note-id]')).toHaveCount(2);
    expect(await noteGeometry(page)).toEqual(afterSecondEdit);

    // Title survived as well.
    await expect(page.locator('.toolbar-title')).toContainText('Autosave Probe');
  });
});
