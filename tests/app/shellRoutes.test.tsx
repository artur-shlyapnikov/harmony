// @vitest-environment jsdom
/**
 * Shell hardening (APP-1/APP-2): unknown URLs fall back to the project
 * library via a wildcard redirect, and the crash screen offers recovery
 */

import 'fake-indexeddb/auto';

import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { store, makeStore } from '../../src/app/store';
import { App } from '../../src/app/App';
import { ErrorBoundary } from '../../src/shared/ErrorBoundary';
import { EditorPage } from '../../src/features/editor/EditorPage';
import {
  setDependenciesForTesting,
  type AppDependencies,
} from '../../src/app/dependencies';
import { ProjectTransport } from '../../src/audio/projectTransport';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import type { ProjectRepository } from '../../src/persistence/ProjectRepository';
import {
  createProjectDocument,
  type ProjectDocumentV1,
} from '../../src/domain/model/project';
import { parseSpelled } from '../../src/domain/model/pitch';
import { NOTE_GRID } from '../../src/domain/timeline/constants';


function Boom(): never {
  throw new Error('kaboom');
}

describe('shell routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // APP-2: unknown paths must land on the project library, not a blank page.
  it('redirects unknown paths to the project list', async () => {
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/nowhere']}>
          <App />
        </MemoryRouter>
      </Provider>,
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Проекты');
    await screen.findByText('Пока нет ни одного проекта — создайте первый.');
  });
});

describe('ErrorBoundary recovery actions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // APP-1: the crash screen must not be a dead end.
  it('offers reload and back-to-projects actions, and the link recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/editor/r64']}>
        <Routes>
          <Route path="/editor/:id" element={<ErrorBoundary><Boom /></ErrorBoundary>} />
          <Route path="/" element={<p data-testid="library">Проекты</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Перезагрузить' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'К списку проектов' }).getAttribute('href')).toBe('/');

    // Navigating away unmounts the crashed subtree; the boundary must
    // reset so the link actually renders the library again.
    await userEvent.setup().click(screen.getByRole('link', { name: 'К списку проектов' }));
    expect(screen.getByTestId('library')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

});
// ---------------------------------------------------------------------------
// TOOL-1: empty-score load arms the note-draw tool (§3.15 onboarding).
// Harness idiom copied from tests/shell/corruptDeleteError.test.tsx:
// real EditorPage on /project/:id over a stubbed DI repository.

// jsdom has no layout engine; TimelineViewport observes its own width.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// ---------------------------------------------------------------------------

const C = parseSpelled('C')!;

function repositoryWith(doc: ProjectDocumentV1): ProjectRepository {
  return {
    list: async () => [],
    load: async () => doc,
    delete: async () => {},
    save: async () => {},
    duplicate: async () => {
      throw new Error('not used in this test');
    },
  };
}

function fakeDependencies(repository: ProjectRepository): AppDependencies {
  return {
    projects: createProjectPersistence({ repository }),
    transport: new ProjectTransport(),
    downloadBackup() {},
    downloadMidi: async () => ({ ok: true, filename: 'stub.mid' }),
  };
}

function renderEditorPage(projectId: string) {
  render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[`/project/${projectId}`]}>
        <Routes>
          <Route path="/project/:id" element={<EditorPage />} />
          <Route path="/" element={<div />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('empty-score load arms the note-draw tool (TOOL-1)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setDependenciesForTesting(null);
    vi.restoreAllMocks();
  });

  it('loading a document with zero notes AND zero chords presses «Нота»', async () => {
    const empty = createProjectDocument({ title: 't', tonic: C, mode: 'ionian' });
    setDependenciesForTesting(fakeDependencies(repositoryWith(empty)));
    renderEditorPage('empty-project');

    const tools = await screen.findByRole('group', { name: 'Инструменты' });
    expect(within(tools).getByTestId('tool-draw-note').getAttribute('aria-pressed')).toBe('true');
    expect(within(tools).getByTestId('tool-select').getAttribute('aria-pressed')).toBe('false');
  });

  it('loading a NON-EMPTY document keeps «Выбор» pressed', async () => {
    const base = createProjectDocument({ title: 't', tonic: C, mode: 'ionian' });
    const nonEmpty: ProjectDocumentV1 = {
      ...base,
      melody: {
        ...base.melody,
        notes: [
          { id: 'seed-note', startTick: 0, durationTicks: NOTE_GRID, midi: 60, velocity: 80 },
        ],
      },
    };
    setDependenciesForTesting(fakeDependencies(repositoryWith(nonEmpty)));
    renderEditorPage('nonempty-project');

    const tools = await screen.findByRole('group', { name: 'Инструменты' });
    expect(within(tools).getByTestId('tool-select').getAttribute('aria-pressed')).toBe('true');
    expect(within(tools).getByTestId('tool-draw-note').getAttribute('aria-pressed')).toBe('false');
  });
});
