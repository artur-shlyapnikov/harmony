/**
 * §3.22 DoD «изменение mode не перемещает MIDI notes» (E2E): switching the
 * Лад select keeps every existing block exactly where it was while the
 * harmony analysis re-classifies in place (a pitch that leaves the new mode
 * turns chromatic), and notes drawn afterwards sound + highlight per the NEW
 * mode (B row → B♭4 = midi 70 in C locrian, still a scale tone).
 *
 * Geometry (zoom 40 px/beat): diatonic row r top at y=(49-r)*12 — C5 (row
 * 35) spans y 168..180, D5 (row 36) → 156..168, B4 (row 34) → 180..192.
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

/** Pointer-draw on a lane using viewport-relative offsets into its box. */
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

/** Rounded geometry snapshot; `null` keeps expect.poll retrying. */
async function roundedBox(locator: Locator): Promise<{ x: number; y: number } | null> {
  const box = await locator.boundingBox();
  if (box === null) return null;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return { x: round(box.x), y: round(box.y) };
}

/** Retrying non-null lane-box read (E2E-LAZY-4): a re-render can make a
 * one-shot `(await locator.boundingBox())!` snapshot return null;
 * `expect.poll` waits the transient null out instead. */
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

test.describe('mode switch', () => {
  test('switching Лад keeps note geometry and re-highlights per the new mode', async ({
    page,
  }) => {
    await createProject(page, 'Mode Switch');
    await page.getByTestId('tool-draw-note').click();
    await dragOn(page, 'melody-lane', { x: 20, y: 174 }, { x: 80, y: 174 }); // C5
    await dragOn(page, 'melody-lane', { x: 100, y: 162 }, { x: 160, y: 162 }); // D5

    const groups = page.locator('[data-note-id]');
    await expect(groups).toHaveCount(2);
    const cBody = groups.nth(0).locator('[data-role="note-body"]');
    const dBody = groups.nth(1).locator('[data-role="note-body"]');
    const cBefore = await roundedBox(cBody);
    const dBefore = await roundedBox(dBody);
    expect(cBefore).not.toBeNull();
    expect(dBefore).not.toBeNull();

    // Both pitches are diatonic in C ionian.
    await expect(groups.nth(0).locator('title').first()).toContainText('Ступень лада');
    await expect(groups.nth(1).locator('title').first()).toContainText('Ступень лада');

    // Ионийский → Локрийский: D leaves the scale; nothing may move.
    await page.getByRole('combobox', { name: 'Лад' }).selectOption('locrian');
    await expect(page.getByRole('combobox', { name: 'Лад' })).toHaveValue('locrian');
    // Auto-retrying so React's async commit can't be read stale.
    await expect.poll(() => roundedBox(cBody)).toEqual(cBefore);
    await expect.poll(() => roundedBox(dBody)).toEqual(dBefore);

    // Analysis re-runs in place: D5 is chromatic now, tonic C5 stays in scale.
    await expect(groups.nth(0).locator('title').first()).toContainText('Ступень лада');
    await expect(groups.nth(1).locator('title').first()).toContainText('Хроматика');

    // New entries use the NEW mode's spelling: B row sounds B♭4 (midi 70)
    // and highlights as a scale tone of C locrian.
    await dragOn(page, 'melody-lane', { x: 180, y: 186 }, { x: 240, y: 186 }); // B row
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(2).locator('title').first()).toContainText('Ступень лада');
    await groups.nth(2).locator('[data-role="note-body"]').click();
    await expect(page.getByTestId('inspector-midi')).toHaveText('70');
  });
});
