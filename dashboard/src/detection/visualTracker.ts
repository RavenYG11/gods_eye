import type { DetectionFrame } from "./types";
import type { TrackedDetection } from "./tracker";
import type { MotionRequest, MotionResponse } from "./motion.worker";
import type { MotionSnapshot } from "./motionTracker";
import { MOTION_WIDTH } from "./vehicleConfig";

/** One lightweight frame in flight, independent from the YOLO inference lock. */
export class VisualTracker {
  private worker: Worker;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private timer = 0;
  constructor(onSnapshot: (snapshot: MotionSnapshot) => void, private onError: (message: string) => void) {
    this.worker = new Worker(new URL("./motion.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<MotionResponse>) => {
      if (this.disposed || data.generation !== this.generation) return;
      if (data.type === "error") { this.fail(data.message); return; }
      if (data.ack) { this.busy = false; clearTimeout(this.timer); }
      onSnapshot(data.snapshot);
    };
    this.worker.onerror = (e) => this.fail(e.message || "Worker pelacakan gerak gagal.");
    this.worker.onmessageerror = () => this.fail("Respons pelacakan gerak tidak dapat dibaca.");
  }
  capture(video: HTMLVideoElement, pts: number): boolean {
    if (this.busy || this.disposed) return false;
    this.busy = true;
    const version = this.generation, srcW = video.videoWidth, srcH = video.videoHeight;
    const width = Math.min(MOTION_WIDTH, srcW), height = Math.max(1, Math.round(srcH * width / srcW));
    this.timer = window.setTimeout(() => this.fail("Pelacakan gerak tidak merespons selama 5 detik."), 5000);
    void createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: "low" }).then((bitmap) => {
      if (this.disposed || version !== this.generation) { bitmap.close(); return; }
      const request: MotionRequest = { type: "frame", generation: version, bitmap, pts, srcW, srcH };
      this.worker.postMessage(request, [bitmap]);
    }).catch((e: unknown) => {
      if (!this.disposed && version === this.generation) this.fail(e instanceof Error ? e.message : String(e));
    });
    return true;
  }
  anchor(frame: DetectionFrame, video: HTMLVideoElement): void {
    if (this.disposed) return;
    const msg: MotionRequest = { type: "anchor", generation: this.generation,
      detections: frame.detections as TrackedDetection[], pts: frame.framePts,
      srcW: video.videoWidth, srcH: video.videoHeight };
    this.worker.postMessage(msg);
  }
  reset(): void {
    this.generation++; this.busy = false; clearTimeout(this.timer);
    const msg: MotionRequest = { type: "reset", generation: this.generation };
    this.worker.postMessage(msg);
  }
  dispose(): void { this.disposed = true; clearTimeout(this.timer); this.worker.terminate(); }
  private fail(message: string): void {
    if (this.disposed) return;
    this.dispose(); this.onError(message);
  }
}
