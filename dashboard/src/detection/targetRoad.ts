import type { Detection } from "./types";

// Near edge of the median for the fixed A. Yani / RS Mitra Keluarga view.
// Normalized coordinates keep the calibration independent of bitmap size.
// Use the vehicle's ground contact, so a tall or half-visible body can extend
// over the median without being assigned to the opposite carriageway.
const MEDIAN: readonly (readonly [number, number])[] = [
  [0, 0.01], [0.2, 0.115], [0.4, 0.235], [0.6, 0.365], [0.8, 0.50], [1, 0.635],
];

export function onTargetRoad(box: Detection["bbox"], width: number, height: number): boolean {
  if (![...box, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;
  const [x, y, w, h] = box;
  if (w <= 2 || h <= 2 || x + w <= 0 || y + h <= 0 || x >= width || y >= height) return false;
  const footX = Math.max(0, Math.min(1, (x + w / 2) / width));
  const footY = Math.min(1, (y + h * 0.95) / height);
  for (let i = 1; i < MEDIAN.length; i++) {
    const [ax, ay] = MEDIAN[i - 1], [bx, by] = MEDIAN[i];
    if (footX <= bx) return footY >= ay + (by - ay) * (footX - ax) / (bx - ax);
  }
  return false;
}
