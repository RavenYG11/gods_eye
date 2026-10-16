// Pembungkus worker → memenuhi kontrak Detector untuk main thread.
// Dashboard TIDAK PERNAH import onnxDetector langsung (arsitektur §2:
// dashboard hanya bicara lewat DetectionPort).
//
// Pola: 1 worker, 1 inferensi dalam penerbangan (MAX_INFLIGHT). detect()
// menolak frame baru selama inferensi berjalan (resolve []), bukan mengantre
// — antrean = latensi menumpuk = overlay makin tertinggal dari video.

import type { Detection, DetectionFrame, Detector } from "./types";
import type { TrackedDetection } from "./tracker";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";
import { CAPTURE_RESIZE_HEIGHT, CAPTURE_RESIZE_WIDTH } from "./vehicleConfig";

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
   * #68: true bila detect() terakhir TIMEOUT (worker tidak membalas dalam
   * TIMEOUT_MS). Dulu timeout dihitung sebagai "hasil" → fps palsu 0,1 +
   * overlay dibersihkan tiap 8 dtk. Kini hook mengabaikannya seperti skip.
   */
  public lastTimedOut = false;
  /**
   * #68: execution provider ONNX terpilih ("webgl" | "wasm") — dari pesan
   * "ready" worker. Tampil di chip UI (pengukuran, bukan asumsi).
   */
  public lastProvider: string | null = null;
  /**
   * #68: biaya putaran worker terakhir (ms, dari DetectionFrame.inferMs) —
   * ditampilkan di chip UI untuk diagnosis bottleneck.
   */
  public lastInferMs: number | null = null;
  /**
   * #68: 8 dtk → 30 dtk. Timeout BUKAN lagi "hasil gagal rutin": dengan
   * respons "dropped" eksplisit dari worker, timeout kini hanya jaring
   * pengaman untuk worker yang benar-benar macet.
   */
  private static readonly TIMEOUT_MS = 30_000;
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
    // Default: BUKAN hasil inferensi (di-skip / timeout / video belum ada
    // data) — hook memakai flag ini agar fps & overlay hanya dari hasil
    // worker nyata.
    this.lastSkipped = true;
    this.lastTimedOut = false;
    try {
      if (this.disposed || !this.worker || this.inflight) return [];
      if (!(frame instanceof HTMLVideoElement)) return [];
      if (frame.readyState < 2 || frame.videoWidth === 0) return [];
      this.lastSkipped = false; // lolos semua guard → inferensi beneran

      // #68: tangkap frame dalam resolusi lebih kecil (960×540, bukan
      // 1920×1080). Dua penghematan: (a) transfer ImageBitmap antar-thread
      // 8MB → ±2MB per frame; (b) createImageBitmap di main thread lebih
      // cepat. TIDAK mengurangi detail input model: letterbox worker tetap
      // menskala ke 640×640 (isi efektif 640×360 — sama seperti dari 1080p),
      // hanya langkah resampling-nya dua tahap. Fallback ke capture penuh
      // bila browser tak mendukung opsi resize.
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(frame, {
          resizeWidth: CAPTURE_RESIZE_WIDTH,
          resizeHeight: CAPTURE_RESIZE_HEIGHT,
          resizeQuality: "high",
        });
      } catch {
        bitmap = await createImageBitmap(frame);
      }
      this.inflight = true;
      // #74: dimensi bitmap DIBEKUKAN di sini — setelah postMessage + transfer,
      // bitmap di-neuter (tidak bisa dibaca lagi), padahal dibutuhkan untuk
      // skala ruang koordinat di bawah.
      const bmpW = bitmap.width;
      const bmpH = bitmap.height;
      const result = await new Promise<DetectionFrame>((resolve) => {
        // Pengaman: worker tak membalas dalam TIMEOUT_MS → anggap macet.
        // #68: JANGAN hitung sebagai hasil (lastTimedOut) — hook akan
        // mengabaikannya agar fps jujur dan overlay tidak dibersihkan.
        const timer = window.setTimeout(() => {
          this.pendingResult = null;
          this.lastTimedOut = true;
          resolve({
            cameraId: "",
            framePts: 0,
            wallTime: 0,
            detections: [],
            inferMs: 0,
          });
        }, WorkerVehicleDetector.TIMEOUT_MS);
        this.pendingResult = (f) => {
          window.clearTimeout(timer);
          resolve(f);
        };
        const req: WorkerRequest = {
          type: "detect",
          frame: bitmap,
          // #68: dimensi BITMAP AKTUAL (bisa 960×540 bila resize aktif) —
          // worker me-letterbox dari ukuran ini, bukan ukuran video.
          srcW: bitmap.width,
          srcH: bitmap.height,
          framePts: frame.currentTime,
          cameraId: "",
        };
        this.worker?.postMessage(req, [bitmap]);
      });
      // #68: catat biaya worker untuk diagnosis — null bila timeout/drop/skip
      // (bukan hasil inferensi nyata).
      this.lastInferMs =
        this.lastTimedOut || this.lastSkipped ? null : (result.inferMs ?? null);
      // #74 — PERBAIKAN RUANG KOORDINAT (akar "box tidak ngelock", diagnosis
      // #74): sejak #68 frame ditangkap 960×540, bbox + velocity keluar worker
      // dalam piksel RUANG BITMAP, tetapi DetectionOverlay menggambar dengan
      // skala canvas/videoWidth (ruang video, mis. 1920×1080) → box setengah
      // ukuran & bergeser ke kiri-atas. Tracker tetap bekerja di ruang bitmap
      // (konsisten internal); yang diskala ke ruang video hanya OUTPUT ke
      // overlay. Pada fallback capture-penuh (bitmap = ukuran video),
      // kx = ky = 1 → no-op, aman.
      if (!this.lastTimedOut && !this.lastSkipped && result.detections.length > 0) {
        const kx = frame.videoWidth / bmpW;
        const ky = frame.videoHeight / bmpH;
        if (Number.isFinite(kx) && Number.isFinite(ky) && kx > 0 && ky > 0) {
          for (const d of result.detections) {
            const t = d as TrackedDetection;
            const [x, y, w, h] = t.bbox;
            t.bbox = [x * kx, y * ky, w * kx, h * ky];
            if (typeof t.vx === "number") {
              t.vx *= kx;
              t.vy *= ky;
            }
          }
        }
      }
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
      // #68: catat execution provider terpilih untuk chip UI.
      this.lastProvider = msg.provider ?? null;
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
    } else if (msg.type === "dropped") {
      // #68: worker menolak frame karena masih sibuk — BUKAN hasil inferensi.
      // Tandai skipped agar hook mengabaikannya (dulu: menggantung sampai
      // timeout → dihitung "hasil" → fps palsu 0,1).
      this.lastSkipped = true;
      const resolve = this.pendingResult;
      this.pendingResult = null;
      resolve?.({
        cameraId: "",
        framePts: 0,
        wallTime: 0,
        detections: [],
        inferMs: 0,
      });
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
