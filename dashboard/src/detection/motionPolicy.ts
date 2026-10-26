import { DETECTOR_PARSE_FLOOR, VEHICLE_POLICY } from "./vehicleConfig";
import type { TrackedDetection } from "./tracker";

export const motionCoast = (interval: number): number => Math.max(0.22, Math.min(0.4, interval * 3));
// Feature-poor / clipped objects may use a recent real model box until the
// next observation. Pixel loss on an established track does not get this grace.
export const observationCoast = (interval: number): number => Math.max(0.3, Math.min(0.8, interval * 1.5));
export function canAnchor(det: TrackedDetection): boolean {
  const policy = VEHICLE_POLICY[det.label as keyof typeof VEHICLE_POLICY];
  return !!policy && !det.stale && det.bbox.every(Number.isFinite) &&
    det.bbox[2] > 2 && det.bbox[3] > 2 && Number.isFinite(det.confidence) &&
    det.confidence >= (det.observations >= 2 ? DETECTOR_PARSE_FLOOR : policy.newTrackConfidence);
}

/** Direction uses accumulated displacement, not the sign of a noisy frame. */
export class MotionHeading {
  private samples: { pts: number; x: number; y: number }[] = [];
  direction: "atas" | "bawah" | "unknown" = "unknown";
  move(dx: number, dy: number, pts: number, height: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last) this.observe([last.x + dx, last.y + dy - height / 2, 0, height], pts);
  }
  observe(box: [number, number, number, number], pts: number): void {
    this.samples.push({ pts, x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 });
    while (this.samples.length > 2 && this.samples[0].pts < pts - 0.45) this.samples.shift();
    const first = this.samples[0], last = this.samples[this.samples.length - 1];
    if (last.pts - first.pts < 0.12) return;
    const dy = last.y - first.y;
    const gate = this.direction === "unknown" ? Math.max(0.9, box[3] * 0.025) : Math.max(2, box[3] * 0.07);
    if (dy < -gate) this.direction = "atas";
    else if (dy > gate) this.direction = "bawah";
  }
}
