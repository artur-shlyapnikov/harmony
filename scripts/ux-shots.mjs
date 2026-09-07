// UX review screenshots; drives the dev server at localhost:5173.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const OUT = '.ux-shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto('http://localhost:5173/');
await page.waitForLoadState('networkidle');

// 1 - project list (empty IndexedDB first run)
await page.screenshot({ path: `${OUT}/01-project-list-empty.png` });

// 2 - new project dialog
await page.getByRole('button', { name: 'Новый проект' }).click();
await page.waitForTimeout(100);
await page.screenshot({ path: `${OUT}/02-new-project-dialog.png` });

// create the project -> editor
await page.getByLabel('Название').fill('UX Review');
await page.getByLabel('Количество тактов').fill('16');
await page.getByRole('button', { name: 'Создать', exact: true }).click();
await page.getByTestId('melody-lane').waitFor();
await page.screenshot({ path: `${OUT}/03-editor-empty.png` });

const lane = page.getByTestId('melody-lane');
// 4 - draw two melody notes (a fresh empty score opens with the Нота tool)
const drawAt = async (x, y) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await page.evaluate(() => document.querySelectorAll('[data-note-id]').length);
    await lane.click({ position: { x, y } });
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => document.querySelectorAll('[data-note-id]').length);
    if (after > before) return;
  }
  throw new Error(`draw at ${x},${y} did not register after 3 attempts`);
};
await drawAt(40, 306);
await drawAt(330, 306);

await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/04-editor-notes.png` });

// 5 - range-select on chord lane -> suggestions
await page.getByRole('button', { name: 'Выбор', exact: true }).click();
await page.getByTestId('chord-lane').click({ position: { x: 40, y: 30 } });
await page.getByTestId('suggestion-panel').waitFor();
await page.screenshot({ path: `${OUT}/05-editor-suggestions.png` });

// 6 - apply first suggestion -> composed state
await page.locator('.suggestion-card button').first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/06-editor-composed.png` });

// 7 - chord picker over the editor
await page.getByTestId('chord-lane').dblclick({ position: { x: 40, y: 30 } });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/07-chord-picker.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// 8 - click the first note's body -> note inspector
const noteBox = await page.evaluate(() => {
  const n = document.querySelector('[data-note-id]');
  const r = n.getBoundingClientRect();
  return { x: r.x + 6, y: r.y + r.height / 2 };
});
await page.mouse.click(noteBox.x, noteBox.y);
await page.screenshot({ path: `${OUT}/08-note-inspector.png` });

await browser.close();
console.log('done');
