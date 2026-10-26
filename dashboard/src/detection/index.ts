// Public detection contract. YOLO association and visual motion use separate workers.
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
