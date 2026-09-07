import { describe, expect, it } from 'vitest';

import { formatModifiedRu } from '../../src/shared/labels';

describe('formatModifiedRu', () => {
  const now = new Date(2026, 7, 25, 12, 0);

  it('formats a same-year timestamp without the year', () => {
    expect(formatModifiedRu(new Date(2026, 7, 25, 8, 38), now)).toBe('25 авг., 08:38');
  });

  it('keeps the year for an older timestamp', () => {
    expect(formatModifiedRu(new Date(2024, 7, 25, 8, 38), now)).toBe('25 авг. 2024 г., 08:38');
  });

  it('accepts epoch-millis timestamps from the repository', () => {
    expect(formatModifiedRu(new Date(2026, 7, 25, 8, 38).getTime(), now)).toBe('25 авг., 08:38');
  });
});
