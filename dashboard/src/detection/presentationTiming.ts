import type { MotionSnapshot } from "./motionTracker";

/** Pixel loss and capture-to-delivery lag are separate budgets. The worker
 * still removes a failed pixel track; this only covers late delivery. */
export function compensateDelivery(snapshot: MotionSnapshot, videoPts: number, previousLag = 0.08): {
  snapshot: MotionSnapshot; lag: number;
} {
  const measured = Math.max(0, Math.min(0.24, videoPts - snapshot.framePts));
  const lag = Math.max(Number.isFinite(measured) ? measured : 0, previousLag * 0.95);
  return { lag, snapshot: { ...snapshot, detections: snapshot.detections.map((det) => ({ ...det,
    presentationLagSec: lag,
    coastSec: Math.min(0.6, (det.coastSec ?? 0.22) + lag),
  })) } };
}
