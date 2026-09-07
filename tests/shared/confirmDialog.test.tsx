// @vitest-environment jsdom
/**
 * ConfirmDialog dismissal surfaces: Escape (wherever focus sits) and an
 * overlay click cancel the pending promise; only the confirm button
 * resolves true. Mirrors the ChordPicker modal convention (RevUI-3).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConfirmDialogProvider, useConfirm } from '../../src/shared/ConfirmDialog';

function Probe({ onResult }: { onResult: (confirmed: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() =>
        void confirm({
          title: 'Удаление проекта',
          message: 'Удалить проект «Прелюдия»? Действие необратимо.',
          danger: true,
        }).then(onResult)
      }
    >
      Спросить
    </button>
  );
}

function renderProbe(onResult: (confirmed: boolean) => void) {
  return render(
    <ConfirmDialogProvider>
      <Probe onResult={onResult} />
    </ConfirmDialogProvider>,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Спросить' }));
  expect(screen.getByRole('dialog', { name: 'Удаление проекта' })).toBeTruthy();
}

describe('ConfirmDialog', () => {
  it('Escape resolves false and closes the dialog', async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    renderProbe((confirmed) => results.push(confirmed));
    await openDialog(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Удаление проекта' })).toBeNull();
    expect(results).toEqual([false]);
  });

  it('an overlay click cancels, a click inside the dialog does not', async () => {
    const results: boolean[] = [];
    renderProbe((confirmed) => results.push(confirmed));
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    const dialog = screen.getByRole('dialog', { name: 'Удаление проекта' });

    fireEvent.click(dialog);
    expect(results).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Удаление проекта' })).toBeTruthy();

    fireEvent.click(screen.getByRole('presentation'));
    await waitFor(() => expect(results).toEqual([false]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the confirm button resolves true and closes', async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    renderProbe((confirmed) => results.push(confirmed));
    await openDialog(user);

    await user.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(results).toEqual([true]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
