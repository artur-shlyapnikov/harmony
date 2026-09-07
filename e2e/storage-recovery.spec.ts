/**
 * §3.18/§3.21/§3.22 storage-side resilience (E2E).
 *
 * 1. Corrupt-record recovery: a structurally broken project record is seeded
 *    into the app's own Dexie database (harmonic-editor, native version 10 —
 *    Dexie multiplies its API version 1 by 10) BEFORE any app code runs, via a
 *    gated `indexedDB.open` shim so the seed transaction is guaranteed to
 *    commit first. Opening the corrupt entry must show the §3.18 recovery
 *    panel («Скачать JSON» / «Создать новый» / «Удалить повреждённый») without
 *    ever navigating into the editor; the download must offer the RAW record.
 *
 * 2. Storage-failure resilience (§3.18 storage error / §3.22 «ошибки audio или
 *    storage не приводят к потере текущего in-memory project»): after the
 *    project's initial create-write succeeds, every further `projects` put
 *    throws QuotaExceededError. The editor must keep working (notes stay in
 *    memory and editable) while the persistent persistence-error banner shows.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

const CORRUPT_ID = 'e2e-corrupt-project';
const CORRUPT_TITLE = 'Corrupt Probe';
/** Missing every required document field → fails the Zod v1 schema on load. */
const CORRUPT_PAYLOAD = { schemaVersion: 1 };

/**
 * Seeds the given record into `harmonic-editor` and gates the app's first
 * IndexedDB open on the seed having committed. Runs before app code on every
 * navigation; the fake IDBOpenDBRequest is enough for Dexie, which assigns
 * `onerror`/`onblocked`/`onupgradeneeded`/`onsuccess` synchronously right
 * after calling open().
 */
async function seedCorruptRecord(page: Page): Promise<void> {
  await page.addInitScript(
    ({ dbName, nativeVersion, record }) => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberate IDB shim: the native open is captured to forward non-target opens
      const nativeOpen = IDBFactory.prototype.open;
      let pending: Promise<IDBDatabase> | null = null;
      function seed(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const open = nativeOpen.call(indexedDB, dbName, nativeVersion);
          open.onupgradeneeded = () => {
            const idb = open.result;
            const projects = idb.createObjectStore('projects', { keyPath: 'id' });
            projects.createIndex('updatedAt', 'updatedAt');
            projects.createIndex('title', 'title');
            idb.createObjectStore('settings', { keyPath: 'key' });
          };
          open.onerror = () => reject(open.error ?? new Error('indexedDB.open failed'));
          open.onsuccess = () => {
            const idb = open.result;
            const tx = idb.transaction('projects', 'readwrite');
            tx.objectStore('projects').put(record);
            tx.oncomplete = () => resolve(idb);
            tx.onerror = () => reject(tx.error ?? new Error('project seed transaction failed'));
            tx.onabort = () => reject(tx.error ?? new Error('project seed transaction aborted'));
          };
        });
      }

      type FakeOpenRequest = {
        readyState: string;
        result: IDBDatabase | null;
        error: DOMException | null;
        source: IDBFactory;
        transaction: null;
        onsuccess: ((event: Event) => void) | null;
        onerror: ((event: Event) => void) | null;
      };

      IDBFactory.prototype.open = function patchedOpen(
        this: IDBFactory,
        name?: string,
        version?: number,
      ): IDBOpenDBRequest {
        if (name === undefined || name !== dbName) return nativeOpen.call(this, name as string, version);
        pending ??= seed();
        const fakeRequest: FakeOpenRequest = {
          readyState: 'pending',
          result: null,
          error: null,
          source: this,
          transaction: null,
          onsuccess: null,
          onerror: null,
        };
        void pending.then(
          (idb) => {
            fakeRequest.readyState = 'done';
            fakeRequest.result = idb;
            if (typeof fakeRequest.onsuccess === 'function') {
              fakeRequest.onsuccess({ target: fakeRequest } as unknown as Event);
            }
          },
          (seedError: DOMException) => {
            fakeRequest.readyState = 'done';
            fakeRequest.error = seedError;
            if (typeof fakeRequest.onerror === 'function') {
              fakeRequest.onerror({ target: fakeRequest } as unknown as Event);
            }
          },
        );
        return fakeRequest as unknown as IDBOpenDBRequest;
      };
    },
    { dbName: 'harmonic-editor', nativeVersion: 10, record: {
      id: CORRUPT_ID,
      title: CORRUPT_TITLE,
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
      payload: CORRUPT_PAYLOAD,
    } },
  );
}

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

/** Lets the initial create-write through, then rejects every further put. */
async function failProjectWritesAfterCreate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let allowedWrites = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured BEFORE patching; the shim forwards to this saved reference
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patchedPut(...args: unknown[]) {
      if (this.name === 'projects') {
        allowedWrites += 1;
        if (allowedWrites > 1) {
          throw new DOMException('Encountered full disk (E2E)', 'QuotaExceededError');
        }
      }
      return nativePut.apply(this, args as [never, never]);
    };
  });
}

test.describe('storage recovery (§3.18)', () => {
  test('corrupt record opens the recovery panel; raw JSON downloads; fresh project can be created', async ({
    page,
  }) => {
    await seedCorruptRecord(page);
    await page.goto('/');

    // The seeded record is listed like any other project…
    const row = page.locator('.project-row', { hasText: CORRUPT_TITLE });
    await expect(row).toBeVisible();

    // …and clicking Открыть surfaces the corrupt panel instead of the editor.
    await row.getByRole('button', { name: 'Открыть' }).click();
    const panel = row.locator('.corrupt-panel');
    await expect(panel).toBeVisible();
    await expect(row.locator('.badge-corrupt')).toHaveText('Повреждён');
    for (const action of ['Скачать JSON', 'Создать новый', 'Удалить повреждённый']) {
      await expect(panel.getByRole('button', { name: action })).toBeVisible();
    }

    // «Скачать JSON» offers the untouched RAW record under <projectId>.json.
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Скачать JSON' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`${CORRUPT_ID}.json`);
    const raw = JSON.parse(readFileSync(await download.path(), 'utf8')) as unknown;
    expect(raw).toEqual(CORRUPT_PAYLOAD);

    // Still on the list — a corrupt document never enters the editor.
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    // «Создать новый» leads through the new-project dialog into a fresh editor.
    await panel.getByRole('button', { name: 'Создать новый' }).click();
    await page.getByLabel('Название').fill('Fresh Start');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(page).toHaveURL(/\/project\//, { timeout: 15_000 });
    await expect(page.getByTestId('melody-lane')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.toolbar-title')).toContainText('Fresh Start');
  });

  test('project stays in memory and editable when storage writes start failing', async ({
    page,
  }) => {
    await failProjectWritesAfterCreate(page);

    // Create succeeds (first put is allowed), then storage breaks.
    await createProject(page, 'Storage Failure Probe');
    await drawNote(page, 20, 174, 100);
    await expect(page.locator('[data-note-id]')).toHaveCount(1);

    // Autosave of that edit fails → persistent warning + error save status.
    const banner = page.locator('.storage-banner');
    await expect(banner).toContainText('Ошибка сохранения');
    await expect(banner).toContainText('Проект остаётся в памяти');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error');

    // Backup + Retry commands are available (§3.18 storage error actions).
    await expect(banner.getByRole('button', { name: 'Скачать резервную копию' })).toBeEnabled();
    await expect(banner.getByRole('button', { name: 'Повторить' })).toBeEnabled();

    // The editor keeps working: the note is still there and more edits land.
    await drawNote(page, 360, 222, 420);
    await expect(page.locator('[data-note-id]')).toHaveCount(2);
    await expect(page.locator('.toolbar-title')).toContainText('Storage Failure Probe');
    await expect(page.locator('[data-testid="tool-draw-note"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
