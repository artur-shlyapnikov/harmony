/**
 * SuggestionPanel (§3.12 UI, §3.16 apply flow, §3.20 chord lane interplay).
 *
 * Visible only while the session selection is an empty range. Cards are built
 * exclusively from the memoized recommendation selector (`§3.12` engine — no
 * scoring logic lives here): up to four unique category cards
 * («Безопасно» / «Плавно» / «Сильно» / «Колор»; the color card is simply
 * absent when nothing qualifies — never a placeholder). Each card shows the
 * chord symbol, contextual roman numeral and the engine's Russian reason
 * strings; numeric scores stay internal (§3.12).
 *
 * Clicking a card applies the recommendation in one click (§3.22):
 * `addChordRangeCmd` over the selected range, then the selection clears and
 * the panel collapses naturally.
 */

import { useMemo, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import { addChordRangeCmd, clearSelectionCmd } from '@state/commands';
import { createSelectRecommendations, selectSelection } from '@state/selectors';
import { chordSymbol } from '@domain/model/chord';
import type { ChordRecommendation } from '@domain/recommendations/recommendChords';
import { ChordPicker } from '@features/chords/ChordPicker';

const NO_RECOMMENDATIONS: readonly ChordRecommendation[] = Object.freeze([]);

/** Fixed Russian category labels (§3.12 Объяснения/UI). */
const CATEGORY_LABELS: Record<ChordRecommendation['category'], string> = Object.freeze({
  safe: 'Безопасно',
  smooth: 'Плавно',
  strong: 'Сильно',
  color: 'Колор',
});

export function SuggestionPanel({ className }: { className?: string }) {
  const dispatch = useAppDispatch();
  const selection = useAppSelector(selectSelection);
  // One selector instance per mount keeps the engine memoized across renders.
  const selectRecommendations = useMemo(() => createSelectRecommendations(), []);
  // §3.20: from a range selection the full ChordPicker must be reachable
  // (create mode = no chord id); it applies over the same range selection.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Focus anchor for keyboard users: applying a recommendation clears the
  // range selection and unmounts this panel, so focus must land on a
  // persistent element — the harmony lane — never on the detaching panel.
  const panelRef = useRef<HTMLElement | null>(null);

  // Stable targetRange identity: allocating a fresh object per store
  // notification would miss the reselect cache (the parameter is compared by
  // reference) and re-run the whole §3.12 engine on every store update —
  // scroll, autosave status flips, undo/redo — while the panel is open.
  const targetRange = useMemo(
    () =>
      selection?.kind === 'range'
        ? { startTick: selection.startTick, durationTicks: selection.durationTicks }
        : null,
    [selection],
  );

  const recommendations = useAppSelector((state) =>
    targetRange === null ? NO_RECOMMENDATIONS : selectRecommendations(state, targetRange),
  );

  if (selection?.kind !== 'range') return null;

  const focusHarmonyLane = (): void => {
    const lane = document.querySelector<HTMLElement>('[data-testid="chord-lane"]');
    if (lane !== null) {
      lane.focus();
      return;
    }
    panelRef.current?.focus();
  };

  const applyRecommendation = (recommendation: ChordRecommendation): void => {
    const applied = dispatch(
      addChordRangeCmd({
        startTick: selection.startTick,
        durationTicks: selection.durationTicks,
        chord: recommendation.chord,
      }),
    );
    // MAX_CHORD_EVENTS rejection (§3.21): nothing was applied — keep the
    // range selection and the panel so the user can pick another chord.
    if (!applied) return;
    // Focus a persistent node BEFORE clearing: the clear unmounts this
    // panel, so focusing the panel first would drop focus to <body>.
    focusHarmonyLane();
    dispatch(clearSelectionCmd());
  };

  return (
    <section
      ref={panelRef}
      className={className}
      tabIndex={-1}
      aria-label="Предложения гармонии"
      data-testid="suggestion-panel"
    >
      <div className="suggestion-header">
        <strong>Предложения гармонии</strong>
        <span>Нажмите на карточку, чтобы добавить аккорд в выделенный диапазон</span>
      </div>
      <ul className="suggestion-list">
        {recommendations.map((recommendation) => (
          <li
            key={`${CATEGORY_LABELS[recommendation.category]}-${recommendation.romanNumeral}`}
            className="suggestion-card"
          >
            <button
              type="button"
              onClick={() => applyRecommendation(recommendation)}
              aria-label={`${CATEGORY_LABELS[recommendation.category]}: ${chordSymbol(recommendation.chord)} (${recommendation.romanNumeral}) — ${recommendation.reasons.join('; ')}`}
            >
              <span className={`suggestion-card-category suggestion-card-category--${recommendation.category}`}>
                {CATEGORY_LABELS[recommendation.category]}
              </span>
              <span className="suggestion-card-symbol">
                {chordSymbol(recommendation.chord)}
              </span>
              <span className="suggestion-card-roman">{recommendation.romanNumeral}</span>
              {recommendation.reasons.map((reason) => (
                <p key={reason} className="suggestion-card-reason">
                  {reason}
                </p>
              ))}
            </button>
          </li>
        ))}
      </ul>
      {recommendations.length === 0 && <p>Нет предложений для этого контекста</p>}
      <button
        type="button"
        data-testid="open-chord-picker"
        onClick={() => setPickerOpen(true)}
      >
        Добавить аккорд…
      </button>
      <ChordPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        // Same post-apply contract as applyRecommendation above: a successful
        // create-mode apply clears the range selection so the panel collapses
        // (§3.16). The picker itself skips this on a rejected command.
        onApplied={() => {
          // Same post-apply contract as applyRecommendation above.
          focusHarmonyLane();
          dispatch(clearSelectionCmd());
        }}
        editingChordId={null}
        prefillRoot={null}
      />
    </section>
  );
}
