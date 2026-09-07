/**
 * @vitest-environment jsdom
 *
 * ChordInspector voicing caption (§3.20): the resolved voicing is labeled
 * with spelled note names in the harmonic context, not raw MIDI numbers.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';

import { makeStore } from '@app/store';
import { createProjectDocument } from '@domain/model/project';
import { parseSpelled } from '@domain/model/pitch';
import { CHORD_GRID } from '@domain/timeline/constants';
import { addChordRangeCmd, openProjectCmd, selectChordCmd } from '@state/commands';
import { selectChords } from '@state/selectors';
import { ChordInspector } from '@features/chords/ChordInspector';

const C = parseSpelled('C')!;

describe('ChordInspector voicing caption', () => {
  it('labels the resolved voicing with note names instead of MIDI numbers', () => {
    const store = makeStore();
    store.dispatch(openProjectCmd(createProjectDocument({ title: 't', tonic: C, mode: 'ionian' })));
    store.dispatch(
      addChordRangeCmd({ startTick: 0, durationTicks: CHORD_GRID, chord: { root: C, templateId: 'maj' } }),
    );
    const id = selectChords(store.getState())[0]?.id as string;
    store.dispatch(selectChordCmd(id));

    render(
      <Provider store={store}>
        <ChordInspector />
      </Provider>,
    );

    const caption = screen.getByText('Голосоведение').parentElement?.textContent ?? '';
    expect(caption).toContain('C4, E4, G4');
    expect(caption).not.toContain('60, 64, 67');
  });
});
