/**
 * §3.22 main vertical slice (E2E): create project → land in editor → draw a
 * melody note (pointer drag, NOTE_GRID quantization) → add a chord via
 * empty-range click → apply through ChordPicker → apply a suggestion card on
 * a second range → Export MIDI download (MThd buffer check) → undo removes
 * the last action → reload restores the document from IndexedDB.
 *
 * Geometry cheat-sheet (default zoom 40 px/beat, PPQ 960):
 *   bar = 160 px, NOTE_GRID (240 ticks) = 10 px;
 *   MelodyLane height = 432 px, diatonic row r has its top at y=(49-r)*12,
 *   so C5 (midi 72, row 35) spans y 168..180.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Minimal big-endian MIDI chunk walker (§3.19 DoD: «MIDI содержит отдельные
// melody и harmony tracks»). No new deps: MThd header + MTrk event scan.
// ---------------------------------------------------------------------------

type MidiTrackInfo = {
  /** FF 03 track-name meta, '' when absent. */
  name: string;
  /** Channels of note-on (9n, velocity > 0) events. */
  noteOnChannels: number[];
  /** Pitches of note-on events in stream order. */
  pitches: number[];
};

/** VLQ (variable-length quantity) used for deltas and meta lengths. */
function readVarLen(data: Buffer, pos: number): [value: number, next: number] {
  let value = 0;
  let p = pos;
  let byte = 0x80;
  while (byte & 0x80) {
    byte = data[p++]!;
    value = (value << 7) | (byte & 0x7f);
  }
  return [value, p];
}

function parseMidiTracks(bytes: Buffer): { ntrks: number; tracks: MidiTrackInfo[] } {
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4);
  const ntrks = view.getUint16(10);
  let off = 8 + headerLen;
  const tracks: MidiTrackInfo[] = [];
  while (off + 8 <= bytes.length) {
    const id = bytes.subarray(off, off + 4).toString('ascii');
    const len = view.getUint32(off + 4);
    if (id === 'MTrk') {
      const data = bytes.subarray(off + 8, off + 8 + len);
      const track: MidiTrackInfo = { name: '', noteOnChannels: [], pitches: [] };
      let p = 0;
      let runningStatus = 0;
      while (p < data.length) {
        [, p] = readVarLen(data, p); // delta time
        let status = data[p++]!;
        if ((status & 0x80) === 0) {
          status = runningStatus; // running status: reuse last channel message
          p -= 1;
        } else if (status < 0xf0) {
          runningStatus = status;
        }
        if (status === 0xff) {
          const metaType = data[p++]!;
          const [metaLen, afterLen] = readVarLen(data, p);
          if (metaType === 0x03) {
            track.name = data.subarray(afterLen, afterLen + metaLen).toString('utf8');
          }
          p = afterLen + metaLen;
        } else if (status === 0xf0 || status === 0xf7) {
          const [sysexLen, afterLen] = readVarLen(data, p);
          p = afterLen + sysexLen;
        } else {
          // Channel voice message: 2 data bytes except 0xc*/0xd* (one).
          const dataBytes = (status & 0xe0) === 0xc0 ? 1 : 2;
          if ((status & 0xf0) === 0x90 && data[p + 1]! > 0) {
            track.noteOnChannels.push(status & 0x0f);
            track.pitches.push(data[p]!);
          }
          p += dataBytes;
        }
      }
      tracks.push(track);
    }
    off += 8 + len;
  }
  return { ntrks, tracks };
}

const UNDO_MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.use({ viewport: { width: 1500, height: 900 } });

async function createProject(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByLabel('Название').fill(title);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  // create → IndexedDB → navigate chain needs more than the 5 s default
  // under full-suite parallel load (workers:10), same as storage-recovery.
  await expect(page).toHaveURL(/\/project\//, { timeout: 15_000 });
  await expect(page.getByTestId('melody-lane')).toBeVisible({ timeout: 15_000 });
}
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Null-tolerant boundingBox read: retries through re-render detach races. */
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

/** Pointer-draw on a lane using viewport-relative offsets into its box. */
async function dragOn(
  page: Page,
  laneTestId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = (await page.getByTestId(laneTestId).boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 4 });
  await page.mouse.up();
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

test.describe('main vertical slice', () => {
  test('create → compose → export MIDI → undo → reload restores', async ({ page }) => {
    await createProject(page, 'E2E Sonata');

    // -- Draw a melody note on MelodyLane ---------------------------------
    await page.getByTestId('tool-draw-note').click();
    await expect(page.getByTestId('tool-draw-note')).toHaveAttribute('aria-pressed', 'true');
    await dragOn(page, 'melody-lane', { x: 20, y: 174 }, { x: 100, y: 174 });

    const note = page.locator('[data-note-id]');
    await expect(note).toHaveCount(1);

    // NOTE_GRID quantization: 1920 ticks → 80 px block starting at 480 ticks
    // (20 px), i.e. the rendered block is grid-aligned and a multiple of 10 px.
    const laneBox = await stableBox(page.getByTestId('melody-lane'));
    const noteBox = await stableBox(note.locator('[data-role="note-body"]').first());
    // Block spans 480..2400 ticks → 20 px offset, 80 px wide at 40 px/beat.
    // Measured on the note-body rect: excludes the selection outline stroke
    // and stems, which expand the [data-note-id] group bbox. ±1 px tolerance.
    expect(Math.round(noteBox.x - laneBox.x)).toBeGreaterThanOrEqual(19);
    expect(Math.round(noteBox.x - laneBox.x)).toBeLessThanOrEqual(21);
    expect(Math.abs(noteBox.width - 80)).toBeLessThanOrEqual(1);

    // Inspector reflects the drawn pitch (C5 in C ionian).
    await page.locator('[data-role="note-body"]').first().click();
    await expect(page.getByTestId('note-inspector')).toBeVisible();
    await expect(page.getByTestId('inspector-note-name')).toHaveText('C5');

    // -- Add a chord via empty-range click + suggestion card --------------
    await clickLane(page, 'chord-lane', { x: 80, y: 28 });
    await applyFirstSuggestion(page);
    const chord = page.locator('[data-chord-id]');
    await expect(chord).toHaveCount(1);
    const symbolBeforePicker = (await chord.first().textContent()) ?? '';

    // -- ChordPicker apply on the existing chord --------------------------
    await chord.first().dblclick();
    const pickerRoot = page.getByTestId('picker-root');
    await expect(pickerRoot).toBeVisible();
    await pickerRoot.getByRole('button', { name: 'D', exact: true }).click();
    await page.getByTestId('picker-apply').click();
    await expect(page.getByTestId('chord-picker')).toHaveCount(0);
    await expect(chord.first()).not.toHaveText(symbolBeforePicker);

    // -- Suggestion card applies to a second range ------------------------
    await clickLane(page, 'chord-lane', { x: 260, y: 28 });
    await applyFirstSuggestion(page);
    await expect(chord).toHaveCount(2);

    // -- Export MIDI triggers a real download -----------------------------
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспортировать MIDI' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.mid$/);
    const bytes = readFileSync(await download.path());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('MThd');

    // §3.19 DoD: separate melody and harmony tracks. Walk the real chunks.
    const { ntrks, tracks } = parseMidiTracks(bytes);
    expect(ntrks).toBeGreaterThanOrEqual(2);
    expect(tracks.length).toBeGreaterThanOrEqual(2);

    const melody = tracks.find((track) => track.name === 'Melody');
    const harmony = tracks.find((track) => track.name === 'Harmony');
    expect(melody).toBeDefined();
    expect(harmony).toBeDefined();

    // The drawn C5 (midi 72) is the only melody note; harmony carries the
    // chord voicings, so the track contents must genuinely differ.
    expect(melody!.pitches.length).toBeGreaterThan(0);
    expect(harmony!.pitches.length).toBeGreaterThan(0);
    expect(melody!.pitches).toEqual([72]);

    // Channels: Melody on channel 1 (0-based 0), Harmony on channel 2 (1).
    for (const channel of melody!.noteOnChannels) {
      expect(channel).toBe(0);
    }
    for (const channel of harmony!.noteOnChannels) {
      expect(channel).toBe(1);
    }

    // -- Undo removes the last action (the second chord) ------------------
    await page.keyboard.press(`${UNDO_MOD}+z`);
    await expect(chord).toHaveCount(1);
    await expect(note).toHaveCount(1);

    // Wait out the debounce deterministically: the undo must flip the status
    // to dirty first — otherwise a stale «Сохранено» from the previous save
    // lets the reload race ahead of the pending write.
    await expect(page.getByTestId('save-status')).toHaveText('Есть изменения');
    await expect(page.getByTestId('save-status')).toHaveText('Сохранено', { timeout: 10_000 });
    await page.reload();
    await expect(page.locator('[data-note-id]')).toHaveCount(1);
    await expect(page.locator('[data-chord-id]')).toHaveCount(1);
  });
});
