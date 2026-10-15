// Helper MURNI (tanpa DOM, tanpa ONNX Runtime) untuk pipeline YOLO26n.
// Rujukan fakta: workspace/riset-object-detection/riset-yolo-vs-kandidat.md
//   - input 640×640 · output [1, 300, 6] = [x1, y1, x2, y2, skor, kelas],
//     NMS-free (format diverifikasi langsung dari file .onnx asli, 15 Okt 2026).
// Karena murni, file ini bisa diuji di Node tanpa browser (lihat qa/).

import {
  COCO_TO_VEHICLE,
  CONFIDENCE_THRESHOLD,
  MODEL_INPUT_SIZE,
  TRUCK_BIG_AREA_RATIO,
} from "./vehicleConfig";
import type { Detection } from "./types";

/** Hasil letterbox: skala + offset padding agar koordinat bisa dikembalikan. */
export interface Letterbox {
  scale: number;
  padX: number;
  padY: number;
}

/** Hitung transformasi letterbox: frame srcW×srcH → kanvas 640×640. */
export function letterboxParams(srcW: number, srcH: number): Letterbox {
  const scale = Math.min(
    MODEL_INPUT_SIZE / srcW,
    MODEL_INPUT_SIZE / srcH,
  );
  const padX = (MODEL_INPUT_SIZE - srcW * scale) / 2;
  const padY = (MODEL_INPUT_SIZE - srcH * scale) / 2;
  return { scale, padX, padY };
}

/** Kembalikan satu titik dari ruang 640 (letterbox) ke piksel frame sumber. */
export function unletterbox(
  x: number,
  y: number,
  lb: Letterbox,
): { x: number; y: number } {
  return { x: (x - lb.padX) / lb.scale, y: (y - lb.padY) / lb.scale };
}

/**
 * Pecah "truk" → "truk kecil" | "truk besar" berdasar luas relatif.
 * ASUMSI: lihat TRUCK_BIG_AREA_RATIO di vehicleConfig.ts.
 */
export function splitTruckLabel(
  bbox: [number, number, number, number],
  frameW: number,
  frameH: number,
): "truk kecil" | "truk besar" {
  const area = bbox[2] * bbox[3];
  const ratio = area / (frameW * frameH);
  return ratio >= TRUCK_BIG_AREA_RATIO ? "truk besar" : "truk kecil";
}

/**
 * Parse output mentah YOLO26n [1, 300, 6] → Detection[] dalam piksel frame sumber.
 * Tiap baris = [x1, y1, x2, y2, skor, classId] dalam koordinat 640 letterbox.
 * NMS-free: skor & kelas sudah final — TIDAK ada NMS di sini (riset #48).
 */
export function parseYolo26nOutput(
  data: ArrayLike<number>,
  opts: {
    srcW: number;
    srcH: number;
    lb: Letterbox;
    timestamp: number;
    confidenceThreshold?: number;
  },
): Detection[] {
  const threshold = opts.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
  const out: Detection[] = [];
  const ROWS = 300;
  const COLS = 6;

  for (let i = 0; i < ROWS; i++) {
    const base = i * COLS;
    const score = data[base + 4];
    if (!(score >= threshold)) continue; // NaN pun gugur di sini

    const classId = Math.round(data[base + 5]);
    const vehicle = COCO_TO_VEHICLE[classId];
    if (!vehicle) continue; // bukan motor/mobil/truk → buang (scope #60)

    const p1 = unletterbox(data[base], data[base + 1], opts.lb);
    const p2 = unletterbox(data[base + 2], data[base + 3], opts.lb);

    // Jepit ke dalam frame + pastikan x2>x1, y2>y1 (koordinat liar = buang).
    const x = Math.max(0, Math.min(p1.x, p2.x));
    const y = Math.max(0, Math.min(p1.y, p2.y));
    const x2 = Math.min(opts.srcW, Math.max(p1.x, p2.x));
    const y2 = Math.min(opts.srcH, Math.max(p1.y, p2.y));
    const w = x2 - x;
    const h = y2 - y;
    if (w <= 2 || h <= 2) continue;

    const bbox: [number, number, number, number] = [x, y, w, h];
    const label =
      vehicle === "truk"
        ? splitTruckLabel(bbox, opts.srcW, opts.srcH)
        : vehicle;

    out.push({
      classId,
      label,
      confidence: score,
      bbox,
      timestamp: opts.timestamp,
    });
  }
  return out;
}

/**
 * Preprocess: ImageData 640×640 RGBA → Float32Array NCHW ternormalisasi 0..1.
 * Layout NCHW = yang diharapkan model Ultralytics (riset #48 paket i5).
 */
export function imageDataToNchw(img: ImageData): Float32Array {
  const n = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const out = new Float32Array(3 * n);
  const px = img.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = px[o] / 255; // R
    out[n + i] = px[o + 1] / 255; // G
    out[2 * n + i] = px[o + 2] / 255; // B
  }
  return out;
}
