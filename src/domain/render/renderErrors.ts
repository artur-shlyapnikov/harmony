/**
 * Typed render errors (§3.13 Render pipeline).
 *
 * The unified playback stream is validated as the final pipeline stage
 * ("Все события → validate → clip → sort → PlaybackProject"); a stream
 * that still fails validation aborts rendering instead of reaching the
 * audio path.
 */

import type { PlaybackIssue } from './validatePlayback';

/** Render aborted because the rendered stream failed §3.13 validation. */
export class PlaybackRenderError extends Error {
  readonly issues: readonly PlaybackIssue[];

  constructor(issues: readonly PlaybackIssue[]) {
    super(
      `Rendered playback stream failed validation: ${issues
        .map((issue) => `${issue.code}@${issue.index}`)
        .join(', ')}`,
    );
    this.name = 'PlaybackRenderError';
    this.issues = issues;
  }
}
