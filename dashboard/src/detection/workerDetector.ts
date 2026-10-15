// Pembungkus worker → memenuhi kontrak Detector untuk main thread.
// Dashboard TIDAK PERNAH import onnxDetector langsung (arsitektur §2:
// dashboard hanya bicara lewat DetectionPort).
//
// Pola: 1 worker, 1 inferensi dalam penerbangan (MAX_INFLIGHT). detect()
// menolak frame baru selama inferensi berjalan (resolve []), bukan mengantre
// — antrean = latensi menumpuk = overlay makin tertinggal dari video.

import type { Detection, DetectionFrame, Detector } from "./types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

export class WorkerVehicleDetector implements Detector {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private pendingResult: ((f: DetectionFrame) => void) | null = null;
  private inflight = false;
  private disposed = false;
  /** Pesan galat terakhir dari worker (untuk UI). */
  public lastError = "";
  /**
   * True bila detect() terakhir MENGLEWATI frame (worker masih sibuk) —
   * hasilnya [] dan BUKAN hasil inferensi valid. Dipakai hook untuk
   * menghitung fps deteksi secara jujur.
   */
  public lastSkipped = false;
  /**
   * #65: ambang yang diset SEBELUM worker ada (mis. slider digeser saat
   * status masih "loading") — dikirim ke worker begitu init() membuatnya.
   */
  private pendingThreshold: number | null = null;

  /**
   * #65: ubah ambang confidence live (0,1–0,9) — diteruskan ke worker,
   * berlaku untuk inferensi BERIKUTNYA. Aman dipanggil sebelum init()
   * selesai: nilai ditahan di pendingThreshold lalu dikirim saat worker
   * dibuat (urutan postMessage terjaga: init dulu, baru set-threshold).
   */
  setThreshold(threshold: number): void {
    const clamped = Math.min(0.9, Math.max(0.1, threshold));
    this.pendingThreshold = clamped;
    if (this.worker && !this.disposed) {
      const req: WorkerRequest = { type: "set-threshold", threshold: clamped };
      this.worker.postMessage(req);
    }
  }

  /** Buat worker + muat model. Melempar bila model gagal dimuat. */
  async init(opts: {
    modelUrl: string;
    labels: string[];
    fallbackUrl: string;
    wasmBase: string;
  }): Promise<void> {
    this.disposeSync();
    this.disposed = false;
    this.lastError = "";

    this.worker = new Worker(new URL("./detection.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      this.onWorkerMessage(e.data);
    };
    this.worker.onerror = (e: ErrorEvent) => {
      this.lastError = e.message || "Worker error tak dikenal";
      this.readyReject?.(new Error(this.lastError));
    };

    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const req: WorkerRequest = {
      type: "init",
      modelUrl: opts.modelUrl,
      fallbackUrl: opts.fallbackUrl,
      wasmBase: opts.wasmBase,
    };
    this.worker.postMessage(req);
    // #65: kirim ambang yang mungkin sudah diset sebelum init
    // (urutan postMessage terjaga — init diproses worker lebih dulu).
    if (this.pendingThreshold !== null) {
      const tReq: WorkerRequest = {
        type: "set-threshold",
        threshold: this.pendingThreshold,
      };
      this.worker.postMessage(tReq);
    }
    await this.ready;
  }

  /**
   * Satu frame video → Detection[] (dengan trackId + direction dari worker).
   * TIDAK melempar: galat → [] (kontrak).
   */
  async detect(frame: ImageData | HTMLVideoElement): Promise<Detection[]> {
    // Default: BUKAN hasil inferensi (di-skip / video belum ada data) —
    // hook memakai flag ini agar fps & overlay hanya dari hasil worker nyata.
    this.lastSkipped = true;
    try {
      if (this.disposed || !this.worker || this.inflight) return [];
      if (!(frame instanceof HTMLVideoElement)) return [];
      if (frame.readyState < 2 || frame.videoWidth === 0) return [];
      this.lastSkipped = false; // lolos semua guard → inferensi beneran

      const bitmap = await createImageBitmap(frame);
      this.inflight = true;
      const result = await new Promise<DetectionFrame>((resolve) => {
        // Pengaman: worker tak membalas dalam 8 dtk → anggap gagal, jangan macet.
        const timer = window.setTimeout(() => {
          this.pendingResult = null;
          resolve({ cameraId: "", framePts: 0, wallTime: 0, detections: [] });
        }, 8000);
        this.pendingResult = (f) => {
          window.clearTimeout(timer);
          resolve(f);
        };
        const req: WorkerRequest = {
          type: "detect",
          frame: bitmap,
          srcW: frame.videoWidth,
          srcH: frame.videoHeight,
          framePts: frame.currentTime,
          cameraId: "",
        };
        this.worker?.postMessage(req, [bitmap]);
      });
      return result.detections;
    } catch {
      return [];
    } finally {
      this.inflight = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposeSync();
  }

  // ---------- internal ----------

  private onWorkerMessage(msg: WorkerResponse): void {
    if (msg.type === "ready") {
      this.readyResolve?.();
      this.readyResolve = this.readyReject = null;
    } else if (msg.type === "init-error") {
      this.lastError = msg.message;
      this.readyReject?.(new Error(msg.message));
      this.readyResolve = this.readyReject = null;
    } else if (msg.type === "result") {
      const resolve = this.pendingResult;
      this.pendingResult = null;
      resolve?.(msg.frame);
    }
  }

  private disposeSync(): void {
    this.disposed = true;
    this.inflight = false;
    this.pendingResult = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = null;
    this.readyResolve = this.readyReject = null;
  }
}
