/**
 * §3.20 UI-VIEW-2 / §3.22 DoD (E2E): the zoom controls change the px/beat
 * value AND keep the left-edge tick anchored — a ruler boundary parked
 * exactly on the viewport's left edge stays there after zooming (the
 * scroller resyncs scrollLeft to scrollTick × newPxPerTick).
 *
 * Geometry: ruler labels sit every CHORD_GRID (960 ticks = 1 beat), i.e.
 * every 40 px at the default 40 px/beat — scrollLeft 320 puts label «9»
 * exactly at the left edge; at 50 px/beat the same tick resyncs scrollLeft
 * to 320 × 50/40 = 400 and the SAME label must still sit there.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

async function createProject(page: Page, title: string, bars: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByLabel('Название').fill(title);
  // Enough bars that the timeline can actually scroll in a 1500px viewport.
  await page.getByLabel('Количество тактов').fill(bars);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  // Full-suite runs put 9 chromium workers on this machine; the
  // create→IndexedDB→navigate chain needs more than the 5 s default.
  await expect(page).toHaveURL(/\/project\//, { timeout: 15_000 });
  await expect(page.getByTestId('melody-lane')).toBeVisible({ timeout: 15_000 });
}

/** Ruler label at the viewport's left edge + its offset + scroller.scrollLeft. */
function anchorState(page: Page): Promise<{ bar: string; offset: number; scrollLeft: number } | null> {
  return page.evaluate(() => {
    const scrollerEl = document.querySelector('[data-testid="timeline-scroller"]');
    if (scrollerEl === null) return null;
    const sLeft = scrollerEl.getBoundingClientRect().left;
    const labels = [
      ...scrollerEl.querySelectorAll<HTMLElement>('[data-testid="bar-ruler"] span'),
    ];
    let firstVisible: HTMLElement | null = null;
    for (const label of labels) {
      if (label.getBoundingClientRect().right >= sLeft) {
        firstVisible = label;
        break;
      }
    }
    if (firstVisible === null) return null;
    return {
      bar: (firstVisible.textContent ?? '').trim(),
      offset: Math.round(firstVisible.getBoundingClientRect().left - sLeft),
      scrollLeft: Math.round(scrollerEl.scrollLeft),
    };
  });
}

test.describe('zoom controls', () => {
  test('zoom-in changes px/beat and keeps the left-edge bar anchored', async ({ page }) => {
    await createProject(page, 'Zoom Anchor', '32');
    const scroller = page.getByTestId('timeline-scroller');

    // Park the boundary before the ruler's bar-3 label exactly on the left
    // edge (320 px = 8 beats = start of bar 3; r77 labels bars, not beats).
    await scroller.evaluate((el) => {
      el.scrollLeft = 320;
    });
    await expect(page.getByTestId('zoom-value')).toHaveText('40 px/beat');
    await expect.poll(anchorState.bind(null, page)).toEqual({ bar: '3', offset: 0, scrollLeft: 320 });

    await page.getByTestId('zoom-in').click();
    await expect(page.getByTestId('zoom-value')).toHaveText('50 px/beat');
    // Same label still anchored; scrollLeft resynced to scrollTick × newPxPerTick.
    await expect.poll(anchorState.bind(null, page)).toEqual({ bar: '3', offset: 0, scrollLeft: 400 });
  });
});
