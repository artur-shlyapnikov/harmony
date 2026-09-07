/**
 * Instruments for unified playback (§3.13, §3.17).
 *
 * Two independent Tone.js instruments, no external sample packs (§3.17):
 * - melody: monophonic Synth;
 * - harmony: polyphonic PolySynth.
 *
 * Factories only build nodes; lifetime is owned by AudioEngine via
 * `Instruments.dispose()` so a disposed context never leaks oscillators.
 */

import type { PolySynth, Synth } from 'tone';
export type Instruments = {
  melody: Synth;
  harmony: PolySynth<Synth>;
  /** Disposes both instruments; safe to call once from AudioEngine.dispose(). */
  dispose(): void;
};

/** Melody sits slightly above the harmony pad in the mix. */
const MELODY_VOLUME_DB = -8;
const HARMONY_VOLUME_DB = -14;

export async function createInstruments(): Promise<Instruments> {
  // Dynamic import keeps Tone.js out of the static module graph: it is only
  // loaded when playback actually initializes (§3.17 lazy audio bootstrap).
  const { PolySynth, Synth } = await import('tone');

  const melody = new Synth({
    volume: MELODY_VOLUME_DB,
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.2 },
  }).toDestination();

  const harmony = new PolySynth(Synth, {
    volume: HARMONY_VOLUME_DB,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.4 },
  }).toDestination();
  harmony.maxPolyphony = 32;

  return {
    melody,
    harmony,
    dispose: () => {
      harmony.dispose();
      melody.dispose();
    },
  };
}
