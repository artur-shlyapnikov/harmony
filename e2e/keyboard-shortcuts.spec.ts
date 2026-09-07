/**
 * §3.20/§3.22 keyboard shortcuts beyond undo (E2E): Space toggles the
 * transport play/pause, Delete removes the selected note, ArrowUp/Down move
 * it diatonically, Alt+ArrowUp/Down by semitone, ArrowLeft/Right move it by
 * one note grid horizontally, Shift+ArrowLeft/Right resize it by one grid
 * step (never below one grid), Escape clears the selection — and redo
 * (Ctrl/Cmd+Shift+Z) reapplies the undone action.
 * Every shortcut is asserted through observable state (transport status,
 * note count/geometry, inspector MIDI), never through internals.
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

/** Draw a C5 block and select it; returns the selected note group. */
async function drawAndSelectNote(page: Page): Promise<Locator> {
  await page.getByTestId('tool-draw-note').click();
  await dragOn(page, 'melody-lane', { x: 20, y: 174 }, { x: 80, y: 174 }); // C5
  const groups = page.locator('[data-note-id]');
  await expect(groups).toHaveCount(1);
  await groups.locator('[data-role="note-body"]').first().click();
  await expect(page.getByTestId('inspector-midi')).toHaveText('72');
  return groups;
}

/** Rounded geometry snapshot; `null` keeps expect.poll retrying. */
async function roundedBox(locator: Locator): Promise<{ x: number; y: number; w: number } | null> {
  const box = await locator.boundingBox();
  if (box === null) return null;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return { x: round(box.x), y: round(box.y), w: round(box.width) };
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

test.describe('keyboard shortcuts', () => {
  test('Space toggles transport play/pause', async ({ page }) => {
    await createProject(page, 'Клавиши Транспорт');
    const status = page.getByTestId('transport-status');
    await expect(status).toHaveAttribute('data-status', 'idle');

    // Focus guard (E2E-Q5): if the just-clicked «Создать» button or its
    // dialog overlay retained focus after the route change, Space would
    // re-activate the button instead of toggling the transport
    // (firefox/webkit flake). Blur to a neutral element first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');

    await page.keyboard.press(' ');
    // 'starting' → 'playing' once audio init resolves.
    await expect(status).toHaveAttribute('data-status', 'playing', { timeout: 15_000 });
    await page.keyboard.press(' ');
    await expect(status).toHaveAttribute('data-status', 'paused');
  });

  test('Delete removes the selected note', async ({ page }) => {
    await createProject(page, 'Клавиши Delete');
    const groups = await drawAndSelectNote(page);

    await page.keyboard.press('Delete');
    await expect(groups).toHaveCount(0);
    await expect(page.getByTestId('inspector-midi')).toHaveCount(0);
  });

  test('ArrowUp/Down step diatonically, Alt+ArrowUp/Down by semitone', async ({ page }) => {
    await createProject(page, 'Клавиши Стрелки');
    await drawAndSelectNote(page);

    // Diatonic steps in C ionian: C5 → D5 → back to C5.
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('inspector-midi')).toHaveText('74');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('inspector-midi')).toHaveText('72');

    // Chromatic nudges: C5 → C♯5 → back to C5.
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByTestId('inspector-midi')).toHaveText('73');
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.getByTestId('inspector-midi')).toHaveText('72');
  });

  test('ArrowLeft/Right move by grid, Shift+ArrowLeft/Right resize', async ({ page }) => {
    await createProject(page, 'Клавиши Влево-Вправо');
    await drawAndSelectNote(page);
    const body = page.locator('[data-role="note-body"]').first();
    const before = await roundedBox(body);
    if (before === null) throw new Error('note body not rendered');
    // One note-grid step = 240 ticks = 10px at the default zoom (40 px/beat,
    // 960 ticks per beat). The drawn note spans 6 grid steps.
    const STEP_PX = 10;
    const moved = { x: before.x + STEP_PX, y: before.y, w: before.w };

    await page.keyboard.press('ArrowRight');

    // Resize the right edge: duration +1 grid, start tick unchanged.
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => roundedBox(body)).toEqual({
      x: moved.x,
      y: before.y,
      w: before.w + STEP_PX,
    });

    // Shrink back down to exactly one grid step…
    for (let presses = before.w / STEP_PX; presses > 0; presses -= 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    const minBox = { x: moved.x, y: before.y, w: STEP_PX };
    await expect.poll(() => roundedBox(body)).toEqual(minBox);

    // …and §3.20/§3.4: the duration never goes below one grid step.
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => roundedBox(body)).toEqual(minBox);

    // Moving left returns the start to its original tick.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => roundedBox(body)).toEqual({ x: before.x, y: before.y, w: STEP_PX });
  });

  test('Escape clears the selection but keeps the note', async ({ page }) => {
    await createProject(page, 'Клавиши Escape');
    const groups = await drawAndSelectNote(page);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('inspector-midi')).toHaveCount(0);
    await expect(groups).toHaveCount(1);
  });

  test('Ctrl/Cmd+Shift+Z redoes the undone action', async ({ page }) => {
    await createProject(page, 'Клавиши Redo');
    await page.getByTestId('tool-draw-note').click();
    await dragOn(page, 'melody-lane', { x: 20, y: 174 }, { x: 80, y: 174 }); // C5
    const body = page.locator('[data-role="note-body"]').first();
    await expect(body).toHaveCount(1);
    const before = await roundedBox(body);
    expect(before).not.toBeNull();

    await page.keyboard.press(`${UNDO_MOD}+z`);
    await expect(page.locator('[data-note-id]')).toHaveCount(0);

    await page.keyboard.press(`${UNDO_MOD}+Shift+z`);
    await expect(page.locator('[data-note-id]')).toHaveCount(1);
    // Same note back at the same place (auto-retrying read).
    await expect.poll(() => roundedBox(page.locator('[data-role="note-body"]').first())).toEqual(
      before,
    );
  });
});
