// Detection Worker — inferensi YOLO26n + tracking di thread terpisah.
// Rujukan #60: "Deteksi boleh 10-15 fps asal video 60fps tidak block."
// Inferensi WASM di main thread akan menghabiskan event loop (UI jank),
// maka seluruh pipeline deteksi tinggal di sini; main thread hanya menggambar.
//
// Catatan TS: file ini TIDAK memakai `/// <reference lib="webworker" />`
// (konflik deklarasi `self` dengan lib DOM) — sebagai gantinya `self`
// di-cast ke tipe lokal minimal di bawah. OffscreenCanvas & ImageBitmap
// sudah ada di lib DOM, jadi tidak butuh lib tambahan.

import { OnnxVehicleDetector } from "./onnxDetector";
import { ByteTracker } from "./tracker";
import { COCO_TO_VEHICLE, DETECTOR_PARSE_FLOOR } from "./vehicleConfig";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

interface WorkerSelf {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}

const workerSelf = self as unknown as WorkerSelf;

const detector = new OnnxVehicleDetector();
// #74: CentroidTracker DIGANTI ByteTracker (Kalman + asosiasi IoU dua tahap).
const tracker = new ByteTracker();
let ready = false;
let busy = false;
let resetVersion = 0;
let lastPts = -1;
let lastSize = "";

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  workerSelf.postMessage(msg, transfer);
}

workerSelf.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "reset") {
    resetVersion++;
    tracker.reset();
    lastPts = -1;
    return;
  }
  if (msg.type === "init") {
    void handleInit(msg.modelUrl, msg.fallbackUrl, msg.wasmBase);
    return;
  }
  if (msg.type === "detect") {
    // Frame baru saat masih sibuk = DITOLAK EKSPLISIT (MAX_INFLIGHT=1, tanpa
    // antrean). #68: dulu dibuang diam-diam (frame.close() tanpa respons) →
    // promise main thread menggantung sampai timeout → fps palsu. Kini worker
    // membalas "dropped" agar main thread langsung tahu ini BUKAN hasil.
    if (!ready || busy) {
      msg.frame.close();
      post({ type: "dropped", requestId: msg.requestId });
      return;
    }
    busy = true;
    void handleDetect(msg).finally(() => {
      busy = false;
    });
  }
};

/** Muat model utama; fallback dicoba bila URL-nya dikonfigurasi. */
async function handleInit(
  modelUrl: string,
  fallbackUrl: string,
  wasmBase: string,
): Promise<void> {
  tracker.reset();
  const labels = Object.values(COCO_TO_VEHICLE);
  try {
    // #74: kunci parser model di lantai rendah — ByteTrack tahap-2 butuh
    // deteksi low-confidence (re-identifikasi). Ambang "tinggi" diatur
    // terpisah di tracker via pesan "set-threshold".
    detector.setThreshold(DETECTOR_PARSE_FLOOR);
    await detector.initWithWasm({ modelUrl, labels }, wasmBase);
    ready = true;
    // #68: sertakan execution provider terpilih (webgl|wasm) untuk chip UI.
    post({ type: "ready", modelUrl, provider: detector.provider, benchmarks: detector.benchmarks });
  } catch (err) {
    const primaryMsg = err instanceof Error ? err.message : String(err);
    // Fallback: hanya bila URL fallback dikonfigurasi (saat ini "" — lihat
    // vehicleConfig.modelFallbackUrl). Parser fallback memakai kontrak output
    // YOLO yang sama; model non-YOLO (mis. PicoDet) butuh parser sendiri
    // setelah format export-nya terverifikasi — JANGAN dipaksakan.
    if (fallbackUrl) {
      try {
        await detector.initWithWasm({ modelUrl: fallbackUrl, labels }, wasmBase);
        ready = true;
        post({ type: "ready", modelUrl: fallbackUrl, provider: detector.provider, benchmarks: detector.benchmarks });
        return;
      } catch {
        // pesan galat utama yang dilaporkan
      }
    }
    post({ type: "init-error", message: primaryMsg });
  }
}

async function handleDetect(
  msg: Extract<WorkerRequest, { type: "detect" }>,
): Promise<void> {
  const { frame, srcW, srcH, framePts, cameraId } = msg;
  // #68: ukur biaya SATU putaran worker (letterbox + inferensi + tracking)
  // agar bottleneck fps terbaca dari UI, bukan tebakan.
  const t0 = performance.now();
  const version = resetVersion;
  try {
    const timestamp = Date.now();
    const raw = await detector.inferFromBitmap(frame, srcW, srcH, timestamp);
    if (version !== resetVersion) {
      post({ type: "dropped", requestId: msg.requestId });
      return;
    }
    const size = `${srcW}x${srcH}`;
    if (framePts <= lastPts || (lastPts >= 0 && framePts - lastPts > 3) || size !== lastSize) tracker.reset();
    lastPts = framePts;
    lastSize = size;
    // #68: framePts diteruskan ke tracker = basis waktu velocity & prediksi.
    const tracked = tracker.update(raw, framePts, { width: srcW, height: srcH });
    post({
      type: "result",
      requestId: msg.requestId,
      frame: {
        cameraId,
        framePts,
        wallTime: timestamp,
        detections: tracked,
        rejectedDetections: tracker.rejectedDetections,
        inferMs: Math.round(performance.now() - t0),
      },
    });
  } catch (err) {
    // inferFromBitmap melempar hanya bila model rusak/frame invalid —
    // kirim frame kosong agar overlay tidak macet di kotak lama.
    post({ type: "detect-error", requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err) });
  } finally {
    frame.close();
  }
}
