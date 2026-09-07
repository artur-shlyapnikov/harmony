/**
 * describePersistenceError copy rules (§3.18 storage banner): known failure
 * classes map to Russian reasons; the meaningless «Error» prefix from
 * `String(new Error(...))` is stripped; unknown reasons pass through.
 */
import { describe, expect, it } from 'vitest';

import { describePersistenceError } from '@app/listeners';

describe('describePersistenceError', () => {
  it('strips the bare Error prefix but keeps the message', () => {
    expect(describePersistenceError('Error: open patched to fail')).toBe('open patched to fail');
    expect(describePersistenceError('Error open patched to fail')).toBe('open patched to fail');
  });

  it('keeps meaningful exception names', () => {
    expect(describePersistenceError('QuotaExceededError: too big')).toBe('хранилище переполнено');
    expect(describePersistenceError('UnknownError: connection lost')).toBe(
      'хранилище временно недоступно',
    );
  });

  it('maps known classes regardless of the prefix', () => {
    expect(describePersistenceError('Error: quota exceeded')).toBe('хранилище переполнено');
  });

  it('passes plain Russian reasons through untouched', () => {
    expect(describePersistenceError('Не удалось сохранить проект')).toBe(
      'Не удалось сохранить проект',
    );
  });
});
