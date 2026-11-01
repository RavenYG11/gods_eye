import type { Detection } from "./types";
import { onTargetRoad } from "./targetRoad";
import type { FrameSize } from "./vehicleAcceptance";
import { MOTOR_PROPOSAL_FLOOR } from "./vehicleConfig";
import { intersectionArea } from "./vehicleGeometry";

interface Proposal { detection: Detection; pts: number }
export interface ConfirmedMotor { first: Detection; firstPts: number; current: Detection }

/** Repeated weak MOTOR predictions may establish a moving object. A person,
 * stationary hypothesis or a single low score never establishes a vehicle. */
export class MotorProposals {
  private pending: Proposal[] = [];
  reset(): void { this.pending = []; }

  reject(detections: Detection[]): void {
    this.pending = this.pending.filter(p => !detections.some(d => d.label === "motor" &&
      intersectionArea(p.detection.bbox, d.bbox) /
        Math.min(p.detection.bbox[2] * p.detection.bbox[3], d.bbox[2] * d.bbox[3]) >= 0.5));
  }

  update(detections: Detection[], pts: number, size: FrameSize | null): ConfirmedMotor[] {
    if (!size) { this.reset(); return []; }
    const previous = this.pending.filter(p => pts > p.pts && pts - p.pts <= 1.2);
    const used = new Set<Proposal>(), confirmed: ConfirmedMotor[] = [], next: Proposal[] = [];
    for (const detection of detections) {
      if (detection.label !== "motor" || detection.confidence < MOTOR_PROPOSAL_FLOOR ||
        !onTargetRoad(detection.bbox, size.width, size.height)) continue;
      const [x, y, w, h] = detection.bbox;
      let best: Proposal | undefined, bestDistance = Infinity;
      for (const candidate of previous) {
        if (used.has(candidate)) continue;
        const [px, py, pw, ph] = candidate.detection.bbox;
        const ratio = w * h / (pw * ph), dx = x + w / 2 - px - pw / 2, dy = y + h / 2 - py - ph / 2;
        const distance = Math.hypot(dx, dy), dt = pts - candidate.pts;
        // Upward displacement must exceed box jitter; reject implausible scale
        // changes / lateral jumps rather than joining unrelated faint boxes.
        if (ratio < .5 || ratio > 2 || dy > -Math.max(2, Math.min(h, ph) * .08) ||
          Math.abs(dx) > Math.max(6, -dy * 4) || distance > Math.min(90, 180 * dt) ||
          distance >= bestDistance) continue;
        best = candidate; bestDistance = distance;
      }
      if (best) {
        used.add(best); confirmed.push({ first: best.detection, firstPts: best.pts, current: detection });
      } else next.push({ detection, pts });
    }
    // Keep unseen candidates across the alternating views, without extending
    // their expiry. A current static observation replaces its nearby old one.
    this.pending = [...next, ...previous.filter(p => !used.has(p) && !next.some(n => {
      const a = p.detection.bbox, b = n.detection.bbox;
      return Math.hypot(a[0] - b[0], a[1] - b[1]) < Math.max(8, Math.min(a[2], b[2]));
    }))].slice(0, 64);
    return confirmed;
  }
}
