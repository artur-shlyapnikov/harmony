// @vitest-environment jsdom
/**
 * ConfirmDialogProvider promise contract: a pending prompt settles on
 * Confirm/Cancel, and resolves `false` when the provider unmounts so an
 * awaiting caller never hangs.
 */

import { useEffect, useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConfirmDialogProvider, useConfirm } from '../../src/shared/ConfirmDialog';

function Harness({ onResult }: { onResult: (confirmed: boolean) => void }) {
  const confirm = useConfirm();
  // Mount-only prompt: identity-stable guard keeps exactly one dialog per
  // mount even though confirm/onResult are fresh objects each render.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    void confirm({ title: 'Вопрос', message: 'Точно?' }).then(onResult);
  }, [confirm, onResult]);
  return null;
}

describe('ConfirmDialogProvider', () => {
  it('resolves the pending promise with false when the provider unmounts', async () => {
    const results: boolean[] = [];
    const { unmount } = render(
      <ConfirmDialogProvider>
        <Harness onResult={(confirmed) => results.push(confirmed)} />
      </ConfirmDialogProvider>,
    );

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(results).toEqual([]);

    unmount();

    await waitFor(() => {
      expect(results).toEqual([false]);
    });
  });

  it('still resolves normally on Confirm and Cancel', async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    const { unmount: unmountFirst } = render(
      <ConfirmDialogProvider>
        <Harness onResult={(confirmed) => results.push(confirmed)} />
      </ConfirmDialogProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => {
      expect(results).toEqual([true]);
    });
    unmountFirst();

    const { unmount: unmountSecond } = render(
      <ConfirmDialogProvider>
        <Harness onResult={(confirmed) => results.push(confirmed)} />
      </ConfirmDialogProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Отмена' }));
    await waitFor(() => {
      expect(results).toEqual([true, false]);
    });
    unmountSecond();
  });
});
