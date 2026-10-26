// Video-clock association grace. Pixel tracking owns presentation deadlines.
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
export const INITIAL_SAMPLE_INTERVAL_SEC = 0.4;

export function updateSampleInterval(previous: number, delta: number): number {
  if (!Number.isFinite(delta) || delta <= 0) return previous;
  const next = clamp(delta, 0.05, 1);
  // Increase promptly when inference slows; reduce gradually after a fast frame.
  return previous + (next - previous) * (next > previous ? 0.7 : 0.15);
}

/** Established tracks can bridge four misses; tentative tracks get less grace. */
export function coastDuration(sampleInterval: number, reliable = false): number {
  return clamp(sampleInterval * (reliable ? 4.5 : 2.5), 0.35, reliable ? 2.2 : 1.6);
}

