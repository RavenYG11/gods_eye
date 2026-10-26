/** Model and runtime policy; keep playback settings in lib/bufferPolicy.ts. */
export const MODEL_INPUT_SIZE = 640;
export const CONFIDENCE_THRESHOLD = 0.4;
export const CAPTURE_FPS = 10; // ceiling; actual rate depends on measured inference time
export const CAPTURE_RESIZE_WIDTH = 960;
export const MOTION_WIDTH = 640;
export const MOTION_FPS = 25;
// Fixed acceptance thresholds, NOT invented accuracy percentages. Weak model
// observations may sustain an already confirmed object through ByteTrack.
export const VEHICLE_POLICY = {
  mobil: { newTrackConfidence: 0.35 },
  motor: { newTrackConfidence: 0.25 },
} as const;
// Benchmark both GPU layouts: NHWC reduces convolution overhead on this camera's
// target device; the default layout and WASM remain measured fallbacks.
export const ORT_EXECUTION_PROVIDERS: readonly string[] = ["webgpu-nhwc", "webgpu", "wasm"];
export const ORT_NUM_THREADS = 2; // leave CPU capacity for decoding and the UI
export const DETECTOR_PARSE_FLOOR = 0.12;
export const COCO_TO_VEHICLE: Record<number, "mobil" | "motor"> = { 2: "mobil", 3: "motor" };
export const DIRECTION_COLORS = {
  atas: "#38bdf8", bawah: "#22c55e", unknown: "#94a3b8",
} as const;

export function modelUrl(base: string): string {
  const custom = (import.meta.env?.VITE_DETECTOR_MODEL as string | undefined)?.trim();
  return new URL(custom || "models/yolo26n.onnx", base).href;
}
export function modelFallbackUrl(_base: string): string { return ""; }
export function ortWasmBase(base: string): string { return new URL("ort/", base).href; }
export const YOLO26N_OFFICIAL_URL =
  "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx";
export const YOLO26N_EXPECTED_BYTES = 9_941_957;
