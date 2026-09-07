// @vitest-environment jsdom
/**
 * Storage-error recovery UX (§3.18): when autosave reports an error the editor
 * keeps working in memory and surfaces a persistent alert banner offering a
 * manual JSON backup download.
 */

import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';


// jsdom has no layout engine.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

import {
  getDependencies,
  setDependenciesForTesting,
  type AppDependencies,
} from '../../src/app/dependencies';
import { makeStore } from '../../src/app/store';
import { createProjectDocument, type ProjectDocumentV1 } from '../../src/domain/model/project';
import { describePersistenceError } from '../../src/app/listeners';
import { CorruptProjectError, type ProjectRepository } from '../../src/persistence/ProjectRepository';
import { ProjectTransport } from '../../src/audio/projectTransport';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import { EditorPage } from '../../src/features/editor/EditorPage';

function fakeRepository(doc: ProjectDocumentV1): ProjectRepository {
  return {
    list: async () => [{ id: doc.id, title: doc.title, updatedAt: doc.updatedAt }],
    load: async () => doc,
    save: async () => undefined,
    delete: async () => undefined,
    duplicate: async () => doc,
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

describe('storage error banner (§3.18)', () => {
  afterEach(() => {
    vi.unstubAllGlobals(); // pair the module-level ResizeObserver stub
    setDependenciesForTesting(null);
  });

  it('shows the in-memory warning alert and backup download button', async () => {
    const doc = createProjectDocument({
      title: 'Память',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    setDependenciesForTesting(fakeDependencies(fakeRepository(doc)));

    const store = makeStore();

    // §3.15/§3.18: the failed save belongs to THE opened project, so the error is
    // seeded only after EditorPage finishes loading it (opening resets stale errors).
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/project/${doc.id}`]}>
          <Routes>
            <Route path="/project/:id" element={<EditorPage />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    await screen.findByText('Память');

    store.dispatch({ type: 'session/saveStatusSet', payload: { status: 'error' } });
    store.dispatch({
      type: 'session/persistenceErrorSet',
      payload: { error: 'хранилище переполнено' },
    });

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Проект остаётся в памяти');
    expect(banner.textContent).toContain('хранилище переполнено');
    expect(screen.getByRole('button', { name: 'Скачать резервную копию' })).toBeTruthy();
  });
  it('renders a human-readable Russian reason for a corrupt document', async () => {
    const doc = createProjectDocument({
      title: 'Битый',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    const brokenLoad: ProjectRepository = {
      ...fakeRepository(doc),
      load: async () => {
        throw new CorruptProjectError({
          projectId: doc.id,
          raw: { schemaVersion: 1, melody: 'not-an-object' },
          reason: 'Expected object, received string at melody',
        });
      },
    };
    setDependenciesForTesting(fakeDependencies(brokenLoad));

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={[`/project/${doc.id}`]}>
          <Routes>
            <Route path="/project/:id" element={<EditorPage />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    const panel = await screen.findByRole('alert');
    // The raw English zod dump must not surface mid-Russian-sentence.
    expect(panel.textContent).toContain('структура проекта не соответствует ожидаемой');
    expect(panel.textContent).not.toContain('Expected object');
    // Recovery trio stays available, including raw-JSON download.
    expect(screen.getByRole('button', { name: 'Скачать JSON' })).toBeTruthy();
  });
  it('maps known storage failure classes to Russian copy (§3.18 i18n)', async () => {
    // afterEach's unstubAllGlobals drops the module-level stub; restore it.
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const doc = createProjectDocument({
      title: 'Квота',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    setDependenciesForTesting(
      fakeDependencies({
        ...fakeRepository(doc),
        save: async () => {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        },
      }),
    );

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={[`/project/${doc.id}`]}>
          <Routes>
            <Route path="/project/:id" element={<EditorPage />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    await screen.findByText('Квота');

    // The English browser exception travels the real façade → wiring →
    // store path; the banner must show Russian class copy instead of raw text.
    const { projects } = getDependencies();
    projects.scheduleSave(doc);
    await projects.flushBeforeUnload();

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Ошибка сохранения: хранилище переполнено');
    expect(banner.textContent).not.toContain('quota');
  });
  it('passes unrecognized autosave error messages through verbatim', async () => {
    // afterEach's unstubAllGlobals drops the module-level stub; restore it.
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const doc = createProjectDocument({
      title: 'Свой сбой',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    setDependenciesForTesting(
      fakeDependencies({
        ...fakeRepository(doc),
        save: async () => {
          throw new Error('особый сбой хранилища');
        },
      }),
    );

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={[`/project/${doc.id}`]}>
          <Routes>
            <Route path="/project/:id" element={<EditorPage />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    await screen.findByText('Свой сбой');

    const { projects } = getDependencies();
    projects.scheduleSave(doc);
    await projects.flushBeforeUnload();

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('Ошибка сохранения: особый сбой хранилища');
  });
});
describe('describePersistenceError (§3.18 i18n)', () => {
  it.each([
    ['QuotaExceededError: The quota has been exceeded.', 'хранилище переполнено'],
    ['The quota has been exceeded', 'хранилище переполнено'],
    ['SecurityError: The operation is insecure.', 'хранилище недоступно в частном режиме'],
    ['Private browsing blocks writes', 'хранилище недоступно в частном режиме'],
    ['The database connection is closing', 'хранилище временно недоступно'],
    ['Failed to open IndexedDB', 'хранилище временно недоступно'],
    ['особый сбой хранилища', 'особый сбой хранилища'],
  ])('%s → %s', (raw, expected) => {
    expect(describePersistenceError(raw)).toBe(expected);
  });
});


