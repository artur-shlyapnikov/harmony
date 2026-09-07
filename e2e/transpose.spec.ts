/**
 * §3.14 transpose + §6 step 15 (E2E): a Key change transposes every melody
 * note (blocks shift up on the staff) and recomputes chord labels; undo
 * restores the pre-transpose document. A transpose that would push a note
 * past midi 96 is rejected wholesale: error toast, document untouched.
 *
 * Geometry (zoom 40 px/beat): MelodyLane row r top at y=(49-r)*12; C5 (row
 * 35) → y=168; one diatonic step = 12 px. Lane top rows map to midi 95/96.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const UNDO_MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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

async function dragOn(
  page: Page,
  laneTestId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = await stableBox(page.getByTestId(laneTestId));
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 4 });
  await page.mouse.up();
}

async function clickLane(page: Page, laneTestId: string, at: { x: number; y: number }): Promise<void> {
  const box = await stableBox(page.getByTestId(laneTestId));
  await page.mouse.click(box.x + at.x, box.y + at.y);
}

/** Playwright's bounding-box shape (minus its null variant). */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Retrying non-null box read (E2E-LAZY-4): a re-render can make a one-shot
 * `(await locator.boundingBox())!` snapshot return null; `expect.poll` waits
 * the transient null out instead. */
async function stableBox(locator: Locator): Promise<Box> {
  let box: Box | null = null;
  await expect
    .poll(async () => {
      box = await locator.boundingBox();
      return box;
    })
    .not.toBeNull();
  if (box === null) throw new Error('stableBox: element never rendered a box');
  return box;
}

async function applyFirstSuggestion(page: Page): Promise<void> {
  await expect(page.getByTestId('suggestion-panel')).toBeVisible();
  await page.getByTestId('suggestion-panel').getByRole('button').first().click();
}

test.describe('transpose', () => {
  test('key change shifts notes, recomputes labels; undo restores', async ({ page }) => {
    await createProject(page, 'Transpose Up');
    await page.getByTestId('tool-draw-note').click();
    await dragOn(page, 'melody-lane', { x: 20, y: 174 }, { x: 80, y: 174 }); // C5

    // A chord so we can watch its label recompute.
    await clickLane(page, 'chord-lane', { x: 80, y: 28 });
    await applyFirstSuggestion(page);
    const chord = page.locator('[data-chord-id]');
    await expect(chord).toHaveCount(1);
    // E2E-RACE: retry until the label is actually committed before reading.
    await expect(chord.first()).toHaveText(/\S/);
    const symbolInC = (await chord.first().textContent()) ?? '';

    const body = page.locator('[data-role="note-body"]').first();
    await expect(body).toHaveCount(1);
    // The body rect is exactly the block geometry — the group bbox also
    // contains ledger lines that reach far below high notes.
    // E2E-LAZY-4: retrying read instead of a one-shot `!` snapshot.
    const yBefore = (await stableBox(body)).y;

    // C → D (+2 semitones / +1 diatonic step for in-key notes).
    await page.getByRole('combobox', { name: 'Тональность' }).selectOption('D');
    await expect(page.locator('.toast-success')).toContainText('Транспонировано в D');
    // E2E-RACE: auto-retrying instead of a one-shot boundingBox read after
    // keyboard.select — React's async commit can't be read stale.
    await expect.poll(async () => (await body.boundingBox())?.y ?? null).toBe(yBefore - 12);
    await expect
      .poll(async () => (await chord.first().textContent()) ?? '')
      .not.toBe(symbolInC);

    // Undo restores the pre-transpose state exactly.
    await page.keyboard.press(`${UNDO_MOD}+z`);
    await expect.poll(async () => (await body.boundingBox())?.y ?? null).toBe(yBefore);
    await expect(chord.first()).toHaveText(symbolInC);
  });

  test('out-of-range transpose is rejected with an error toast and no changes', async ({
    page,
  }) => {
    await createProject(page, 'Ceiling Notes');
    await page.getByTestId('tool-draw-note').click();
    // Very top of the lane → nearest natural row is C7 = midi 96.
    await dragOn(page, 'melody-lane', { x: 20, y: 4 }, { x: 60, y: 4 });

    const body = page.locator('[data-role="note-body"]').first();
    await expect(body).toHaveCount(1);
    await body.click();
    await expect(page.getByTestId('inspector-midi')).toHaveText('96');

    // E2E-LAZY-4: retrying read instead of a one-shot `!` snapshot.
    const boxBefore = await stableBox(body);

    // +1 semitone would push the note to 97 — rejected wholesale.
    await page.getByRole('combobox', { name: 'Тональность' }).selectOption('C#');
    // src/state/commands.ts:481 — count suffix varies, assert stable prefix.
    await expect(page.locator('.toast-error')).toContainText(/Не удалось транспонировать/);

    // Document unchanged: same single note at the same place.
    await expect(page.locator('[data-note-id]')).toHaveCount(1);
    // E2E-RACE: auto-retrying instead of one-shot boundingBox reads.
    await expect
      .poll(async () => {
        const box = await body.boundingBox();
        return box === null ? null : { x: box.x, y: box.y };
      })
      .toEqual({ x: boxBefore.x, y: boxBefore.y });
    await expect(page.getByRole('combobox', { name: 'Тональность' })).toHaveValue('C');
  });
});
