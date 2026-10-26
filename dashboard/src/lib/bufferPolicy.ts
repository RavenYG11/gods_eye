/** Shared playback policy. All values refer to media time, never wall time. */
export const PLAYBACK_DELAY_SEC = 24;
export const STARTUP_BUFFER_SEC = 16;
export const REBUFFER_SEC = 10;

export interface MediaRange { start: number; end: number }

/** A later disjoint range is NOT usable buffer for the current frame. */
export function bufferedAt(ranges: TimeRanges, position: number): MediaRange | null {
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i), end = ranges.end(i);
    if (position >= start - 0.1 && position <= end) return { start, end };
  }
  return null;
}

export function safePlaybackPosition(start: number, end: number): number {
  const duration = end - start;
  if (!(duration > 0)) return start;
  const margin = Math.min(2, duration / 4);
  return Math.max(start + margin, Math.min(end - margin, end - PLAYBACK_DELAY_SEC));
}

export function bufferGoal(start: number, end: number, position: number, startup: boolean): number {
  const wanted = startup ? STARTUP_BUFFER_SEC : REBUFFER_SEC;
  // Short playlists and manual seeks near live must not wait for impossible data.
  const available = end > start ? Math.max(1, end - Math.max(start, position) - 1) : wanted;
  return Math.min(wanted, available);
}
