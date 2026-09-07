// @vitest-environment jsdom
/**
 * Project library: rows are rendered sorted by updatedAt descending
 * (repository.list contract, §3.18).
 */

import 'fake-indexeddb/auto';

import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';

import { makeStore } from '../../src/app/store';
import { setDependenciesForTesting, type AppDependencies } from '../../src/app/dependencies';
import { ProjectTransport } from '../../src/audio/projectTransport';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import { ProjectListPage } from '../../src/features/projects/ProjectListPage';
import {
  CorruptProjectError,
  makeRepository,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../src/persistence/ProjectRepository';
import { createProjectDocument } from '../../src/domain/model/project';
import { db } from '../../src/persistence/db';

function seedRow(id: string, title: string, updatedAt: string) {
  return {
    id,
    title,
    updatedAt,
    schemaVersion: 1,
    payload: { schemaVersion: 1 },
  };
}

/** One semantic fake dependency: the real façade over the injected repository. */
function fakeDependencies(repository: ProjectRepository): AppDependencies {
  return {
    projects: createProjectPersistence({ repository }),
    transport: new ProjectTransport(),
    downloadBackup() {},
    downloadMidi: async () => ({ ok: true, filename: 'stub.mid' }),
  };
}

describe('ProjectListPage', () => {
  beforeEach(async () => {
    await db.table('projects').clear();
    await db.table('settings').clear();
  });

  afterEach(() => {
    setDependenciesForTesting(null);
  });

  it('renders rows sorted by updatedAt descending', async () => {
    await db.table('projects').bulkPut([
      seedRow('a', 'Старый', '2024-01-01T00:00:00.000Z'),
      seedRow('b', 'Свежий', '2024-03-01T00:00:00.000Z'),
      seedRow('c', 'Средний', '2024-02-01T00:00:00.000Z'),
    ]);

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(3);
    });

    const titles = screen
      .getAllByTestId('project-row-title')
      .map((element) => element.textContent);
    expect(titles).toEqual(['Свежий', 'Средний', 'Старый']);
  });

  // PLP-META: the row subtitle derives from the stored payload via the
  // repository (§3.18 list path); rows without meta keep title + date only.
  it('renders the musical meta line on rows and omits it when the payload is unreadable', async () => {
    await db.table('projects').bulkPut([
      seedRow('a', 'С мета', '2024-01-01T00:00:00.000Z'),
      {
        // Empty score: zero counts drop out of the subtitle entirely.
        ...seedRow('c', 'Пустой', '2024-01-03T00:00:00.000Z'),
        payload: {
          schemaVersion: 1,
          timing: { bars: 4 },
          harmonyContext: { tonic: { letter: 'D', accidental: 1 }, mode: 'aeolian' },
          melody: { notes: [] },
          harmony: { chords: [] },
        },
      },
      {
        ...seedRow('b', 'Без меты', '2024-01-02T00:00:00.000Z'),
        payload: {
          schemaVersion: 1,
          timing: { bars: 8 },
          harmonyContext: { tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' },
          melody: { notes: [{ id: 'n1' }, { id: 'n2' }] },
          harmony: { chords: [{ id: 'c1' }] },
        },
      },
      {
        // Plural edges: 11 takes the MANY form despite mod10===1 (mod100
        // exception); counts ≥5 take the many forms «аккордов»/«нот».
        ...seedRow('d', 'Множественные', '2024-01-04T00:00:00.000Z'),
        payload: {
          schemaVersion: 1,
          timing: { bars: 11 },
          harmonyContext: { tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' },
          melody: { notes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })) },
          harmony: { chords: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })) },
        },
      },
      {
        // Mixed zero: chords present, notes empty — each count drops out INDEPENDENTLY.
        ...seedRow('e', 'Полупустой', '2024-01-05T00:00:00.000Z'),
        payload: {
          schemaVersion: 1,
          timing: { bars: 6 },
          harmonyContext: { tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' },
          melody: { notes: [] },
          harmony: { chords: [{ id: 'c1' }] },
        },
      },
      {
        // bars=0 passes the summarizePayload guard (number+finite) and NEVER drops out:
        // «0 тактов» stays while the zero-chord count vanishes.
        ...seedRow('f', 'Нулевой', '2024-01-06T00:00:00.000Z'),
        payload: {
          schemaVersion: 1,
          timing: { bars: 0 },
          harmonyContext: { tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' },
          melody: { notes: [{ id: 'n1' }, { id: 'n2' }] },
          harmony: { chords: [] },
        },
      },
    ]);

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(6);
    });

    const subtitles = screen.getAllByTestId('project-row-subtitle').map((el) => el.textContent);
    expect(subtitles).toEqual([
      'C ионийский (мажор) · 0 тактов · 2 ноты',
      'C ионийский (мажор) · 6 тактов · 1 аккорд',
      'C ионийский (мажор) · 11 тактов · 5 аккордов, 12 нот',
      'D# эолийский (минор) · 4 такта',
      'C ионийский (мажор) · 8 тактов · 1 аккорд, 2 ноты',
    ]);
  });

  it('показывает LWW-предупреждение о вкладках как muted help-блок', async () => {
    // The multi-tab warning only makes sense once something exists to overwrite.
    await db.table('projects').bulkPut([seedRow('a', 'Проект', '2024-05-01T00:00:00.000Z')]);

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );

    const note = await screen.findByTestId('lww-note');
    expect(note.className).toContain('help-text');
    expect(note.querySelector('.help-icon')?.textContent).toBe('ℹ');
    expect(note.textContent).toContain('вкладках браузера');
  });

  // PLP-E2: the empty-state block and its onboarding hint (§3.18/§3.20).
  it('renders the empty-state block with its onboarding hint when no projects exist', async () => {
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );

    await screen.findByTestId('empty-state');
    expect(screen.getByText('Пока нет ни одного проекта — создайте первый.')).toBeTruthy();
    expect(
      screen.getByText(
        'Выберите тональность и лад, добавьте аккорды подсказками и наиграйте мелодию.',
      ),
    ).toBeTruthy();

    // No rows for an empty library, and the multi-tab warning stays hidden —
    // there is nothing yet that two tabs could overwrite.
    expect(screen.queryByTestId('project-row-title')).toBeNull();
    expect(screen.queryByTestId('lww-note')).toBeNull();
  });

  it('offers a first-project CTA in the empty state that opens the create dialog', async () => {
    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );

    await screen.findByTestId('empty-state');
    await user.click(screen.getByRole('button', { name: 'Создать первый проект' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('opens a project by clicking its row title', async () => {
    const user = userEvent.setup();
    // A real repository plus a valid document: handleOpen pre-loads before
    // navigating, so the stored payload must pass the load-path schema.
    const repository = makeRepository();
    setDependenciesForTesting(fakeDependencies(repository));
    const doc = createProjectDocument({
      title: 'Открываемый',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    await repository.save(doc);

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProjectListPage />} />
            <Route path="/project/:id" element={<div data-testid="editor-probe" />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await user.click(await screen.findByTestId('project-row-title'));
    expect(await screen.findByTestId('editor-probe')).toBeTruthy();
  });

  it('marks a corrupt record with a badge and offers recovery actions', async () => {
    await db.table('projects').bulkPut([seedRow('bad', 'Битый', '2024-05-01T00:00:00.000Z')]);

    const raw = { schemaVersion: 1, melody: 'not-an-object' };
    const brokenLoad: ProjectRepository = {
      list: async () => [{ id: 'bad', title: 'Битый', updatedAt: '2024-05-01T00:00:00.000Z' }],
      load: async () => {
        throw new CorruptProjectError({ projectId: 'bad', raw, reason: 'schema mismatch' });
      },
      save: async () => undefined,
      delete: async () => undefined,
      duplicate: async () => {
        throw new Error('unreachable');
      },
    };
    setDependenciesForTesting(fakeDependencies(brokenLoad));

    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(1);
    });

    // Pre-load on open surfaces the corruption right in the list.
    await user.click(screen.getByRole('button', { name: 'Открыть' }));

    expect(await screen.findByText('Повреждён')).toBeTruthy();
    const panel = screen.getByRole('alert');
    expect(panel.textContent).toContain('Не удалось открыть проект');
    expect(panel.textContent).toContain('schema mismatch');
    expect(screen.getByRole('button', { name: 'Скачать JSON' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Создать новый' })).toBeTruthy();

    expect(screen.getByRole('button', { name: 'Удалить повреждённый' })).toBeTruthy();
  });

  it('wraps a plain load failure in a Russian toast prefix on open', async () => {
    const failingOpen: ProjectRepository = {
      list: async () => [{ id: 'gone', title: 'Пропал', updatedAt: '2024-05-01T00:00:00.000Z' }],
      load: async () => {
        throw new Error('project gone not found');
      },
      save: async () => undefined,
      delete: async () => undefined,
      duplicate: async () => {
        throw new Error('unreachable');
      },
    };
    setDependenciesForTesting(fakeDependencies(failingOpen));

    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Открыть' }));

    // The raw English repository message stays as diagnostic detail after the
    // Russian prefix.
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain(
      'Не удалось открыть проект: project gone not found',
    );
  });

  it('maps a typed not-found load failure to Russian copy without the English diagnostic', async () => {
    const failingOpen: ProjectRepository = {
      list: async () => [{ id: 'gone', title: 'Пропал', updatedAt: '2024-05-01T00:00:00.000Z' }],
      load: async () => {
        throw new ProjectNotFoundError('gone');
      },
      save: async () => undefined,
      delete: async () => undefined,
      duplicate: async () => {
        throw new Error('unreachable');
      },
    };
    setDependenciesForTesting(fakeDependencies(failingOpen));

    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Открыть' }));

    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('Проект не найден');
    expect(toast.textContent).not.toContain('not found');
  });

  it('maps a typed not-found duplicate failure to Russian copy', async () => {
    const failingDuplicate: ProjectRepository = {
      list: async () => [{ id: 'a', title: 'Проект', updatedAt: '2024-05-01T00:00:00.000Z' }],
      load: async () => {
        throw new Error('unreachable');
      },
      save: async () => undefined,
      delete: async () => undefined,
      duplicate: async () => {
        throw new ProjectNotFoundError('a');
      },
    };
    setDependenciesForTesting(fakeDependencies(failingDuplicate));

    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Копия' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Создать копию' }));

    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('Проект не найден');
    expect(toast.textContent).not.toContain('not found');
  });

  it('wraps a duplicate failure in a Russian toast prefix', async () => {
    const failingDuplicate: ProjectRepository = {
      list: async () => [{ id: 'a', title: 'Проект', updatedAt: '2024-05-01T00:00:00.000Z' }],
      load: async () => {
        throw new Error('unreachable');
      },
      save: async () => undefined,
      delete: async () => undefined,
      duplicate: async () => {
        throw new Error('quota exceeded');
      },
    };
    setDependenciesForTesting(fakeDependencies(failingDuplicate));

    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Копия' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Создать копию' }));

    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('Не удалось создать копию проекта: quota exceeded');
  });

  it('wraps a delete failure in a Russian toast prefix', async () => {
    const failingDelete: ProjectRepository = {
      list: async () => [{ id: 'a', title: 'Проект', updatedAt: '2024-05-01T00:00:00.000Z' }],
      load: async () => {
        throw new Error('unreachable');
      },
      save: async () => undefined,
      delete: async () => {
        throw new Error('indexeddb readonly');
      },
      duplicate: async () => {
        throw new Error('unreachable');
      },
    };
    setDependenciesForTesting(fakeDependencies(failingDelete));

    const user = userEvent.setup();
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <ProjectListPage />
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('project-row-title')).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Удалить' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить' }));

    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('Не удалось удалить проект: indexeddb readonly');
  });

  // Bug: the row `<li onClick>` wraps the title button AND the «Открыть»
  // button, each with its own `handleOpen` onClick — every click bubbled to
  // the row and dispatched the open use case twice (two IndexedDB loads).
  // The inner buttons no longer carry their own onClick; one click = one load.
  it('opens a project exactly once per title click (no double dispatch)', async () => {
    const user = userEvent.setup();
    const repository = makeRepository();
    const doc = createProjectDocument({
      title: 'Одно открытие',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    await repository.save(doc);

    let loads = 0;
    const countingRepository: ProjectRepository = {
      list: () => repository.list(),
      load: (id: string) => {
        loads += 1;
        return repository.load(id);
      },
      save: (project) => repository.save(project),
      delete: (id) => repository.delete(id),
      duplicate: (id, newTitle) => repository.duplicate(id, newTitle),
    };
    setDependenciesForTesting(fakeDependencies(countingRepository));

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProjectListPage />} />
            <Route path="/project/:id" element={<div data-testid="editor-probe" />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await user.click(await screen.findByTestId('project-row-title'));
    expect(await screen.findByTestId('editor-probe')).toBeTruthy();
    expect(loads).toBe(1);
  });

  it('opens a project exactly once via the «Открыть» action button', async () => {
    const user = userEvent.setup();
    const repository = makeRepository();
    const doc = createProjectDocument({
      title: 'Кнопочное открытие',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    await repository.save(doc);

    let loads = 0;
    const countingRepository: ProjectRepository = {
      list: () => repository.list(),
      load: (id: string) => {
        loads += 1;
        return repository.load(id);
      },
      save: (project) => repository.save(project),
      delete: (id) => repository.delete(id),
      duplicate: (id, newTitle) => repository.duplicate(id, newTitle),
    };
    setDependenciesForTesting(fakeDependencies(countingRepository));

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProjectListPage />} />
            <Route path="/project/:id" element={<div data-testid="editor-probe" />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Открыть' }));
    expect(await screen.findByTestId('editor-probe')).toBeTruthy();
    expect(loads).toBe(1);
  });
});
