/**
 * Tiny statistics helpers shared by the analysis modules. Kept separate from
 * rhythm/drift so both stay pure and the helpers get tested once.
 */

/** Median of a copy of the input; null for an empty input. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

/** Index of the largest value, earliest index winning ties; -1 when empty. */
export function argMax(values: readonly number[]): number {
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
