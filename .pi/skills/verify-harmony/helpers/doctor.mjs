#!/usr/bin/env node
// doctor.mjs — read-only readiness probe for a Harmony verification instance.
// Usage: node doctor.mjs <baseURL>
// Prints "READY <url>" (exit 0) or "NOT READY: <reason>" (exit 1). No mutations.
import { chromium } from '@playwright/test';

const baseURL = process.argv[2] ?? 'http://localhost:4321';

const fail = (reason) => {
  console.error(`NOT READY: ${reason}`);
  process.exit(1);
};

let status;
try {
  const res = await fetch(baseURL + '/');
  status = res.status;
  await res.body?.cancel();
} catch (err) {
  fail(`GET / failed: ${err.message}`);
}
if (status !== 200) fail(`GET / returned ${status}`);

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  try {
    await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    fail(`page load failed: ${err.message}`);
  }
  const title = await page.title();
  if (title !== 'Harmonic Editor') fail(`unexpected document title: ${JSON.stringify(title)}`);
  const createBtn = page.getByRole('button', { name: 'Новый проект' });
  try {
    await createBtn.waitFor({ timeout: 30_000 });
  } catch {
    fail('project list did not render a "Новый проект" button');
  }
  console.log(`READY ${baseURL}`);
} finally {
  await browser.close();
}
