/**
 * ChordPicker (§3.20 ChordPicker): modal flow Root → Family → Template →
 * Preview → Apply. Templates are canonical, so no step can produce an
 * internally contradictory chord spec. Apply replaces the selected chord
 * (setChordSpecCmd) or fills the current range selection (addChordRangeCmd).
 */

import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { useAppDispatch, useAppSelector } from '@app/hooks';
import {
  type Accidental,
  parseSpelled,
  type SpelledPitchClass,
} from '@domain/model/pitch';
import { type ChordSpec, type ChordTemplateId, chordSymbol } from '@domain/model/chord';
import {
  CHORD_FAMILY_GROUPS,
  CHORD_TEMPLATES,
  TEMPLATE_BY_ID,
} from '@domain/theory/chordCatalog';
import { analyzeChordInContext } from '@domain/theory/romanNumerals';
import { modeScaleDegrees } from '@domain/theory/spelling';
import { selectChordTones } from '@domain/voicing/selectChordTones';
import { addChordRangeCmd, setChordSpecCmd } from '@state/commands';
import { selectChords, selectHarmonyContext, selectSelection } from '@state/selectors';
import { useFocusTrap } from '@shared/focusTrap';
import { CHORD_FAMILY_LABELS, type ChordFamily } from '@shared/labels';

/** §3.20: 12 chromatic roots, common mixed spellings; `alt` = enharmonic hint. */
const ROOT_OPTIONS: readonly { value: SpelledPitchClass; alt: string }[] = (
  [
    ['C', ''],
    ['C#', 'Db'],
    ['D', ''],
    ['Eb', 'D#'],
    ['E', 'Fb'],
    ['F', 'E#'],
    ['F#', 'Gb'],
    ['G', ''],
    ['Ab', 'G#'],
    ['A', ''],
    ['Bb', 'A#'],
    ['B', 'Cb'],
  ] as const
).map(([spelling, alt]) => ({ value: parseSpelled(spelling)!, alt }));

/**
 * Arrow-key navigation inside a picker button grid (§3.20 keyboard access):
 * geometry-based (offsetLeft/offsetTop), so it follows CSS-grid reflow at
 * any viewport width. Left/Right move within the visual row (clamped at the
 * row edges); Up/Down jump to the nearest button in the adjacent row;
 * Home/End jump to the first/last button. Moves focus only — Enter/Space
 * still activate, and Tab still walks every button.
 */
function moveGridFocus(container: HTMLElement, key: string): void {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (idx === -1) return;
  const left = buttons.map((b) => b.offsetLeft);
  const top = buttons.map((b) => b.offsetTop);
  const rows = [...new Set(top)].sort((a, b) => a - b);
  const curRow = top[idx]!;
  let target = -1;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const dir = key === 'ArrowRight' ? 1 : -1;
    for (let i = 0; i < buttons.length; i++) {
      if (i === idx || top[i] !== curRow) continue;
      const delta = (left[i]! - left[idx]!) * dir;
      if (delta <= 0) continue;
      if (target === -1 || delta < (left[target]! - left[idx]!) * dir) target = i;
    }
  } else if (key === 'ArrowDown' || key === 'ArrowUp') {
    const rowIdx = rows.indexOf(curRow);
    const nextRowTop = key === 'ArrowDown' ? rows[rowIdx + 1] : rows[rowIdx - 1];
    if (nextRowTop === undefined) return;
    for (let i = 0; i < buttons.length; i++) {
      if (top[i] !== nextRowTop) continue;
      if (
        target === -1 ||
        Math.abs(left[i]! - left[idx]!) < Math.abs(left[target]! - left[idx]!)
      ) {
        target = i;
      }
    }
  } else if (key === 'Home') {
    target = 0;
  } else if (key === 'End') {
    target = buttons.length - 1;
  } else {
    return;
  }
  if (target !== -1) buttons[target]!.focus();
}

/** Shared keydown adapter for the picker's button grids. */
function handleGridKeys(event: ReactKeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  moveGridFocus(event.currentTarget, event.key);
}

/** Formula preview for a template: degree labels of its tones ("1–3–5–7"). */
export function templateFormulaPreview(templateId: ChordTemplateId): string {
  return TEMPLATE_BY_ID[templateId].tones.map((tone) => `${tone.degree}`).join('–');
}

/** Mini piano over two octaves (C3..B4); highlights pitch classes and/or exact MIDI notes. */
export function MiniPiano({
  highlightPcs = [],
  highlightMidis = [],
}: {
  highlightPcs?: readonly number[];
  highlightMidis?: readonly number[];
}) {
  const whiteW = 18;
  const blackW = 12;
  const whiteSemis = [0, 2, 4, 5, 7, 9, 11];
  const blackAfterWhite: readonly { whiteIndex: number; semi: number }[] = [
    { whiteIndex: 0, semi: 1 },
    { whiteIndex: 1, semi: 3 },
    { whiteIndex: 3, semi: 6 },
    { whiteIndex: 4, semi: 8 },
    { whiteIndex: 5, semi: 10 },
  ];
  const whites: { pc: number; midi: number; index: number }[] = [];
  const blacks: { pc: number; midi: number; left: number }[] = [];
  for (let octave = 0; octave < 2; octave++) {
    for (const semi of whiteSemis) {
      const midi = 48 + octave * 12 + semi;
      whites.push({ pc: midi % 12, midi, index: whites.length });
    }
    for (const { whiteIndex, semi } of blackAfterWhite) {
      const midi = 48 + octave * 12 + semi;
      blacks.push({
        pc: midi % 12,
        midi,
        left: (whiteIndex + 1) * whiteW - blackW / 2 + octave * 7 * whiteW,
      });
    }
  }
  return (
    <div
      data-testid="mini-piano"
      style={{ position: 'relative', width: whiteW * 14, height: 56, marginTop: 8 }}
    >
      {whites.map((key) => (
        <div
          key={`w${key.index}`}
          style={{
            position: 'absolute',
            left: key.index * whiteW,
            top: 0,
            width: whiteW - 1,
            height: 56,
            border: '1px solid #6b7280',
            background:
              highlightPcs.includes(key.pc) || highlightMidis.includes(key.midi)
                ? '#93c5fd'
                : '#fff',
            boxSizing: 'border-box',
          }}
        />
      ))}
      {blacks.map((key, index) => (
        <div
          key={`b${index}`}
          style={{
            position: 'absolute',
            left: key.left,
            top: 0,
            width: blackW,
            height: 34,
            background:
              highlightPcs.includes(key.pc) || highlightMidis.includes(key.midi)
                ? '#1d4ed8'
                : '#111827',
            zIndex: 1,
          }}
        />
      ))}
    </div>
  );
}

function accidentalName(accidental: Accidental): string {
  if (accidental === 0) return '';
  return accidental > 0 ? '#'.repeat(accidental) : 'b'.repeat(-accidental);
}

export type ChordPickerProps = {
  open: boolean;
  onClose: () => void;
  /** Chord id being replaced; null/undefined = create into current range selection. */
  editingChordId?: string | null;
  prefillRoot?: SpelledPitchClass | null;
  /** Template of the edited chord; prefills family + template (CP-1). */
  prefillTemplateId?: ChordTemplateId | null;
  /** Invoked after a SUCCESSFUL apply, before onClose (e.g. the suggestion
   * panel clears the range selection here so it unmounts). Skipped entirely
   * when the command is rejected — see apply(). */
  onApplied?: () => void;
};

/** Modal picker; mounts nothing while `open` is false.
 *
 * RevUI-2: remount-per-session. The draft state below (root/family/template)
 * is initialized from props once per mount, so keeping one long-lived
 * instance around kept a STALE prefill root across opens. Rendering the
 * session component only while open and keying it by the edited chord id
 * ('new' for create mode) re-runs those initializers on EVERY open, so the
 * root step always reflects the current prefillRoot immediately.
 */
export function ChordPicker(props: ChordPickerProps) {
  if (!props.open) return null;
  return <ChordPickerSession key={props.editingChordId ?? 'new'} {...props} />;
}
function ChordPickerSession({
  onClose,
  onApplied,
  editingChordId,
  prefillRoot,
  prefillTemplateId,
}: ChordPickerProps) {
  const dispatch = useAppDispatch();
  const context = useAppSelector(selectHarmonyContext);
  const selection = useAppSelector(selectSelection);
  const chords = useAppSelector(selectChords);

  const trapRef = useFocusTrap<HTMLDivElement>(true);

  const [root, setRoot] = useState<SpelledPitchClass>(
    prefillRoot ?? { letter: context.tonic.letter, accidental: 0 },
  );
  // CP-1: prefill the family AND template from the edited chord's template,
  // so Apply without changes is a no-op instead of silently resetting a
  // Dm7 to the basic/maj defaults.
  const knownTemplate =
    prefillTemplateId !== undefined &&
    prefillTemplateId !== null &&
    TEMPLATE_BY_ID[prefillTemplateId] !== undefined;
  const [family, setFamily] = useState<ChordFamily>(
    knownTemplate
      ? (CHORD_FAMILY_GROUPS.find((group) =>
          group.templateIds.includes(prefillTemplateId),
        )?.family ?? 'basic')
      : 'basic',
  );
  const [templateId, setTemplateId] = useState<ChordTemplateId>(
    knownTemplate ? prefillTemplateId : 'maj',
  );

  // RevUI-3: keyboard focus can sit OUTSIDE the dialog (e.g. blurred after an
  // inner click), so the dialog's React onKeyDown never sees the event.
  // Intercept keys at document level — bubble phase, ahead of the window
  // shortcut listener — so the editor shortcuts never fire while the modal
  // is up, and Escape closes the picker no matter where focus is (§3.20).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const spec: ChordSpec = useMemo(() => ({ root, templateId }), [root, templateId]);
  const analysis = useMemo(() => analyzeChordInContext(spec, context), [spec, context]);
  const previewPcs = useMemo(
    () => selectChordTones(spec, 4).map((tone) => tone.pc),
    [spec],
  );


  const editingChord =
    editingChordId !== null && editingChordId !== undefined
      ? chords.find((c) => c.id === editingChordId)
      : undefined;
  const rangeSelection = selection !== null && selection.kind === 'range' ? selection : null;
  const canApply = editingChord !== undefined || rangeSelection !== null;

  const apply = (): void => {
    // Commands dispatch → boolean: false = rejected (e.g. chord_limit §3.21)
    // and NOTHING was applied — keep the dialog and the drafted spec instead
    // of closing over the user's head.
    const applied =
      editingChord !== undefined
        ? dispatch(setChordSpecCmd({ id: editingChord.id, chord: spec }))
        : rangeSelection !== null
          ? dispatch(
              addChordRangeCmd({
                startTick: rangeSelection.startTick,
                durationTicks: rangeSelection.durationTicks,
                chord: spec,
              }),
            )
          : false;
    if (!applied) return;

    onApplied?.();
    onClose();
  };

  const degreeChips = modeScaleDegrees(context);
  const familyTemplates =
    CHORD_FAMILY_GROUPS.find((group) => group.family === family)?.templateIds ?? [];

  return (
    <div className="dialog-overlay" data-modal="" data-testid="chord-picker" onClick={onClose}>
      {/* RevUI-3: focus lands on the dialog on open (remount-per-session
          makes this fire every time); ALL key events are stopped here — and
          at document level in the session effect, which also covers focus
          sitting outside the dialog — so the window shortcut handler never
          sees them while the modal is up, and Escape closes the picker
          (§3.20). The data-modal markers (overlay AND dialog) are also the
          guard ChordLane's pointer-down handler checks, so pressing the
          dimmed backdrop never starts a lane range-drag under the modal. */}
      <div
        ref={trapRef}
        autoFocus
        tabIndex={-1}
        data-modal=""
        role="dialog"
        aria-modal="true"
        aria-label="Выбор аккорда"
        className="dialog chord-picker-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h3 className="dialog-title">Выбор аккорда</h3>

        {/* Step 1: Root */}
        <section data-testid="picker-root">
          <strong className="chord-picker-section-title">Основание</strong>
          <div className="chord-picker-grid" data-testid="picker-roots" onKeyDown={handleGridKeys}>
            {ROOT_OPTIONS.map((option) => {
              const label = `${option.value.letter}${accidentalName(option.value.accidental)}`;
              const selected =
                root.letter === option.value.letter &&
                root.accidental === option.value.accidental;
              return (
                <button
                  key={label}
                  aria-pressed={selected}
                  onClick={() => setRoot(option.value)}
                  title={option.alt !== '' ? `=${option.alt}` : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="chord-picker-row" onKeyDown={handleGridKeys}>
            <span className="chord-picker-hint">Ступень:</span>
            {degreeChips.map((degree, degreeIndex) => {
              const selected =
                root.letter === degree.letter && root.accidental === degree.accidental;
              return (
                <button
                  key={`${degree.letter}${degree.accidental}`}
                  aria-pressed={selected}
                  onClick={() =>
                    setRoot({ letter: degree.letter, accidental: degree.accidental })
                  }
                  title={`${degree.letter}${accidentalName(degree.accidental)}`}
                >
                  {degreeIndex + 1}
                </button>
              );
            })}
          </div>
        </section>

        {/* Step 2: Family */}
        <section data-testid="picker-family" className="chord-picker-section">
          <strong className="chord-picker-section-title">Семейство</strong>
          <div className="chord-picker-grid" onKeyDown={handleGridKeys}>
            {CHORD_FAMILY_GROUPS.map((group) => (
              <button
                key={group.family}
                aria-pressed={family === group.family}
                onClick={() => {
                  // §3.20: Root→Family→Template — смена семьи сбрасывает шаблон
                  // на первый шаблон новой семьи, чтобы Apply не применял
                  // шаблон предыдущей семьи.
                  setFamily(group.family);
                  setTemplateId(group.templateIds[0]!);
                }}
              >
                {CHORD_FAMILY_LABELS[group.family]}
              </button>
            ))}
          </div>
        </section>

        {/* Step 3: Template */}
        <section data-testid="picker-templates" className="chord-picker-section">
          <strong className="chord-picker-section-title">Шаблон</strong>
          <div className="chord-picker-grid" onKeyDown={handleGridKeys}>
            {familyTemplates.map((id) => {
              const template = TEMPLATE_BY_ID[id];
              return (
                <button
                  key={id}
                  aria-pressed={templateId === id}
                  onClick={() => setTemplateId(id)}
                  title={templateFormulaPreview(id)}
                >
                  {template.displaySuffix === '' ? 'maj' : template.displaySuffix}
                </button>
              );
            })}
          </div>
        </section>

        {/* Step 4: Preview */}
        <section data-testid="picker-preview" className="chord-picker-section">
          <strong className="chord-picker-preview">
            {chordSymbol(spec)} · {analysis.label}
          </strong>
          <div className="chord-picker-hint">
            Формула: {templateFormulaPreview(templateId)}
          </div>
          <MiniPiano highlightPcs={previewPcs} />
        </section>

        {/* Step 5: Apply */}
        <div className="dialog-actions">
          <button onClick={onClose}>Отмена</button>
          <button onClick={apply} disabled={!canApply} data-testid="picker-apply">
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}

export const CHORD_TEMPLATE_COUNT = CHORD_TEMPLATES.length;
