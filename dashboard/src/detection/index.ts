// Rujukan: docs/arsitektur.md §2
// #60 (15 Okt 2026): larangan deteksi DICABUT Rama → modul ini sekarang berisi
// implementasi nyata. ATURAN TETAP: dashboard hanya memakai apa yang
// diekspor dari file ini — TIDAK PERNAH import onnxDetector/worker langsung.
//
// Peta modul:
//   types.ts          kontrak data (Detection, DetectionFrame, Detector, DetectionPort)
//   vehicleConfig.ts  SEMUA angka ajaib + URL model
//   yolo26n.ts        helper murni: letterbox, parse output [1,300,6], preprocess
//   tracker.ts        ByteTracker: port TypeScript ByteTrack (ECCV 2022) —
//                     Kalman filter + asosiasi IoU dua tahap + birth/death +
//                     re-identifikasi (#74; menggantikan CentroidTracker #68)
//   onnxDetector.ts   implementasi Detector via ONNX Runtime (jalan di worker)
//   detection.worker.ts  worker: inferensi + tracking, 10fps, non-blocking
//   workerDetector.ts pembungkus worker → Detector untuk main thread
//   workerProtocol.ts bentuk pesan main ⇄ worker

export type {
  Detection,
  DetectionFrame,
  DetectionPort,
  Detector,
  VehicleDirection,
} from "./types";
export type { TrackedDetection, TrackerOptions } from "./tracker";
export {
  ByteTracker,
  DEFAULT_TRACKER_OPTIONS,
  PREDICT_CAP_S,
  predictBbox,
} from "./tracker";
export { WorkerVehicleDetector } from "./workerDetector";
export {
  CONFIDENCE_THRESHOLD,
  CAPTURE_FPS,
  DIRECTION_COLORS,
  modelUrl,
  modelFallbackUrl,
  ortWasmBase,
} from "./vehicleConfig";
