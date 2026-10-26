import type { Box } from "./opticalFlow";
import type { TrackedDetection } from "./tracker";

/** Smooth only the correction error. Feed-forward motion keeps the box attached
 * without delaying the entire overlay by another tracking interval. */
export class BoxPresenter {
  private shown = new Map<number, { box: Box; pts: number }>();
  private pts = -1;
  reset(): void { this.shown.clear(); this.pts = -1; }
  begin(pts: number, ids: Set<number>): void {
    if (pts < this.pts - 0.08 || pts - this.pts > 0.8) this.reset();
    this.pts = pts;
    for (const id of this.shown.keys()) if (!ids.has(id)) this.shown.delete(id);
  }
  present(det: TrackedDetection, pts: number): { bbox: Box; opacity: number } | null {
    const age = pts - det.framePts;
    const coast = det.coastSec ?? 0.22;
    if (!Number.isFinite(age) || age < -0.08 || age > coast) {
      this.shown.delete(det.trackId); return null;
    }
    const bridge = Math.min(0.24, Math.max(0.08, (det.motionIntervalSec ?? 1 / 15) * 2 + (det.presentationLagSec ?? 0)));
    const prediction = Math.max(0, Math.min(age, bridge));
    const target: Box = [det.bbox[0] + det.vx * prediction,
      det.bbox[1] + det.vy * prediction, det.bbox[2], det.bbox[3]];
    const previous = this.shown.get(det.trackId);
    let box = target;
    if (previous && pts >= previous.pts) {
      const dt = Math.min(0.1, pts - previous.pts);
      const forward = age <= bridge ? dt : 0;
      const predicted: Box = [previous.box[0] + det.vx * forward,
        previous.box[1] + det.vy * forward, previous.box[2], previous.box[3]];
      if (Math.hypot(target[0] - predicted[0], target[1] - predicted[1]) < Math.hypot(target[2], target[3]) * 0.6) {
        const alpha = 1 - Math.exp(-dt / 0.055);
        box = target.map((v, i) => predicted[i] + (v - predicted[i]) * alpha) as Box;
      }
    }
    this.shown.set(det.trackId, { box, pts });
    return { bbox: box, opacity: Math.min(1, Math.max(0, (coast - age) / 0.06)) };
  }
}
