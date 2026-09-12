#!/usr/bin/env node
// drive-compose.mjs — reference drive for melody-draw + harmony-suggest.
// Usage: node drive-compose.mjs <baseURL> <outDir>
// Fresh browser context (empty IndexedDB). Exits non-zero with the failure on
// stderr. Writes compose.png, compose.aria.txt, compose.log into outDir.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

const baseURL = process.argv[2] ?? 'http://localhost:4321';
const outDir = process.argv[3] ?? './artifacts/compose-proof';
mkdirSync(outDir, { recursive: true });

const log = [];
const note = (msg) => {
  log.push(msg);
  console.log(msg);
};

const browser = await chromium.launch();
const fail = async (page, err) => {
  note(`FAIL: ${err?.message ?? err}`);
  try {
    if (page) await page.screenshot({ path: `${outDir}/failure.png` });
  } catch {}
  writeFileSync(`${outDir}/compose.log`, log.join('\n') + '\n');
  await browser.close().catch(() => {});
  process.exit(1);
};

let page;
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') note(`console.error: ${m.text().slice(0, 200)}`);
  });

  // -- Create project (real user path: dialog on the project list) ---------
  await page.goto(baseURL + '/');
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByLabel('Название').fill('Verify Proof');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page).toHaveURL(/\/project\//, { timeout: 15_000 });
  await expect(page.getByTestId('melody-lane')).toBeVisible({ timeout: 15_000 });
  note('create: editor open');

  // -- Draw a melody note (press-drag on the lane) --------------------------
  await page.getByTestId('tool-draw-note').click();
  await expect(page.getByTestId('tool-draw-note')).toHaveAttribute('aria-pressed', 'true');
  const laneBox = (await page.getByTestId('melody-lane').boundingBox()) ?? fail(page, 'melody-lane has no box');
  await page.mouse.move(laneBox.x + 20, laneBox.y + 174);
  await page.mouse.down();
  await page.mouse.move(laneBox.x + 100, laneBox.y + 174, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-note-id]')).toHaveCount(1);
  note('melody-draw: note count 0 -> 1');

  await page.locator('[data-role="note-body"]').first().click();
  await expect(page.getByTestId('note-inspector')).toBeVisible();
  note(`melody-inspect: ${await page.getByTestId('inspector-note-name').textContent()}`);

  // -- Apply a suggestion card to a chord-lane range ------------------------
  const chordBox = (await page.getByTestId('chord-lane').boundingBox()) ?? fail(page, 'chord-lane has no box');
  await page.mouse.click(chordBox.x + 80, chordBox.y + 28);
  await expect(page.getByTestId('suggestion-panel')).toBeVisible();
  await page.getByTestId('suggestion-panel').getByRole('button').first().click();
  await expect(page.locator('[data-chord-id]')).toHaveCount(1);
  note(`harmony-suggest: chord count 0 -> 1 (${await page.locator('[data-chord-id]').first().textContent()})`);

  // -- Persistence second view: debounced save, then reload restores -------
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено', { timeout: 10_000 });
  note('save-status: Сохранено');
  await page.reload();
  await expect(page.locator('[data-note-id]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('[data-chord-id]')).toHaveCount(1);
  note('reload: 1 note + 1 chord restored from IndexedDB');

  // -- Evidence --------------------------------------------------------------
  await page.screenshot({ path: `${outDir}/compose.png` });
  const snapshot = await page.locator('#root').ariaSnapshot();
  writeFileSync(`${outDir}/compose.aria.txt`, snapshot);
  writeFileSync(`${outDir}/compose.log`, log.join('\n') + '\n');
  note(`evidence: ${outDir}/compose.png, compose.aria.txt, compose.log`);
  await browser.close();
} catch (err) {
  await fail(page, err);
}
