import type { Detection } from "./types";

export interface InferenceRegion {
  x: number; y: number; width: number; height: number; detail: boolean;
  sourceWidth: number; sourceHeight: number;
}
/** Keep entry priority, but use the model's unused vertical letterbox space
 * to cover the ENTIRE height of both lanes, including small upstream motors
 * and half-visible bottom entries. Crop width and object scale stay the same. */
export function inferenceRegion(width: number, height: number, sequence: number): InferenceRegion {
  const source = { sourceWidth: width, sourceHeight: height };
  const view = sequence % 6;
  if (view === 3) return { ...source, x: 0, y: 0, width, height, detail: false };
  const cropWidth = Math.round(width * 0.68);
  return { ...source, x: view % 2 === 1 ? 0 : width - cropWidth, y: 0,
    width: cropWidth, height, detail: true };
}
export function restoreRegion(detections: Detection[], region: InferenceRegion): Detection[] {
  return detections.filter((det) => {
    if (!region.detail) return true;
    const [x, y, w, h] = det.bbox;
    // Keep half-visible vehicles at real image boundaries. Only artificial
    // crop seams defer to the overlapping views / overview to avoid fragments.
    return (region.x === 0 || x > 2) && (region.y === 0 || y > 2) &&
      (region.x + region.width === region.sourceWidth || x + w < region.width - 2) &&
      (region.y + region.height === region.sourceHeight || y + h < region.height - 2);
  }).map((d) => ({ ...d, bbox: [d.bbox[0] + region.x, d.bbox[1] + region.y, d.bbox[2], d.bbox[3]] }));
}
