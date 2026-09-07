/**
 * §3.21 degraded mode (E2E): AudioContext.resume is blocked before app load.
 * The app must still load, edit, autosave and export MIDI; attempting Play
 * lands the transport in the error state with a visible Retry Audio button.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Tone.js probes `window.AudioContext` at import time, so a constructor
    // that throws would crash the bundle. Keep the native constructor but
    // make contexts unresumable — Tone.start() awaits resume(), which now
    // rejects and lands the transport in 'error' (§3.21).
    const Native = window.AudioContext;
    class BlockedAudioContext extends Native {
      override resume(): Promise<void> {
        return Promise.reject(new DOMException('Audio blocked for E2E', 'NotAllowedError'));
      }

      override get state(): AudioContextState {
        return 'suspended';
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: BlockedAudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { value: BlockedAudioContext });
  });
});

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

test.describe('audio failure degraded mode', () => {
  test('editing, saving and MIDI export work without audio; Play surfaces Retry Audio', async ({
    page,
  }) => {
    await createProject(page, 'Silent Mode');

    // Editing still works.
    await drawNote(page, 20, 174, 100);
    await expect(page.locator('[data-note-id]')).toHaveCount(1);

    // MIDI export does not depend on audio: a real .mid downloads.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспортировать MIDI' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.mid$/);
    const bytes = readFileSync(await download.path());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('MThd');

    // Attempting playback fails into the §3.21 error state.
    await page.getByRole('button', { name: 'Играть' }).click();
    const status = page.getByTestId('transport-status');
    await expect(status).toContainText('Ошибка звука');
    const retry = page.getByRole('button', { name: 'Повторить звук' });
    await expect(retry).toBeVisible();

    // Retrying keeps failing gracefully (still error, still editable).
    await retry.click();
    await expect(status).toContainText('Ошибка звука');
    await drawNote(page, 360, 222, 420);
    await expect(page.locator('[data-note-id]')).toHaveCount(2);

    // The transient «Есть изменения» state is deliberately not asserted: under
    // worker load the first save-status poll can start after the 750 ms
    // debounce already committed, so only the durable «Сохранено» end state
    // is race-free (E2E-RACE-2).
    await expect(page.getByTestId('save-status')).toHaveText('Сохранено', { timeout: 10_000 });
  });
});
