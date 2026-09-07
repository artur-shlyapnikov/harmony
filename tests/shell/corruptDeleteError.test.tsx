// @vitest-environment jsdom
/**
 * PL-1 regression: deleting a CORRUPT project whose repository.delete()
 * rejects (IndexedDB/quota failure) must NOT silently navigate back to the
 * library — the user would lose the recovery panel with zero feedback.
 *
 * Contract: on delete failure the CorruptPanel stays mounted on
 * /project/:id, an error toast explains the failure (same mechanism as
 * ProjectListPage.handleDelete), and the confirm-dialog flow stays intact.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EditorPage } from '../../src/features/editor/EditorPage';
import { makeStore } from '../../src/app/store';
import {
  setDependenciesForTesting,
  type AppDependencies,
} from '../../src/app/dependencies';
import { ProjectTransport } from '../../src/audio/projectTransport';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import {
  CorruptProjectError,
  type ProjectRepository,
} from '../../src/persistence/ProjectRepository';

const PROJECT_ID = 'bad-project';

/** Load always throws corrupt; delete rejects like a quota/IDB failure. */
function corruptRepositoryWithFailingDelete(): ProjectRepository {
  return {
    list: async () => [],
    load: async () => {
      throw new CorruptProjectError({
        projectId: PROJECT_ID,
        raw: { broken: true },
        reason: 'notes is not an array',
      });
    },
    save: async () => {},
    delete: async () => {
      throw new Error('IndexedDB quota exceeded');
    },
    duplicate: async () => {
      throw new Error('not used in this test');
    },
  };
}

// Dependency-injection idiom copied from tests/shell/NewProjectDialog.test.tsx.
// One semantic fake dependency: the real façade over the injected repository.
function fakeDependencies(repository: ProjectRepository): AppDependencies {
  return {
    projects: createProjectPersistence({ repository }),
    transport: new ProjectTransport(),
    downloadBackup() {},
    downloadMidi: async () => ({ ok: true, filename: 'stub.mid' }),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderCorruptPage() {
  render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[`/project/${PROJECT_ID}`]}>
        <Routes>
          <Route path="/project/:id" element={<EditorPage />} />
          <Route path="/" element={<div />} />
        </Routes>
        {/* Probe lives outside Routes so it is mounted on /project/:id too. */}
        <LocationProbe />
      </MemoryRouter>
    </Provider>,
  );
}

describe('corrupt project delete failure', () => {
  afterEach(() => {
    setDependenciesForTesting(null);
  });

  it('shows an error toast and stays on the corrupt panel when delete rejects', async () => {
    const user = userEvent.setup();
    setDependenciesForTesting(fakeDependencies(corruptRepositoryWithFailingDelete()));
    renderCorruptPage();

    // The corrupt recovery panel is up on /project/:id.
    expect(await screen.findByRole('heading', { name: 'Проект повреждён' })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(`/project/${PROJECT_ID}`);

    await user.click(screen.getByRole('button', { name: 'Удалить повреждённый проект' }));

    // Confirm dialog flow intact.
    await screen.findByRole('dialog', { name: 'Удаление повреждённого проекта' });
    await user.click(screen.getByRole('button', { name: 'Удалить' }));

    // Failure surfaces via the session error-toast mechanism…
    expect(await screen.findByText(/Не удалось удалить проект/)).toBeTruthy();
    // …and the user STAYS on the corrupt panel to retry or download JSON first.
    expect(screen.getByTestId('location').textContent).toBe(`/project/${PROJECT_ID}`);
    expect(screen.getByRole('button', { name: 'Скачать JSON' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Проект повреждён' })).toBeTruthy();
  });
});
