import type { Detection, DetectionFrame, Detector } from "./types";
import type { TrackedDetection } from "./tracker";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";
import { CAPTURE_RESIZE_WIDTH } from "./vehicleConfig";

/** One capture and inference at a time. Every response belongs to a request. */
export class WorkerVehicleDetector implements Detector {
  private worker: Worker | null = null;
  private busy = false;
  private sequence = 0;
  private generation = 0;
  private pending: { id: number; resolve: (f: DetectionFrame | null) => void;
    timer: number } | null = null;
  private initPending: { resolve: () => void; reject: (e: Error) => void;
    timer: number } | null = null;
  public lastError = "";
  public lastProvider: string | null = null;
  public lastInferMs: number | null = null;


  async init(opts: { modelUrl: string; labels: string[]; fallbackUrl: string;
    wasmBase: string }): Promise<void> {
    this.disposeSync();
    this.lastError = "";
    const worker = new Worker(new URL("./detection.worker.ts", import.meta.url),
      { type: "module" });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return;
      const msg = e.data;
      if (msg.type === "ready") {
        this.lastProvider = msg.provider;
        const init = this.initPending;
        this.initPending = null;
        if (init) { clearTimeout(init.timer); init.resolve(); }
      } else if (msg.type === "init-error") {
        this.fail(msg.message);
      } else if (this.pending?.id === msg.requestId) {
        if (msg.type === "detect-error") this.fail(msg.message);
        else this.finish(msg.type === "result" ? msg.frame : null);
      }
    };
    worker.onerror = (e) => this.fail(e.message || "Worker deteksi gagal.");
    worker.onmessageerror = () => this.fail("Respons worker tidak dapat dibaca.");
    await new Promise<void>((resolve, reject) => {
      this.initPending = { resolve, reject, timer: window.setTimeout(() =>
        this.fail("Model tidak siap dalam 90 detik."), 90_000) };
      this.send({ type: "init", modelUrl: opts.modelUrl,
        fallbackUrl: opts.fallbackUrl, wasmBase: opts.wasmBase });
    });
  }

  /** Invalidates a capture/result even if a seek occurs during inference. */
  reset(): void {
    this.generation++;
    this.send({ type: "reset" });
  }

  async detectFrame(video: HTMLVideoElement, presentedPts = video.currentTime): Promise<DetectionFrame | null> {
    // A skipped call owns no lock: keep this guard OUTSIDE try/finally.
    if (this.busy || !this.worker || video.readyState < 2 || !video.videoWidth) return null;
    this.busy = true;
    const worker = this.worker;
    const generation = this.generation;
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const framePts = presentedPts;
    let bitmap: ImageBitmap | null = null;
    try {
      const width = Math.min(CAPTURE_RESIZE_WIDTH, srcW);
      const height = Math.max(1, Math.round(srcH * width / srcW));
      try {
        bitmap = await createImageBitmap(video, { resizeWidth: width,
          resizeHeight: height, resizeQuality: "low" });
      } catch { bitmap = await createImageBitmap(video); }
      if (this.worker !== worker || generation !== this.generation) return null;
      const bmpW = bitmap.width, bmpH = bitmap.height;
      const id = ++this.sequence;
      const frame = await new Promise<DetectionFrame | null>((resolve) => {
        this.pending = { id, resolve, timer: window.setTimeout(() =>
          this.fail("Inferensi macet lebih dari 15 detik. Klik Coba lagi."), 15_000) };
        const request: WorkerRequest = { type: "detect", requestId: id,
          frame: bitmap!, srcW: bmpW, srcH: bmpH, framePts, cameraId: "" };
        worker.postMessage(request, [bitmap!]);
        bitmap = null; // ownership moved to worker
      });
      if (!frame || generation !== this.generation || worker !== this.worker) return null;
      const kx = srcW / bmpW, ky = srcH / bmpH;
      const captureLag = Math.max(0, Math.min(1.5, video.currentTime - frame.framePts));
      for (const d of frame.detections as TrackedDetection[]) {
        const [x, y, w, h] = d.bbox;
        d.bbox = [x * kx, y * ky, w * kx, h * ky];
        d.vx *= kx; d.vy *= ky;
        d.captureLagSec = captureLag;
      }
      for (const d of frame.rejectedDetections ?? []) {
        const [x, y, w, h] = d.bbox;
        d.bbox = [x * kx, y * ky, w * kx, h * ky];
      }
      this.lastInferMs = frame.inferMs;
      return frame;
    } catch (e) {
      if (this.worker === worker) this.fail(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      bitmap?.close();
      this.busy = false;
    }
  }

  async detect(frame: ImageData | HTMLVideoElement): Promise<Detection[]> {
    if (!(frame instanceof HTMLVideoElement)) return [];
    return (await this.detectFrame(frame))?.detections ?? [];
  }
  async dispose(): Promise<void> { this.disposeSync(); }
  private send(msg: WorkerRequest): void { this.worker?.postMessage(msg); }
  private finish(frame: DetectionFrame | null): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(frame); }
  }
  private fail(message: string): void {
    this.lastError = message;
    this.disposeSync();
  }
  private disposeSync(): void {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    this.finish(null);
    const init = this.initPending;
    this.initPending = null;
    if (init) { clearTimeout(init.timer); init.reject(new Error(this.lastError || "Detector ditutup.")); }
  }
}
