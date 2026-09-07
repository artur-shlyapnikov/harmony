// @vitest-environment jsdom
/**
 * Shell integration: creating a project through NewProjectDialog persists the
 * document and navigates to /project/:id (§3.18).
 */

import 'fake-indexeddb/auto';

import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeStore } from '../../src/app/store';
import { ProjectListPage } from '../../src/features/projects/ProjectListPage';
import { db, type ProjectRecord } from '../../src/persistence/db';
import { createProjectDocument } from '@domain/model/project';

import {
  setDependenciesForTesting,
  type AppDependencies,
} from '../../src/app/dependencies';
import { ProjectTransport } from '../../src/audio/projectTransport';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import {
  DexieProjectRepository,
  type ProjectRepository,
} from '../../src/persistence/ProjectRepository';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe('NewProjectDialog', () => {
  beforeEach(async () => {
    await db.table('projects').clear();
    await db.table('settings').clear();
  });

  afterEach(() => {
    setDependenciesForTesting(null);
  });
  it('creates, saves and navigates to the new project', async () => {
    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProjectListPage />} />
            <Route path="/project/:id" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    // Empty library finished loading.
    await screen.findByText('Пока нет ни одного проекта — создайте первый.');

    await user.click(screen.getByRole('button', { name: 'Новый проект' }));

    const dialog = await screen.findByRole('dialog', { name: 'Новый проект' });
    expect(dialog).toBeTruthy();

    const title = screen.getByLabelText('Название');
    await user.clear(title);
    await user.type(title, 'Соната');

    await user.selectOptions(screen.getByLabelText('Тоника'), 'Eb');
    await user.selectOptions(screen.getByLabelText('Лад'), 'dorian');

    const bars = screen.getByLabelText('Количество тактов');
    await user.clear(bars);
    await user.type(bars, '16');

    await user.click(screen.getByRole('button', { name: 'Создать' }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toMatch(/^\/project\//);
    });

    const path = screen.getByTestId('location').textContent ?? '';
    const projectId = path.slice('/project/'.length);

    const record = await db.table<ProjectRecord>('projects').get(projectId);
    expect(record).toBeTruthy();
    expect(record?.title).toBe('Соната');
    const payload = record?.payload as { harmonyContext?: { mode?: string } };
    expect(payload.harmonyContext?.mode).toBe('dorian');
  });

  it('the empty-state CTA opens the new-project dialog', async () => {
    const user = userEvent.setup();
    renderHarness();

    await screen.findByText('Пока нет ни одного проекта — создайте первый.');
    await user.click(screen.getByRole('button', { name: 'Создать первый проект' }));

    expect(await screen.findByRole('dialog', { name: 'Новый проект' })).toBeTruthy();
  });

  it('a row title is a real button that opens exactly that project', async () => {
    const user = userEvent.setup();
    // handleOpen pre-loads before navigating, so the repository is injected
    // with rows whose load succeeds (the fakeDependencies idiom of this
    // file); a minimal seeded record would trip the corrupt-row guard and
    // open the recovery panel instead of navigating.
    const rowsRepository: ProjectRepository = {
      ...repositoryWithSave(async () => undefined),
      list: async () => [
        { id: 'old', title: 'Старый', updatedAt: '2024-01-01T00:00:00.000Z' },
        { id: 'new', title: 'Свежий', updatedAt: '2024-03-01T00:00:00.000Z' },
      ],
      load: async () =>
        createProjectDocument({
          title: 'Старый',
          tonic: { letter: 'C', accidental: 0 },
          mode: 'ionian',
        }),
    };
    setDependenciesForTesting(fakeDependencies(rowsRepository));
    renderHarness();

    await screen.findAllByTestId('project-row-title');
    const titleButton = screen.getByRole('button', { name: 'Старый' });
    await user.click(titleButton);

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/project/old');
    });
  });

  // NPD-V2/NPD-F3 dependency-injection idiom, copied verbatim in spirit from
  // tests/shell/ProjectListPage.test.tsx (fakeDependencies +
  // setDependenciesForTesting(null) cleanup above).
  // One semantic fake dependency: the real façade over the injected repository.
  function fakeDependencies(repository: ProjectRepository): AppDependencies {
    return {
      projects: createProjectPersistence({ repository }),
      transport: new ProjectTransport(),
      downloadBackup() {},
      downloadMidi: async () => ({ ok: true, filename: 'stub.mid' }),
    };
  }

  function repositoryWithSave(save: ProjectRepository['save']): ProjectRepository {
    return {
      list: async () => [],
      load: async () => {
        throw new Error('not used in this test');
      },
      save,
      delete: async () => {},
      duplicate: async () => {
        throw new Error('not used in this test');
      },
    };
  }

  function renderHarness() {
    return render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProjectListPage />} />
            <Route path="/project/:id" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
  }


  async function openDialog(user: UserEvent) {
    await screen.findByText('Пока нет ни одного проекта — создайте первый.');
    await user.click(screen.getByRole('button', { name: 'Новый проект' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый проект' });
    expect(dialog).toBeTruthy();
  }
  it('rejects a whitespace-only title and out-of-range bars with the verbatim errors, persisting nothing and never navigating', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openDialog(user);

    // Cell 1: whitespace-only title (empty after trim). NOTE: the input
    // carries native `required`, so a truly EMPTY value is intercepted by
    // jsdom constraint validation before the dialog's own guard runs;
    // whitespace exercises the trim guard itself.
    const title = screen.getByLabelText('Название');
    await user.clear(title);
    await user.type(title, '   ');
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    expect(screen.getByText('Укажите название проекта')).toBeTruthy();
    // Still on the library route (the probe only mounts on /project/:id).
    expect(screen.queryByTestId('location')).toBeNull();

    // Cell 2: valid title, bars below the MIN_BARS bound. NOTE: the bars
    // input carries native min/max constraints, so jsdom intercepts a
    // button-click submit for ANY out-of-range value before the dialog's
    // own guard runs; firing the submit event directly exercises the
    // component's own bounds guard at its handler seam.
    await user.clear(title);
    await user.type(title, 'Соната');
    const bars = screen.getByLabelText('Количество тактов');
    await user.clear(bars);
    await user.type(bars, '0');
    fireEvent.submit(screen.getByRole('dialog', { name: 'Новый проект' }));
    expect(screen.getByText('Количество тактов — от 1 до 128')).toBeTruthy();
    expect(screen.queryByTestId('location')).toBeNull();
    // Neither rejected submit persisted anything.
    expect(await db.table('projects').count()).toBe(0);
  });

  it('a failing save surfaces the Russian error inside the dialog, resets busy, and a retry against a working repository navigates', async () => {
    const user = userEvent.setup();
    setDependenciesForTesting(
      fakeDependencies(
        repositoryWithSave(async () => {
          throw new Error('disk full');
        }),
      ),
    );
    renderHarness();
    await openDialog(user);

    const title = screen.getByLabelText('Название');
    await user.clear(title);
    await user.type(title, 'Соната');
    await user.click(screen.getByRole('button', { name: 'Создать' }));

    // The failure surfaces inside the still-open dialog; no navigation
    // (the probe only mounts on /project/:id, so its absence proves we
    // never left the library route).
    expect(await screen.findByText('Не удалось сохранить проект: disk full')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Новый проект' })).toBeTruthy();
    expect(screen.queryByTestId('location')).toBeNull();

    // Busy was reset on failure: retrying against a healthy repository
    // goes through end-to-end.
    setDependenciesForTesting(fakeDependencies(new DexieProjectRepository()));
    await user.click(screen.getByRole('button', { name: 'Создать' }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toMatch(/^\/project\//);
    });
    const path = screen.getByTestId('location').textContent ?? '';
    const projectId = path.slice('/project/'.length);
    const record = await db.table<ProjectRecord>('projects').get(projectId);
    expect(record).toBeTruthy();
    expect(record?.title).toBe('Соната');
  });

  it('Escape and an overlay click dismiss the idle dialog without saving', async () => {
    const user = userEvent.setup();
    setDependenciesForTesting(
      fakeDependencies(
        repositoryWithSave(async () => {
          throw new Error('save must not run');
        }),
      ),
    );
    renderHarness();
    await openDialog(user);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Новый проект' })).toBeNull();

    // Re-open and dismiss via the overlay; the form inside must not
    // swallow the click.
    await user.click(screen.getByRole('button', { name: 'Новый проект' }));
    await screen.findByRole('dialog', { name: 'Новый проект' });
    fireEvent.click(screen.getByRole('presentation'));
    expect(screen.queryByRole('dialog', { name: 'Новый проект' })).toBeNull();
    expect(await db.table('projects').count()).toBe(0);
    expect(screen.queryByTestId('location')).toBeNull();
  });

  it('Escape and the overlay are inert while a save is in flight; the save still navigates', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDependenciesForTesting(fakeDependencies(repositoryWithSave(() => gate)));
    renderHarness();
    await openDialog(user);

    const title = screen.getByLabelText('Название');
    await user.clear(title);
    await user.type(title, 'Соната');
    await user.click(screen.getByRole('button', { name: 'Создать' }));

    // Save in flight: dismissal surfaces do nothing.
    await user.keyboard('{Escape}');
    fireEvent.click(screen.getByRole('presentation'));
    expect(screen.getByRole('dialog', { name: 'Новый проект' })).toBeTruthy();
    expect(screen.queryByTestId('location')).toBeNull();

    release();
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toMatch(/^\/project\//);
    });
  });

  // Regression: the document-level Escape listener used to be REMOVED while
  // `busy`, so an Escape during save fell through to the window-level
  // editor shortcuts (clearing the selection behind the modal). The listener
  // must stay mounted and swallow Escape without closing.
  it('keeps the Escape listener mounted while busy: no close and no window leak', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDependenciesForTesting(fakeDependencies(repositoryWithSave(() => gate)));
    renderHarness();
    await openDialog(user);

    const title = screen.getByLabelText('Название');
    await user.clear(title);
    await user.type(title, 'Соната');
    await user.click(screen.getByRole('button', { name: 'Создать' }));

    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', windowEscape);
    }

    expect(screen.getByRole('dialog', { name: 'Новый проект' })).toBeTruthy();
    expect(windowEscape).not.toHaveBeenCalled();
    expect(screen.queryByTestId('location')).toBeNull();

    release();
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toMatch(/^\/project\//);
    });
  });
 });
