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
      /**
       * #76: ID unik per panggilan detect (monotonik dari main thread).
       * Digaungkan di "result"/"dropped" agar main thread bisa mencocokkan
       * respons dengan pekerjaan yang tepat — hasil basi (mis. tiba SETELAH
       * timeout 30 dtk, saat slot pending sudah dipakai panggilan baru)
       * diabaikan, bukan diterapkan ke timeline baru.
       */
      id: number;
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
    }
  /**
   * #76: kosongkan semua track ByteTrack di worker. Dikirim main thread
   * saat diskontinuitas timeline terdeteksi (event 'seeking' video —
   * scrub user, guard DVR, atau seek internal hls.js). Track lama
   * mereferensikan posisi/waktu timeline lama → harus dibuang, bukan
   * diteruskan. Fire-and-forget (tanpa respons).
   */
  | {
      type: "reset-tracker";
    };

export type WorkerResponse =
  | { type: "ready"; modelUrl: string; provider: string }
  | { type: "init-error"; message: string }
  /**
   * #76: id = gema dari WorkerRequest detect — main thread hanya menerima
   * hasil yang id-nya cocok dengan panggilan yang sedang menunggu.
   */
  | { type: "result"; id: number; frame: DetectionFrame }
  /**
   * #68: worker MASIH SIBUK saat frame baru tiba (MAX_INFLIGHT=1) — frame
   * dibuang dengan pemberitahuan eksplisit (dulu: dibuang DIAM-DIAM via
   * frame.close() tanpa respons → promise main thread menggantung sampai
   * timeout 8 dtk → tiap timeout dihitung sebagai "hasil" → fps palsu 0,1
   * + overlay dibersihkan. Lihat workerDetector.ts).
   * #76: id digemakan seperti "result".
   */
  | { type: "dropped"; id: number };
