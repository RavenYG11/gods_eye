// Pembungkus worker → memenuhi kontrak Detector untuk main thread.
// Dashboard TIDAK PERNAH import onnxDetector langsung (arsitektur §2:
// dashboard hanya bicara lewat DetectionPort).
//
// Pola: 1 worker, 1 inferensi dalam penerbangan (MAX_INFLIGHT). detect()
// menolak frame baru selama inferensi berjalan (resolve []), bukan mengantre
// — antrean = latensi menumpuk = overlay makin tertinggal dari video.

import type { DetectionFrame, Detector, DetectOutcome } from "./types";
import type { TrackedDetection } from "./tracker";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";
import { CAPTURE_RESIZE_HEIGHT, CAPTURE_RESIZE_WIDTH } from "./vehicleConfig";

export class WorkerVehicleDetector implements Detector {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  /**
   * #76: slot hasil menunggu — SATU per panggilan aktif (MAX_INFLIGHT=1),
   * diikat request ID. Respons dengan id tak cocok (basi, mis. tiba
   * setelah timeout) DIABAIKAN, bukan diterapkan ke panggilan baru.
   */
  private pending: {
    id: number;
    resolve: (frame: DetectionFrame | null, skipped: boolean) => void;
  } | null = null;
  private nextId = 1;
  private inflight = false;
  private disposed = false;
  /**
   * #76: GENERASI TIMELINE — dinaikkan hook tiap diskontinuitas
   * currentTime (event 'seeking': scrub user, guard DVR, seek internal
   * hls.js). detect() mengabadikan nilainya ke outcome.generation; hook
   * membuang hasil yang generasinya sudah kedaluwarsa (timeline lama
   * tidak boleh diterapkan ke timeline baru).
   */
  public currentGeneration = 0;
  /** Pesan galat terakhir dari worker (untuk UI). */
  public lastError = "";
  /**
   * LEGACY (#76): flag bersama ini dipertahankan untuk kompatibilitas baca,
   * tetapi KEPUTUSAN "apakah ini hasil valid" TIDAK LAGI diambil darinya —
   * hook memakai DetectOutcome per panggilan (lihat DetectOutcome di
   * types.ts; akar bug audit A). Nilai di sini mencerminkan panggilan
   * TERAKHIR yang selesai/diproses.
   */
  public lastSkipped = false;
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
   * #76: statistik panggilan detect() KUMULATIF sejak init — untuk
   * diagnostik/QA (berapa panggilan yang benar-benar jadi inferensi vs
   * dilewati vs timeout). Dibaca via window.__godsEye.getDetection().stats.
   */
  public readonly stats = { calls: 0, inferStarted: 0, skipped: 0, timedOut: 0, ok: 0 };
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
   * Satu frame video → DetectOutcome (dengan trackId + direction dari worker).
   * TIDAK melempar: galat → outcome skipped (kontrak).
   *
   * #76 — PERBAIKAN AKAR BUG AUDIT A ("hasil deteksi valid dibuang karena
   * flag bersama"). SEBELUM: status hasil disimpan di flag instance
   * (lastSkipped/lastTimedOut) yang dipakai BERSAMA semua panggilan.
   * Skenario nyata: tick-1 lolos guard (lastSkipped=false, inflight=true,
   * menunggu hasil); tick-2 (100 ms kemudian) memanggil detect() → baris
   * pertama method menimpa lastSkipped=true → guard inflight → return [].
   * Saat hasil tick-1 tiba, hook membaca detector.lastSkipped === true →
   * HASIL VALID DIBUANG → overlay mempertahankan box lama (diam/melompat).
   * SESUDAH: tiap panggilan mengembalikan outcome-nya sendiri
   * {detections, skipped, timedOut, inferMs, generation} — skip milik
   * tick-2 tidak bisa meracuni hasil tick-1. Flag instance hanya legacy.
   */
  async detect(frame: ImageData | HTMLVideoElement): Promise<DetectOutcome> {
    const generation = this.currentGeneration;
    const skippedOutcome = (): DetectOutcome => ({
      detections: [],
      skipped: true,
      timedOut: false,
      inferMs: null,
      generation,
    });
    // Default legacy: bukan hasil inferensi.
    this.lastSkipped = true;
    this.lastTimedOut = false;
    this.stats.calls++;
    // #76: HANYA panggilan yang memasang inflight boleh melepasnya.
    // Bug yang diperbaiki: finally tak bersyarat me-reset inflight milik
    // panggilan lain — tick yang di-skip guard (return dini) ikut
    // menjalankan finally → inflight panggilan yang sedang jalan terhapus →
    // tick berikutnya lolos guard → pending tertimpa → SEMUA hasil jadi
    // "basi" (id tak cocok) dan dibuang → deteksi tak pernah tampil.
    let releaseInflight = false;
    try {
      if (this.disposed || !this.worker || this.inflight) { this.stats.skipped++; return skippedOutcome(); }
      if (!(frame instanceof HTMLVideoElement)) { this.stats.skipped++; return skippedOutcome(); }
      if (frame.readyState < 2 || frame.videoWidth === 0) { this.stats.skipped++; return skippedOutcome(); }
      this.lastSkipped = false; // lolos semua guard → inferensi beneran
      this.stats.inferStarted++;

      // #75: inflight dipasang SINKRON sebelum await pertama (perbaikan race
      // antar-tick: dua tick tak bisa lagi sama-sama lolos guard).
      this.inflight = true;
      releaseInflight = true;

      // #76: framePts dibaca SEBELUM createImageBitmap — bitmap
      // merepresentasikan frame pada saat capture dipanggil; currentTime
      // yang dibaca setelah await bisa sudah bergeser.
      const framePts = frame.currentTime;

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
      // #74: dimensi bitmap DIBEKUKAN di sini — setelah postMessage + transfer,
      // bitmap di-neuter (tidak bisa dibaca lagi), padahal dibutuhkan untuk
      // skala ruang koordinat di bawah.
      const bmpW = bitmap.width;
      const bmpH = bitmap.height;
      const id = this.nextId++;
      const outcome = await new Promise<DetectOutcome>((resolve) => {
        // Pengaman: worker tak membalas dalam TIMEOUT_MS → anggap macet.
        // #68: JANGAN hitung sebagai hasil — hook mengabaikannya agar fps
        // jujur dan overlay tidak dibersihkan.
        const timer = window.setTimeout(() => {
          // Hanya berlaku bila slot ini masih milik panggilan ini
          // (tak mungkin tertukar berkat guard inflight, tapi jaga-jaga).
          if (this.pending?.id !== id) return;
          this.pending = null;
          this.lastTimedOut = true;
          this.stats.timedOut++;
          resolve({
            detections: [],
            skipped: false,
            timedOut: true,
            inferMs: null,
            generation,
          });
        }, WorkerVehicleDetector.TIMEOUT_MS);
        this.pending = {
          id,
          resolve: (f, skipped) => {
            window.clearTimeout(timer);
            if (skipped || !f) {
              this.lastSkipped = true;
              this.stats.skipped++;
              resolve(skippedOutcome());
              return;
            }
            // #74 — PERBAIKAN RUANG KOORDINAT: sejak #68 frame ditangkap
            // 960×540, bbox + velocity keluar worker dalam piksel RUANG
            // BITMAP, tetapi DetectionOverlay menggambar dengan skala
            // canvas/videoWidth (ruang video, mis. 1920×1080) → box
            // setengah ukuran & bergeser. Tracker tetap bekerja di ruang
            // bitmap (konsisten internal); yang diskala ke ruang video
            // hanya OUTPUT ke overlay. Fallback capture-penuh → kx=ky=1.
            const kx = frame.videoWidth / bmpW;
            const ky = frame.videoHeight / bmpH;
            if (
              Number.isFinite(kx) &&
              Number.isFinite(ky) &&
              kx > 0 &&
              ky > 0 &&
              f.detections.length > 0
            ) {
              for (const d of f.detections) {
                const t = d as TrackedDetection;
                const [x, y, w, h] = t.bbox;
                t.bbox = [x * kx, y * ky, w * kx, h * ky];
                if (typeof t.vx === "number") {
                  t.vx *= kx;
                  t.vy *= ky;
                }
              }
            }
            const inferMs = f.inferMs ?? null;
            this.lastInferMs = inferMs;
            this.lastSkipped = false;
            this.stats.ok++;
            resolve({
              detections: f.detections,
              skipped: false,
              timedOut: false,
              inferMs,
              generation,
            });
          },
        };
        const req: WorkerRequest = {
          type: "detect",
          id,
          frame: bitmap,
          // #68: dimensi BITMAP AKTUAL (bisa 960×540 bila resize aktif) —
          // worker me-letterbox dari ukuran ini, bukan ukuran video.
          srcW: bmpW,
          srcH: bmpH,
          framePts,
          cameraId: "",
        };
        this.worker?.postMessage(req, [bitmap]);
      });
      return outcome;
    } catch {
      this.stats.skipped++;
      return skippedOutcome();
    } finally {
      if (releaseInflight) this.inflight = false;
    }
  }

  /**
   * #76: kosongkan track di worker — dipanggil hook saat diskontinuitas
   * timeline (event 'seeking'). Fire-and-forget.
   */
  resetTracker(): void {
    if (this.worker && !this.disposed) {
      const req: WorkerRequest = { type: "reset-tracker" };
      this.worker.postMessage(req);
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
      // #76: cocokkan ID — respons basi (tiba setelah timeout, saat slot
      // pending sudah dipakai panggilan lain) DIABAIKAN, bukan diterapkan
      // ke timeline baru.
      const p = this.pending;
      if (!p || p.id !== msg.id) return;
      this.pending = null;
      p.resolve(msg.frame, false);
    } else if (msg.type === "dropped") {
      // #68: worker menolak frame karena masih sibuk — BUKAN hasil inferensi.
      // #76: id dicocokkan seperti "result".
      const p = this.pending;
      if (!p || p.id !== msg.id) return;
      this.pending = null;
      this.lastSkipped = true;
      p.resolve(null, true);
    }
  }

  private disposeSync(): void {
    this.disposed = true;
    this.inflight = false;
    // #76: jangan tinggalkan promise menggantung — selesaikan sebagai skip.
    const p = this.pending;
    this.pending = null;
    p?.resolve(null, true);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = null;
    this.readyResolve = this.readyReject = null;
  }
}
