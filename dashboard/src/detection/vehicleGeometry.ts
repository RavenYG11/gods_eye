import type { Detection } from "./types";

type Box = Detection["bbox"];

export function intersectionArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
}

/** Containment alone is insufficient: a motorcycle can occlude a larger car.
 * Require similar scale and centers before collapsing nested model boxes. */
export function duplicateVehicle(a: Pick<Detection, "label" | "bbox">, b: Pick<Detection, "label" | "bbox">): boolean {
  const aa = a.bbox[2] * a.bbox[3], ba = b.bbox[2] * b.bbox[3];
  if (!(aa > 0 && ba > 0)) return false;
  const intersection = intersectionArea(a.bbox, b.bbox);
  const iou = intersection / (aa + ba - intersection);
  // Different classes compete only when virtually the entire box is identical.
  if (a.label !== b.label) return iou >= 0.85;
  const dx = Math.abs(a.bbox[0] + a.bbox[2] / 2 - b.bbox[0] - b.bbox[2] / 2);
  const dy = Math.abs(a.bbox[1] + a.bbox[3] / 2 - b.bbox[1] - b.bbox[3] / 2);
  return iou >= 0.65 || (intersection / Math.min(aa, ba) >= 0.9 &&
    Math.min(aa, ba) / Math.max(aa, ba) >= 0.45 &&
    dx <= Math.min(a.bbox[2], b.bbox[2]) * 0.2 && dy <= Math.min(a.bbox[3], b.bbox[3]) * 0.2);
}

/** Callers choose priority (confidence for observations, freshness for tracks). */
export function uniqueVehicles<T extends Pick<Detection, "label" | "bbox">>(ordered: readonly T[]): T[] {
  const kept: T[] = [];
  for (const detection of ordered) if (!kept.some(other => duplicateVehicle(other, detection))) kept.push(detection);
  return kept;
}

export function revealsEntry(previous: Box, current: Box): boolean {
  const ratio = current[2] * current[3] / (previous[2] * previous[3]);
  return ratio >= 1 && ratio <= 12 && intersectionArea(previous, current) / (previous[2] * previous[3]) >= 0.5;
}
