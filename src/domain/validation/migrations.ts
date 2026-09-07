/**
 * Document schema migrations (V1 is the first version, so none exist yet).
 */

import { validateProjectDocument } from './projectSchema';

export type Migration = {
  from: number;
  to: number;
  migrate: (raw: unknown) => unknown;
};

/** Sequential chain; each step upgrades exactly one schemaVersion. */
export const MIGRATIONS: readonly Migration[] = [];

export type MigrateResult =
  | { ok: true; document: unknown }
  | { ok: false; error: string };

/**
 * Applies migrations in order (ascending `from`), then validates the result.
 * For a V1 document this reduces to plain validation.
 */
export function migrateDocument(raw: unknown): MigrateResult {
  let current = raw;

  let version = readSchemaVersion(current);
  for (const migration of MIGRATIONS) {
    if (migration.from !== version) {
      return {
        ok: false,
        error: `unexpected document schemaVersion ${version}; migration expects ${migration.from}`,
      };
    }
    current = migration.migrate(current);
    version = migration.to;
    if (version !== readSchemaVersion(current)) {
      return {
        ok: false,
        error: `migration ${migration.from}->${migration.to} produced invalid schemaVersion`,
      };
    }
  }

  const validated = validateProjectDocument(current);
  return validated.ok
    ? { ok: true, document: validated.document }
    : { ok: false, error: validated.error };
}

function readSchemaVersion(raw: unknown): number | null {
  if (typeof raw === 'object' && raw !== null && 'schemaVersion' in raw) {
    const version = raw.schemaVersion;
    if (typeof version === 'number') return version;
  }
  return null;
}
