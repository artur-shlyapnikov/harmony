// @vitest-environment jsdom
/**
 * NP-1 regression: NewProjectDialog stays mounted for ProjectListPage's
 * lifetime, so its useState values must be restored to clean defaults every
 * time it opens — stale titles/bars/mode/tonic and leftover error banners
 * ('Укажите название проекта', save failures) must not reappear.
 */

import 'fake-indexeddb/auto';

import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeStore } from '../../src/app/store';
import { ProjectListPage } from '../../src/features/projects/ProjectListPage';
import { db } from '../../src/persistence/db';

import {
  setDependenciesForTesting,
  getDependencies,
} from '../../src/app/dependencies';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';

async function renderListPage() {
  render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<ProjectListPage />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
  // Library finished loading.
  await screen.findByText('Пока нет ни одного проекта — создайте первый.');
}

describe('NewProjectDialog state reset on open', () => {
  beforeEach(async () => {
    await db.table('projects').clear();
    await db.table('settings').clear();
  });

  afterEach(() => {
    setDependenciesForTesting(null);
  });

  it('resets fields and clears the error banner when reopened', async () => {
    const user = userEvent.setup();
    await renderListPage();

    // First open: dirty every field and raise the validation error.
    await user.click(screen.getByRole('button', { name: 'Новый проект' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый проект' });
    expect(dialog).toBeTruthy();

    const title = screen.getByLabelText('Название');
    // Whitespace passes the native `required` check but fails trim() validation.
    await user.clear(title);
    await user.type(title, '   ');

    await user.selectOptions(screen.getByLabelText('Тоника'), 'Eb');
    await user.selectOptions(screen.getByLabelText('Лад'), 'dorian');
    await user.selectOptions(screen.getByLabelText('Тоника'), 'Другая…');
    await user.selectOptions(screen.getByLabelText('Буква тоники'), 'D');
    await user.selectOptions(screen.getByLabelText('Альтерация тоники'), '♯ (#)');

    const bars = screen.getByLabelText('Количество тактов');
    await user.clear(bars);
    await user.type(bars, '16');

    await user.click(screen.getByRole('button', { name: 'Создать' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Укажите название проекта',
    );

    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Новый проект' })).toBeNull();
    });
    expect(screen.queryByRole('dialog', { name: 'Новый проект' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Новый проект' }));
    expect(
      await screen.findByRole('dialog', { name: 'Новый проект' }),
    ).toBeTruthy();

    // Clean defaults again, no stale error banner.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Название')).toHaveProperty('value', 'Новый проект');
    expect(screen.getByLabelText('Количество тактов')).toHaveProperty('value', '8');
    expect(screen.getByLabelText('Лад')).toHaveProperty('value', 'ionian');
    expect(screen.getByLabelText('Тоника')).toHaveProperty('value', 'C');
    // The cancelled custom-tonic choice (D ♯) must not leak into the next
    // open: the choice itself resets to C and the hidden custom selects to
    // their defaults (re-select «Другая…» to make them exist again).
    expect(screen.getByLabelText('Тоника')).toHaveProperty('value', 'C');
    await user.selectOptions(screen.getByLabelText('Тоника'), 'Другая…');
    expect(screen.getByLabelText('Буква тоники')).toHaveProperty('value', 'C');
    expect(screen.getByLabelText('Альтерация тоники')).toHaveProperty('value', '0');
  });

  it('does not reset while a save is in flight (busy keeps the dialog stable)', async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | undefined;
    // One semantic dependency: the real façade over a repository whose
    // create() save parks mid-flight until released.
    const projects = createProjectPersistence({
      repository: {
        list: async () => [],
        load: async () => {
          throw new Error('not used in this test');
        },
        save: async () => {
          await new Promise<void>((resolve) => {
            resolveSave = resolve;
          });
        },
        delete: async () => {},
        duplicate: async () => {
          throw new Error('not used in this test');
        },
      },
    });
    setDependenciesForTesting({ ...getDependencies(), projects });

    await renderListPage();
    await user.click(screen.getByRole('button', { name: 'Новый проект' }));
    await screen.findByRole('dialog', { name: 'Новый проект' });

    const title = screen.getByLabelText('Название');
    await user.clear(title);
    await user.type(title, 'В полёте');

    await user.click(screen.getByRole('button', { name: 'Создать' }));
    // Save pending: still open, busy, no error.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Создать' })).toHaveProperty('disabled', true);
    });

    resolveSave?.();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Новый проект' })).toBeNull();
    });
  });
});
