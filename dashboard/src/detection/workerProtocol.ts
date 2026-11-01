import type { DetectionFrame } from "./types";

export type WorkerRequest =
  | { type: "init"; modelUrl: string; fallbackUrl: string; wasmBase: string }
  | { type: "detect"; requestId: number; frame: ImageBitmap; srcW: number;
      srcH: number; framePts: number; cameraId: string }
  | { type: "reset" };

export type WorkerResponse =
  | { type: "ready"; modelUrl: string; provider: string; benchmarks?: { provider: string; ms?: number; error?: string }[] }
  | { type: "init-error"; message: string }
  | { type: "result"; requestId: number; frame: DetectionFrame }
  | { type: "detect-error"; requestId: number; message: string }
  | { type: "dropped"; requestId: number };
