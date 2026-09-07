import Dexie from 'dexie';

/** Row in the `projects` table (§3.18). `payload` holds the raw document JSON-clone. */
export type ProjectRecord = {
  id: string;
  title: string;
  updatedAt: string;
  schemaVersion: number;
  payload: unknown;
};

/** Row in the `settings` table (§3.18). */
export type SettingRecord = {
  key: string;
  value: unknown;
};

/**
 * Singleton application database (§3.18).
 * Name: harmonic-editor, version 1.
 */
export const db: Dexie = new Dexie('harmonic-editor');

db.version(1).stores({
  projects: 'id, updatedAt, title',
  settings: 'key',
});
