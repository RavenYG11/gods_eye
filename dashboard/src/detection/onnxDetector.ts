// Implementasi kontrak Detector (detection/types.ts) dengan YOLO26n ONNX.
// Rujukan fakta: riset #48 — input 640×640, output [1,300,6] NMS-free.
//
// File ini dirancang untuk jalan DI DALAM Web Worker (detection.worker.ts)
// agar inferensi tidak memblokir video 60fps di main thread. Ia tidak memakai
// `document` — hanya OffscreenCanvas (tersedia di worker & main thread).
//
// Thread WASM: ORT_NUM_THREADS (vehicleConfig) — butuh COOP/COEP (lihat
// backend/server.js). Tanpa cross-origin isolation ORT otomatis turun ke
// 1 thread; deteksi tetap jalan, hanya lebih lambat.

import type { Detection, Detector } from "./types";
import {
  imageDataToNchw,
  letterboxParams,
  parseYolo26nOutput,
} from "./yolo26n";
import {
  CONFIDENCE_THRESHOLD,
  MODEL_INPUT_SIZE,
  ORT_EXECUTION_PROVIDERS,
  ORT_NUM_THREADS,
} from "./vehicleConfig";

// Tipe minimal dari onnxruntime-web — import dinamis di init() agar bundle
// utama tetap ramping dan kegagalan load tidak meruntuhkan modul ini.
type OrtModule = typeof import("onnxruntime-web");

const WARMUP_NOTE =
  "warmup gagal — file model mungkin korup atau bukan YOLO26n " +
  "(bila memakai VITE_DETECTOR_MODEL: model custom WAJIB hasil export " +
  "ultralytics YOLO26n dengan output [1,300,6])";

export class OnnxVehicleDetector implements Detector {
  private ort: OrtModule | null = null;
  private session: import("onnxruntime-web").InferenceSession | null = null;
  private inputName = "";
  private outputName = "";
  private canvas: OffscreenCanvas | null = null;
  private warmedUp = false;
  /**
   * #65: ambang confidence AKTIF — dipakai parseYolo26nOutput pada tiap
   * inferensi. Diubah live via setThreshold() (slider UI 0,1–0,9).
   */
  private threshold: number = CONFIDENCE_THRESHOLD;
  /**
   * #68: execution provider yang akhirnya dipakai ("webgl" | "wasm") —
   * dibaca worker untuk pesan "ready" → tampil di chip UI (pengukuran).
   */
  public provider = "wasm";

  /**
   * #65: ubah ambang confidence — BERLAKU NYATA pada inferensi berikutnya
   * (diteruskan ke parseYolo26nOutput sebagai confidenceThreshold).
   * Nilai dijepit ke 0,1–0,9 sesuai kontrak slider UI.
   */
  setThreshold(threshold: number): void {
    this.threshold = Math.min(0.9, Math.max(0.1, threshold));
  }

  /**
   * Muat model. Melempar Error bila gagal (kontrak: init BOLEH melempar).
   * @param wasmBase URL basis folder file .wasm ORT, mis. "…/ort/".
   */
  async initWithWasm(
    opts: { modelUrl: string; labels: string[] },
    wasmBase: string,
  ): Promise<void> {
    const ort = await import("onnxruntime-web");
    this.ort = ort;

    // Multi-thread bila cross-origin isolated; bila tidak, ORT otomatis
    // memaksa 1 thread (peringatan di console) — deteksi tetap jalan.
    const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 1 : 1;
    ort.env.wasm.numThreads = Math.max(1, Math.min(ORT_NUM_THREADS, hw));
    if (wasmBase) {
      ort.env.wasm.wasmPaths = wasmBase; // wasm lokal (offline, base './'-aman)
    }

    // #68: rantai execution provider — dicoba BERURUTAN. "webgl" dulu: di
    // laptop dengan GPU (termasuk iGPU Intel) YOLO 640×640 umumnya 2–5×
    // lebih cepat daripada WASM; gagal → jatuh ke "wasm" (perilaku lama).
    // Dipilih eksplisit per-provider (bukan array sekaligus) agar kegagalan
    // satu provider tidak menggugurkan seluruh session — optimasi berbasis
    // pengukuran (inferMs tampil live di chip UI), bukan asumsi.
    const providers = [...ORT_EXECUTION_PROVIDERS];
    let lastErr: unknown = null;
    for (const ep of providers) {
      try {
        this.session = await ort.InferenceSession.create(opts.modelUrl, {
          executionProviders: [ep],
        });
        this.provider = ep;
        break;
      } catch (e) {
        lastErr = e;
        this.session = null;
      }
    }
    if (!this.session) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(
        `Gagal memuat model ONNX ${opts.modelUrl} (provider dicoba: ` +
          `${providers.join(", ")}): ${msg}`,
      );
    }

    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    if (!this.inputName || !this.outputName) {
      throw new Error("Model ONNX tidak punya input/output yang terbaca.");
    }

    // Warmup: validasi format output terhadap file model ASLI (bukan asumsi).
    await this.warmup();

    this.canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  }

  /** Kontrak Detector.init — dipakai bila detector dipakai di main thread. */
  async init(opts: { modelUrl: string; labels: string[] }): Promise<void> {
    // Tanpa wasmBase eksplisit: biarkan ORT memakai default (CDN). Di GODS EYE
    // selalu dipanggil via initWithWasm dari worker (wasm lokal, offline).
    await this.initWithWasm(opts, "");
  }

  /**
   * Inferensi dari ImageBitmap (jalur worker). Melempar bila model belum siap
   * — worker menangkapnya dan membalas init-error/result kosong.
   */
  async inferFromBitmap(
    bitmap: ImageBitmap,
    srcW: number,
    srcH: number,
    timestamp: number,
  ): Promise<Detection[]> {
    if (!this.session || !this.ort || !this.canvas) {
      throw new Error("Detector belum di-init.");
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d tidak tersedia.");

    // Letterbox: gambar diskala proporsional, sisa di-padding hitam.
    const lb = letterboxParams(srcW, srcH);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    ctx.drawImage(bitmap, lb.padX, lb.padY, srcW * lb.scale, srcH * lb.scale);

    const img = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const input = new this.ort.Tensor(
      "float32",
      imageDataToNchw(img),
      [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE],
    );
    const t0 = performance.now();
    const results = await this.session.run({ [this.inputName]: input });
    const inferMs = performance.now() - t0;

    const outTensor = results[this.outputName];
    const data = outTensor.data as ArrayLike<number>;
    void inferMs; // dicatat pemanggil bila perlu; bukan bagian kontrak
    return parseYolo26nOutput(data, {
      srcW,
      srcH,
      lb,
      timestamp,
      confidenceThreshold: this.threshold, // #65: ambang live dari slider
    });
  }

  /**
   * Kontrak Detector.detect — TIDAK boleh melempar saat stream jalan.
   * Dipakai bila detector dijalankan di main thread (bukan jalur utama #60).
   */
  async detect(frame: ImageData | HTMLVideoElement): Promise<Detection[]> {
    try {
      if (!this.session) return [];
      // Jalur utama #60 memakai inferFromBitmap via worker; detect() di sini
      // hanya untuk kompatibilitas kontrak.
      void frame;
      return [];
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.session?.release();
    } catch {
      // dispose tidak boleh melempar
    }
    this.session = null;
    this.ort = null;
    this.canvas = null;
    this.warmedUp = false;
  }

  /** Satu inferensi dummy untuk memastikan output = [1,300,6] (fail fast). */
  private async warmup(): Promise<void> {
    if (!this.session || !this.ort || this.warmedUp) return;
    const n = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
    const zeros = new Float32Array(3 * n);
    const input = new this.ort.Tensor("float32", zeros, [
      1,
      3,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE,
    ]);
    let dims: readonly number[] = [];
    try {
      const results = await this.session.run({ [this.inputName]: input });
      dims = results[this.outputName].dims;
    } catch (e) {
      throw new Error(
        `${WARMUP_NOTE}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const ok =
      dims.length === 3 && dims[0] === 1 && dims[1] === 300 && dims[2] === 6;
    if (!ok) {
      throw new Error(
        `${WARMUP_NOTE}: dims=[${dims.join(",")}], harapkan [1,300,6]. ` +
          `File bukan YOLO26n Ultralytics resmi.`,
      );
    }
    this.warmedUp = true;
  }
}
