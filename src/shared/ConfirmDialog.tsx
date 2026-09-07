/**
 * Promise-style confirmation dialog: `useConfirm()` returns an async
 * `(options) => boolean` function; the provider renders the dialog and
 * resolves the promise on Confirm/Cancel. A pending promise resolves `false`
 * if the provider unmounts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useFocusTrap } from './focusTrap';

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PendingConfirm = {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
};

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const confirm = useContext(ConfirmContext);
  if (confirm === null) {
    throw new Error('useConfirm must be used inside <ConfirmDialogProvider>');
  }
  return confirm;
}

function DialogBody({
  pending,
  onResolve,
}: {
  pending: PendingConfirm;
  onResolve: (confirmed: boolean) => void;
}) {
  const { options } = pending;
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  // ChordPicker convention (RevUI-3): Escape closes the modal no matter
  // where focus sits, and an overlay click cancels. The document-level
  // bubble listener fires ahead of the window shortcut listener, so the
  // editor shortcuts never see keys while the confirm is up.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        onResolve(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onResolve]);

  return (
    <div className="dialog-overlay" role="presentation" onClick={() => onResolve(false)}>
      {/* RevUI-3: [data-modal] guard for useEditorShortcuts (see ChordPicker). */}
      <div
        ref={trapRef}
        className="dialog"
        data-modal=""
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title">{options.title}</h2>
        <p className="dialog-message">{options.message}</p>
        <div className="dialog-actions">
          <button
            type="button"
            autoFocus={options.danger === true}
            onClick={() => onResolve(false)}
          >
            {options.cancelLabel ?? 'Отмена'}
          </button>
          <button
            type="button"
            className={options.danger ? 'button-danger' : 'button-primary'}
            autoFocus={options.danger !== true}
            onClick={() => onResolve(true)}
          >
            {options.confirmLabel ?? 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    // One question at a time: an earlier unresolved prompt is cancelled.
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next = { options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const resolveAndClose = useCallback((confirmed: boolean) => {
    pendingRef.current?.resolve(confirmed);
    pendingRef.current = null;
    setPending(null);
  }, []);

  // Documented contract (see module header): a pending promise resolves
  // `false` when the provider unmounts, so awaiting callers never hang.
  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending !== null && <DialogBody pending={pending} onResolve={resolveAndClose} />}
    </ConfirmContext.Provider>
  );
}

export function ConfirmDialog(props: { options: ConfirmOptions; open: boolean; onClose: (confirmed: boolean) => void }) {
  if (!props.open) return null;
  return <DialogBody pending={{ options: props.options, resolve: props.onClose }} onResolve={props.onClose} />;
}
