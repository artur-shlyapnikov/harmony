// @vitest-environment jsdom
/**
 * App shell routing smoke: the project library renders at the root route and
 * an unknown project route shows the not-found state (§3.18 load flow).
 */

import 'fake-indexeddb/auto';

import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeStore, store } from '../../src/app/store';
import { App } from '../../src/app/App';
import { setDependenciesForTesting, type AppDependencies } from '../../src/app/dependencies';
import { ProjectTransport } from '../../src/audio/projectTransport';
import { createProjectPersistence } from '../../src/persistence/projectPersistence';
import {
  CorruptProjectError,
  UnsupportedSchemaError,
  type ProjectRepository,
} from '../../src/persistence/ProjectRepository';
import { db } from '../../src/persistence/db';
import { createProjectDocument, type ProjectDocumentV1 } from '../../src/domain/model/project';
import { CHORD_GRID, NOTE_GRID } from '../../src/domain/timeline/constants';
import { addChordRangeCmd, addNoteCmd, openProjectCmd } from '../../src/state/commands';
import { CLASSIFICATION_TITLE } from '../../src/features/editor/NoteBlock';
import { parseSpelled } from '../../src/domain/model/pitch';

const C = parseSpelled('C')!;

function renderApp(initialEntries: string[]) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </Provider>,
  );
}

describe('App shell', () => {
  it('renders the project library at the root route', async () => {
    renderApp(['/']);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Проекты');
    // The library finishes its (empty) load without crashing.
    await screen.findByText('Пока нет ни одного проекта — создайте первый.');
  });

  it('shows the not-found state for a missing project route', async () => {
    renderApp(['/project/does-not-exist']);

    await screen.findByText('Проект не открыт');
  });
});

// EDT-K1: the corrupt branch of the §3.18 load flow needs injected
// dependencies and a clean store, so this block uses a local makeStore()
// variant of the harness above instead of the module singleton (one-line
// sanctioned deviation; see local://test-design-4.md §4.2) plus the
// fakeDependencies + setDependenciesForTesting(null) idiom from
// tests/shell/ProjectListPage.test.tsx.

function corruptRepository(deletedIds: string[]): ProjectRepository {
  return {
    list: async () => [],
    load: async () => {
      throw new CorruptProjectError({
        projectId: 'bad',
        raw: { schemaVersion: 1 },
        reason: 'unit-test corruption',
      });
    },
    save: async () => {},
    delete: async (id) => {
      deletedIds.push(id);
    },
    duplicate: async () => {
      throw new Error('not used in this test');
    },
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

// IDLE-*: the idle-strip cases need to dispatch commands mid-test against the
// same store the editor route renders, so the harness accepts a pre-built
// store (same single-harness rule as the corrupt-recovery block below).
function renderAppWithFreshStore(initialEntries: string[], store = makeStore()) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </Provider>,
  );
}

describe('App shell /project/:id corrupt recovery', () => {
  let deletedIds: string[];

  beforeEach(async () => {
    await db.table('projects').clear();
    await db.table('settings').clear();
    deletedIds = [];
  });

  afterEach(() => {
    setDependenciesForTesting(null);
  });

  it('a corrupt project renders the recovery panel with its three actions, and confirmed delete returns to the library', async () => {
    const user = userEvent.setup();
    setDependenciesForTesting(fakeDependencies(corruptRepository(deletedIds)));
    renderAppWithFreshStore(['/project/bad']);

    // The corrupt branch maps ANY CorruptProjectError to the fixed Russian
    // reason; the raw error detail must stay out of the sentence.
    await screen.findByRole('heading', { name: 'Проект повреждён' });
    const main = screen.getByRole('alert');
    expect(main.textContent).toContain(
      'Не удалось открыть проект: структура проекта не соответствует ожидаемой.',
    );
    expect(main.textContent).not.toContain('unit-test corruption');

    expect(screen.getByRole('button', { name: 'Скачать JSON' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Создать новый' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Удалить повреждённый проект' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Удалить повреждённый проект' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Удаление повреждённого проекта',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    // Back at the library, and the corrupt record was actually deleted.
    await screen.findByRole('heading', { name: 'Проекты' });
    expect(deletedIds).toEqual(['bad']);
  });

  it('«Создать новый» on the corrupt panel returns to the library with the new-project dialog open', async () => {
    const user = userEvent.setup();
    setDependenciesForTesting(fakeDependencies(corruptRepository([])));
    renderAppWithFreshStore(['/project/bad']);
    await screen.findByRole('heading', { name: 'Проект повреждён' });

    await user.click(screen.getByRole('button', { name: 'Создать новый' }));

    // «Создать новый» navigates to `/` with state.newProject === true, so the
    // library mounts with the NewProjectDialog already open.
    await screen.findByRole('heading', { name: 'Проекты' });
    expect(await screen.findByRole('dialog', { name: 'Новый проект' })).toBeTruthy();
  });

  function unsupportedSchemaRepository(): ProjectRepository {
    return {
      ...corruptRepository([]),
      load: async () => {
        // Constructor shape per DexieProjectRepository: (projectId, schemaVersion, raw).
        throw new UnsupportedSchemaError('future', 99, { schemaVersion: 99 });
      },
    };
  }

  // SHELL-C2: EditorPage maps BOTH CorruptProjectError and
  // UnsupportedSchemaError to the same fixed Russian reason (raw pulled from
  // different fields), so a future schemaVersion must land on the identical
  // recovery panel — not the generic error state.
  it('an unsupported future schema renders the same recovery panel with the fixed Russian reason', async () => {
    setDependenciesForTesting(fakeDependencies(unsupportedSchemaRepository()));
    renderAppWithFreshStore(['/project/future']);

    await screen.findByRole('heading', { name: 'Проект повреждён' });
    const main = screen.getByRole('alert');
    expect(main.textContent).toContain(
      'Не удалось открыть проект: структура проекта не соответствует ожидаемой.',
    );
    expect(main.textContent).not.toContain('schemaVersion 99');
    expect(screen.getByRole('button', { name: 'Удалить повреждённый проект' })).toBeTruthy();
  });
});

// Round 6 (IDLE-L1/IDLE-O2, §3.C of local://test-design-6.md): IdleStrip
// delta surface, driven through the REAL editor-route load seam — an empty
// factory document comes back from the injected repository, exactly like a
// user opening an untouched project.
describe('editor idle strip', () => {
  // The ready editor branch mounts TimelineViewport, whose layout observer
  // needs the same jsdom stub used by tests/lanes/timelineViewport.test.tsx.
  beforeEach(async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverStub {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    await db.table('projects').clear();
    await db.table('settings').clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setDependenciesForTesting(null);
  });


  function renderIdleEditor() {
    const document: ProjectDocumentV1 = createProjectDocument({
      title: 'Idle strip',
      tonic: { letter: 'C', accidental: 0 },
      mode: 'ionian',
    });
    const repository: ProjectRepository = {
      list: async () => [],
      load: async () => document,
      save: async () => {},
      delete: async () => {},
      duplicate: async () => {
        throw new Error('not used in this test');
      },
    };
    setDependenciesForTesting(fakeDependencies(repository));
    const store = makeStore();
    renderAppWithFreshStore(['/project/idle-strip'], store);
    return store;
  }

  it('shows the classification legend with its five entries in consonant→dissonant→outside order whenever no selection is active', async () => {
    renderIdleEditor();

    // The load is asynchronous; the legend's appearance doubles as the
    // ready signal for the editor route.
    const legend = await screen.findByRole('list', { name: 'Цветовая разметка нот' });

    // Titles come verbatim from CLASSIFICATION_TITLE (NoteBlock.tsx) — the
    // test pins the ORDER and presence, never retypes the copy.
    const items = within(legend).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      CLASSIFICATION_TITLE.chordTone,
      CLASSIFICATION_TITLE.availableTension,
      CLASSIFICATION_TITLE.scaleTone,
      CLASSIFICATION_TITLE.chromatic,
      CLASSIFICATION_TITLE.unscored,
    ]);
    for (const item of items) {
      expect(item.querySelector('.legend-swatch')).toBeTruthy();
    }

    expect(
      screen.getByText(
        'Выберите ноту или аккорд на дорожке, либо диапазон на «Гармонии» — для подсказок.',
      ),
    ).toBeTruthy();
  });

  it('shows the three-step onboarding list only while BOTH lanes are empty, hiding it as soon as any note exists while the legend persists', async () => {
    const store = renderIdleEditor();

    const onboarding = await screen.findByRole('list', { name: 'С чего начать' });
    const steps = within(onboarding).getAllByRole('listitem').map((item) => item.textContent);
    expect(steps).toEqual([
      'Инструментом «Нота» нарисуйте мелодию на верхней дорожке',
      'Выделите диапазон на «Гармонии» — появятся подсказки аккордов',
      'Пробел — воспроизведение',
    ]);

    let added = false;
    act(() => {
      added = addNoteCmd({
        startTick: 0,
        durationTicks: NOTE_GRID,
        midi: 72,
        velocity: 80,
      })(store.dispatch, store.getState);
    });
    expect(added).toBe(true);

    // The emptiness gate covers only the onboarding <ol>; the legend is
    // rendered unconditionally and must survive any note existing.
    expect(screen.queryByRole('list', { name: 'С чего начать' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Цветовая разметка нот' })).toBeTruthy();
  });
});

// Round 10 (TOOL-DEFAULT, §3.15): an empty score must open ready-to-draw —
// the onboarding strip's first step names the «Нота» tool, so the generic
// 'select' default left the first lane click dead. A score that already has
// content keeps the neutral select tool.
describe('editor initial tool', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverStub {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    await db.table('projects').clear();
    await db.table('settings').clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setDependenciesForTesting(null);
  });

  function renderEditorWithDocument(document: ProjectDocumentV1) {
    const repository: ProjectRepository = {
      list: async () => [],
      load: async () => document,
      save: async () => {},
      delete: async () => {},
      duplicate: async () => {
        throw new Error('not used in this test');
      },
    };
    setDependenciesForTesting(fakeDependencies(repository));
    renderAppWithFreshStore(['/project/tool-check'], makeStore());
  }

  it('an empty score opens with the Нота tool active', async () => {
    renderEditorWithDocument(
      createProjectDocument({ title: 'Tool check', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' }),
    );

    await screen.findByRole('list', { name: 'Цветовая разметка нот' });

    expect(screen.getByRole('button', { name: 'Нота' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a score that already has content opens with the neutral Выбор tool', async () => {
    const seeded = makeStore();
    seeded.dispatch(
      openProjectCmd(createProjectDocument({ title: 'Seeded', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' })),
    );
    addNoteCmd({ startTick: 0, durationTicks: NOTE_GRID, midi: 72, velocity: 80 })(
      seeded.dispatch,
      seeded.getState,
    );

    renderEditorWithDocument(seeded.getState().projectHistory.present!);

    await screen.findByRole('list', { name: 'Цветовая разметка нот' });
    expect(screen.getByRole('button', { name: 'Выбор' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Нота' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('a harmony-only score opens with the neutral Выбор tool', async () => {
    const seeded = makeStore();
    seeded.dispatch(
      openProjectCmd(createProjectDocument({ title: 'Harmony only', tonic: { letter: 'C', accidental: 0 }, mode: 'ionian' })),
    );
    addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } })(
      seeded.dispatch,
      seeded.getState,
    );

    renderEditorWithDocument(seeded.getState().projectHistory.present!);

    await screen.findByRole('list', { name: 'Цветовая разметка нот' });
    expect(screen.getByRole('button', { name: 'Выбор' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Нота' }).getAttribute('aria-pressed')).toBe('false');
  });
});
