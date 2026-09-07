/**
 * Playhead overlay (§3.17 Execution model).
 *
 * Position is read from the ProjectTransport (framework-external TransportStore
 * underneath) inside a rAF subscription (useSyncExternalStore) and applied as
 * a GPU-friendly transform — no per-frame Redux dispatches.
 *
 * Rendered inside the scrolled content layer; x is document-space
 * (timelineGeometry.tickToX), scroll offset is handled by the scroll container.
 */

import { useSyncExternalStore } from 'react';

import { getProjectTransport } from '@audio/projectTransport';
import { timelineGeometry } from '@features/editor/timelineGeometry';
import { selectViewport } from '@state/selectors';
import { useAppSelector } from '@app/hooks';

const transport = getProjectTransport();

export type PlayheadProps = {
  className?: string;
};

export function Playhead({ className }: PlayheadProps) {
  const snapshot = useSyncExternalStore(transport.subscribe, transport.getSnapshot);
  const zoomPxPerBeat = useAppSelector(selectViewport).zoomPxPerBeat;
  const x = timelineGeometry.tickToX(snapshot.currentTick, zoomPxPerBeat);

  return (
    <div
      data-testid="playhead"
      className={className === undefined ? 'playhead' : `${className} playhead`}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: 2,
        pointerEvents: 'none',
        transform: `translateX(${x}px)`,
      }}
    />
  );
}
