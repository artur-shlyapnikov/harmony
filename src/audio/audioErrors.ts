/**
 * Typed audio errors (§3.21).
 *
 * Audio failures must never take editing, saving or MIDI export down: they are
 * reported to the transport store as `error` state plus a typed error object
 * for callers that await engine operations.
 */

export type AudioErrorCode = 'audio/init' | 'audio/playback';

export class AudioError extends Error {
  readonly code: AudioErrorCode;

  constructor(code: AudioErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = 'AudioError';
    this.code = code;
  }
}

/** AudioContext unavailable or Tone.start() failed (§3.21 "AudioContext unavailable"). */
export class AudioInitError extends AudioError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('audio/init', message, options);
    this.name = 'AudioInitError';
  }
}

/** Playback start/scheduling failed after the context was initialized. */
export class AudioPlaybackError extends AudioError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('audio/playback', message, options);
    this.name = 'AudioPlaybackError';
  }
}
