import type { Detection } from "./types";
import { VEHICLE_POLICY } from "./vehicleConfig";
import { onTargetRoad } from "./targetRoad";
import { intersectionArea, uniqueVehicles } from "./vehicleGeometry";

export interface FrameSize { width: number; height: number }

export function inVehicleEntry(box: Detection["bbox"], size: FrameSize): boolean {
  if (!onTargetRoad(box, size.width, size.height)) return false;
  const right = box[0] + box[2], bottom = box[1] + box[3];
  return bottom >= size.height * 0.98 || right >= size.width * 0.98 ||
    (right >= size.width * 0.78 && bottom >= size.height * 0.68);
}

/** The near right-hand approach gets its first-sighting gate before a model
 * box reaches the physical border. Distant/interior gates stay unchanged. */
export function vehicleBirthThreshold(label: string, box?: Detection["bbox"], size?: FrameSize | null): number | undefined {
  const policy = VEHICLE_POLICY[label as keyof typeof VEHICLE_POLICY];
  if (!policy) return undefined;
  if (box && size && inVehicleEntry(box, size)) return policy.entryConfidence;
  return policy.newTrackConfidence;
}

/** Auxiliary COCO predictions remain internal evidence, never visible tracks.
 * A rider typically occupies the upper part of a motor box. Reject a person
 * hypothesis only when it also explains its bottom/wheel area. */
export function validatedVehicles(detections: Detection[], size?: FrameSize | null): Detection[] {
  const context = detections.filter(d => d.label === "person" || d.label === "bicycle");
  return uniqueVehicles(detections.filter(d => {
    if (d.label !== "mobil" && d.label !== "motor") return false;
    const [x, y, w, h] = d.bbox;
    if (![x, y, w, h, d.confidence].every(Number.isFinite) || w <= 2 || h <= 2) return false;
    if (size && !onTargetRoad(d.bbox, size.width, size.height)) return false;
    // A full, very tall car box is usually a pedestrian/cart hypothesis in
    // this rear-facing view. Physical clipping is exempt from aspect gates.
    const clipped = size && (x <= 2 || y <= 2 || x + w >= size.width - 2 || y + h >= size.height - 2);
    if (!clipped && ((d.label === "mobil" && w / h < 0.55) ||
      (d.label === "motor" && (w / h < 0.18 || w / h > 2.2)))) return false;
    return !context.some(c => {
      if (c.confidence < Math.max(0.35, d.confidence * 0.9)) return false;
      const coverage = intersectionArea(d.bbox, c.bbox) / (w * h);
      const foot = c.bbox[1] + c.bbox[3];
      return coverage >= 0.8 && foot >= y + h * 0.92 && c.bbox[3] >= h * 0.85;
    });
  }).sort((a, b) => b.confidence - a.confidence));
}
