// @vitest-environment jsdom
/**
 * Crash screen (§3.20 safety net): a rendering failure shows a Russian
 * fallback with the offending error message preserved for diagnostics,
 * plus recovery actions (reload / back to the project list).
 */

import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../../src/shared/ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the Russian crash screen and keeps the error message', () => {
    // React logs the caught error via console.error; silence the noise.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </MemoryRouter>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.querySelector('h1')?.textContent).toBe('Что-то пошло не так');
    expect(alert.querySelector('p')?.textContent).toBe(
      'Не удалось отобразить приложение из-за непредвиденной ошибки.',
    );
    expect(alert.querySelector('pre')?.textContent).toBe('kaboom');
  });
});
