// Protokol pesan Main thread ⇄ Detection Worker.
// Semua yang lewat sini harus structured-cloneable (ImageBitmap bisa,
// dengan transfer list agar zero-copy).

import type { DetectionFrame } from "./types";

export type WorkerRequest =
  | {
      type: "init";
      /** URL file .onnx (utama). */
      modelUrl: string;
      /** URL fallback (PP-PicoDet-S, kelak) — "" = tidak ada. */
      fallbackUrl: string;
      /** URL basis folder ort/*.wasm. */
      wasmBase: string;
    }
  | {
      type: "detect";
      /** Frame video — DITRANSFER (tidak bisa dipakai lagi setelah post). */
      frame: ImageBitmap;
      srcW: number;
      srcH: number;
      framePts: number;
      cameraId: string;
    }
  | {
      type: "set-threshold";
      /**
       * #65: ambang confidence 0,1–0,9 — berlaku untuk inferensi
       * BERIKUTNYA (bukan frame yang sedang berjalan). Fire-and-forget.
       */
      threshold: number;
    };

export type WorkerResponse =
  | { type: "ready"; modelUrl: string }
  | { type: "init-error"; message: string }
  | { type: "result"; frame: DetectionFrame };
