/**
 * Voice matching between consecutive voicings (§3.11 Voice matching).
 *
 * Monotonic (order-preserving) dynamic programming over the two midi lists:
 * voices never cross, each voice may be left unmatched at a fixed
 * UNMATCHED_PENALTY (insertion/removal), and total |movement| is minimized.
 *
 * Inputs are treated as unordered multisets; pairing references original
 * array indices. With ≤4 voices per side the DP is trivially cheap.
 *
 * Pure and deterministic.
 */

export const UNMATCHED_PENALTY = 3.0;

export type VoicePair = {
  prevIndex: number;
  nextIndex: number;
  movement: number;
};

export type VoiceMatch = {
  pairs: VoicePair[];
  /** Total penalty contributed by unmatched voices on either side. */
  unmatchedPenalty: number;
};

const INFINITY = Number.POSITIVE_INFINITY;

export function matchVoices(
  prev: readonly number[],
  next: readonly number[],
): VoiceMatch {
  // Sort views so DP indices follow pitch order; map back to original
  // indices when emitting pairs.
  const prevOrder = [...prev.keys()].sort((a, b) => prev[a]! - prev[b]!);
  const nextOrder = [...next.keys()].sort((a, b) => next[a]! - next[b]!);
  const m = prevOrder.length;
  const n = nextOrder.length;

  // dp[i][j] = minimal cost of matching pitch-sorted prev[i..] with
  // pitch-sorted next[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(INFINITY),
  );
  for (let j = 0; j <= n; j++) dp[m]![j] = (n - j) * UNMATCHED_PENALTY;
  for (let i = 0; i <= m; i++) dp[i]![n] = (m - i) * UNMATCHED_PENALTY;

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const paired =
        Math.abs(next[nextOrder[j]!]! - prev[prevOrder[i]!]!) + dp[i + 1]![j + 1]!;
      const skipPrev = UNMATCHED_PENALTY + dp[i + 1]![j]!;
      const skipNext = UNMATCHED_PENALTY + dp[i]![j + 1]!;
      dp[i]![j] = Math.min(paired, skipPrev, skipNext);
    }
  }

  const pairs: VoicePair[] = [];
  let unmatched = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const paired =
      Math.abs(next[nextOrder[j]!]! - prev[prevOrder[i]!]!) + dp[i + 1]![j + 1]!;
    if (dp[i]![j] === paired) {
      const prevIndex = prevOrder[i]!;
      const nextIndex = nextOrder[j]!;
      pairs.push({
        prevIndex,
        nextIndex,
        movement: Math.abs(next[nextIndex]! - prev[prevIndex]!),
      });
      i++;
      j++;
    } else if (dp[i]![j] === UNMATCHED_PENALTY + dp[i + 1]![j]!) {
      unmatched++;
      i++;
    } else {
      unmatched++;
      j++;
    }
  }
  unmatched += m - i + n - j;

  pairs.sort((a, b) => a.nextIndex - b.nextIndex);
  return { pairs, unmatchedPenalty: unmatched * UNMATCHED_PENALTY };
}
