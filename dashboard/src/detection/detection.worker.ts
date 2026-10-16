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

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  workerSelf.postMessage(msg, transfer);
}

workerSelf.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "init") {
    void handleInit(msg.modelUrl, msg.fallbackUrl, msg.wasmBase);
    return;
  }
  if (msg.type === "set-threshold") {
    // #74: pesan "set-threshold" dari slider UI kini mengatur ambang TAHAP-1
    // ByteTrack (deteksi "tinggi"), BUKAN threshold parser model. Parser
    // model dikunci di DETECTOR_PARSE_FLOOR (lihat handleInit) agar tahap-2
    // selalu punya deteksi low-confidence untuk re-identifikasi.
    tracker.setHighThreshold(msg.threshold);
    return;
  }
  if (msg.type === "detect") {
    // Frame baru saat masih sibuk = DITOLAK EKSPLISIT (MAX_INFLIGHT=1, tanpa
    // antrean). #68: dulu dibuang diam-diam (frame.close() tanpa respons) →
    // promise main thread menggantung sampai timeout → fps palsu. Kini worker
    // membalas "dropped" agar main thread langsung tahu ini BUKAN hasil.
    if (!ready || busy) {
      msg.frame.close();
      post({ type: "dropped" });
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
    post({ type: "ready", modelUrl, provider: detector.provider });
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
        post({ type: "ready", modelUrl: fallbackUrl, provider: detector.provider });
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
  try {
    const timestamp = Date.now();
    const raw = await detector.inferFromBitmap(frame, srcW, srcH, timestamp);
    // #68: framePts diteruskan ke tracker = basis waktu velocity & prediksi.
    const tracked = tracker.update(raw, framePts);
    post({
      type: "result",
      frame: {
        cameraId,
        framePts,
        wallTime: timestamp,
        detections: tracked,
        inferMs: Math.round(performance.now() - t0),
      },
    });
  } catch {
    // inferFromBitmap melempar hanya bila model rusak/frame invalid —
    // kirim frame kosong agar overlay tidak macet di kotak lama.
    post({
      type: "result",
      frame: {
        cameraId,
        framePts,
        wallTime: Date.now(),
        detections: [],
        inferMs: Math.round(performance.now() - t0),
      },
    });
  } finally {
    frame.close();
  }
}
