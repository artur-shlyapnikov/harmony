/**
 * §3.22 DoD / §3.19 (E2E-Q3): a pattern override is applied through the real
 * UI (chord inspector «Паттерн» select), persists visually on both the
 * inspector select and the chord block override marker (♪), and playback with
 * the patterned project reaches the 'playing' transport state with an
 * advancing playhead. Audio itself is covered by unit tests — this spec stays
 * at the UI level.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

async function createProject(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByLabel('Название').fill(title);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  // Full-suite runs put 9 chromium workers on this machine (see
  // storage-recovery.spec.ts); the create→IndexedDB→navigate chain needs more
  // than the 5 s default.
  await expect(page).toHaveURL(/\/project\//, { timeout: 15_000 });
  await expect(page.getByTestId('melody-lane')).toBeVisible({ timeout: 15_000 });
}

/** Single click (range selection on the chord lane). */
async function clickLane(
  page: Page,
  laneTestId: string,
  at: { x: number; y: number },
): Promise<void> {
  const box = (await page.getByTestId(laneTestId).boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
}

async function applyFirstSuggestion(page: Page): Promise<void> {
  await expect(page.getByTestId('suggestion-panel')).toBeVisible();
  await page.getByTestId('suggestion-panel').getByRole('button').first().click();
}

async function playheadX(page: Page): Promise<number> {
  const transform = await page.getByTestId('playhead').evaluate((el) => el.style.transform);
  const px = /translateX\(([\d.-]+)px\)/.exec(transform)?.[1];
  // Unparseable/missing transform must fail loudly, not masquerade as x=0.
  if (px === undefined) return -1;
  return parseFloat(px);
}

test.describe('pattern override', () => {
  test('chord inspector override persists and playback runs with it', async ({ page }) => {
    await createProject(page, 'Паттерн E2E');

    // -- Add one chord via empty-range click + suggestion card -------------
    await clickLane(page, 'chord-lane', { x: 80, y: 28 });
    await applyFirstSuggestion(page);
    const chord = page.locator('[data-chord-id]');
    await expect(chord).toHaveCount(1);

    // No override marker yet (inherits the default pattern).
    await expect(chord.locator('.chord-block-pattern')).toHaveCount(0);

    // -- Select the chord → chord inspector shows the pattern control ------
    await chord.first().click();
    await expect(page.getByTestId('chord-inspector')).toBeVisible();
    const patternSelect = page.getByTestId('inspector-pattern');
    await expect(patternSelect).toBeVisible();
    // Empty value = «наследовать» (no per-chord override).
    await expect(patternSelect).toHaveValue('');

    // -- Switch the pattern to «Арпеджио вверх» ----------------------------
    await patternSelect.selectOption({ label: 'Арпеджио вверх' });

    // Selection persists visually in two places:
    //   1) the inspector select keeps the chosen kind;
    await expect(patternSelect).toHaveValue('up');
    //   2) the chord block grows the ♪ «Переопределён паттерн» marker.
    await expect(chord.locator('.chord-block-pattern')).toHaveCount(1);

    // -- Play: transport reaches 'playing' and the playhead advances -------
    await page.getByRole('button', { name: 'Играть' }).click();
    // 'starting' → 'playing' once audio init resolves.
    await expect(page.getByTestId('transport-status')).toHaveAttribute('data-status', 'playing');
    // Auto-retrying assertion: the rAF pump keeps moving the playhead forward.
    const startX = await playheadX(page);
    await expect.poll(() => playheadX(page), { timeout: 10_000, intervals: [100] }).toBeGreaterThan(
      startX,
    );
  });
});
