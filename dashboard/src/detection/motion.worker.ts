import { grayFromRgba } from "./opticalFlow";
import { MotionTracker, type MotionSnapshot } from "./motionTracker";
import type { TrackedDetection } from "./tracker";
import { canAnchor } from "./motionPolicy";
import { onTargetRoad } from "./targetRoad";

export type MotionRequest =
  | { type: "frame"; generation: number; bitmap: ImageBitmap; pts: number; srcW: number; srcH: number }
  | { type: "anchor"; generation: number; detections: TrackedDetection[]; pts: number; srcW: number; srcH: number }
  | { type: "reset"; generation: number };
export type MotionResponse = { type: "motion"; generation: number; ack: boolean; snapshot: MotionSnapshot }
  | { type: "error"; generation: number; message: string };
const port = self as unknown as { onmessage: (e: MessageEvent<MotionRequest>) => void;
  postMessage: (m: MotionResponse) => void };
const tracker = new MotionTracker({ targetRoadOnly: true });
const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
let generation = 0, srcW = 1, srcH = 1;
let anchorJob: Extract<MotionRequest, { type: "anchor" }> | null = null;
let pendingAnchor: Extract<MotionRequest, { type: "anchor" }> | null = null;
let anchorTimer = 0;
let replay: Generator<void, MotionSnapshot> | null = null;

function clearAnchors(): void {
  anchorJob = pendingAnchor = null; replay = null; clearTimeout(anchorTimer);
}

function applyNextAnchor(): void {
  const job = anchorJob;
  if (!job || job.generation !== generation || job.srcW !== srcW || job.srcH !== srcH) {
    clearAnchors(); return;
  }
  const kx = canvas.width / srcW, ky = canvas.height / srcH;
  try {
    replay ??= tracker.anchorSteps(job.detections.map((det) => ({ ...det,
      bbox: [det.bbox[0] * kx, det.bbox[1] * ky, det.bbox[2] * kx, det.bbox[3] * ky],
      vx: det.vx * kx, vy: det.vy * ky })), job.pts);
    // Amortize timer clamping across several historical frames, while keeping
    // a four-ms budget so incoming live frames can still preempt replay.
    const started = performance.now();
    let step: IteratorResult<void, MotionSnapshot>;
    let steps = 0;
    do { step = replay.next(); steps++; }
    while (!step.done && steps < 8 && performance.now() - started < 4);
    emit(step.done ? step.value : tracker.snapshot(), false);
    if (step.done) {
      replay = null; anchorJob = pendingAnchor; pendingAnchor = null;
    }
    if (anchorJob) anchorTimer = self.setTimeout(applyNextAnchor, 0);
  } catch (error) {
    clearAnchors();
    port.postMessage({ type: "error", generation, message: String(error) });
  }
}

function emit(snapshot: MotionSnapshot, ack: boolean): void {
  const kx = srcW / canvas.width, ky = srcH / canvas.height;
  port.postMessage({ type: "motion", generation, ack, snapshot: {
    framePts: snapshot.framePts, entries: snapshot.entries, detections: snapshot.detections.map((d) => ({ ...d,
      bbox: [d.bbox[0] * kx, d.bbox[1] * ky, d.bbox[2] * kx, d.bbox[3] * ky],
      vx: d.vx * kx, vy: d.vy * ky })) } });
}
port.onmessage = ({ data: msg }) => {
  if (msg.type === "reset") {
    generation = msg.generation; tracker.reset(); clearAnchors(); return;
  }
  if (msg.generation !== generation) { if (msg.type === "frame") msg.bitmap.close(); return; }
  try {
    if (!ctx) throw new Error("Pelacakan gerak memerlukan OffscreenCanvas 2D.");
    if (msg.type === "frame") {
      if (msg.srcW !== srcW || msg.srcH !== srcH ||
        canvas.width !== msg.bitmap.width || canvas.height !== msg.bitmap.height) clearAnchors();
      srcW = msg.srcW; srcH = msg.srcH;
      if (canvas.width !== msg.bitmap.width || canvas.height !== msg.bitmap.height) {
        canvas.width = msg.bitmap.width; canvas.height = msg.bitmap.height;
      }
      ctx.drawImage(msg.bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      emit(tracker.push(grayFromRgba(image.data, image.width, image.height), msg.pts), true);
    } else if (msg.srcW === srcW && msg.srcH === srcH) {
      const job = { ...msg, detections: msg.detections.filter((det) =>
        canAnchor(det) && onTargetRoad(det.bbox, srcW, srcH)).sort((a, b) =>
        Number(b.observations === 1) - Number(a.observations === 1) ||
        (b.bbox[1] + b.bbox[3]) - (a.bbox[1] + a.bbox[3])) };
      // Never cancel an in-progress new-vehicle replay on every YOLO result.
      // Keep just the newest pending anchor; queue length is always bounded.
      if (anchorJob) pendingAnchor = job;
      else {
        anchorJob = job;
        anchorTimer = self.setTimeout(applyNextAnchor, 0);
      }
    }
  } catch (error) {
    port.postMessage({ type: "error", generation, message: error instanceof Error ? error.message : String(error) });
  } finally { if (msg.type === "frame") msg.bitmap.close(); }
};
