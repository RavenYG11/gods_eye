// Rujukan: docs/arsitektur.md §2 · riset #48 (workspace/riset-object-detection/)
// SEMUA angka ajaib deteksi tinggal di file ini — bukan tersebar di kode.
// "FAKTA" = terverifikasi sumber resmi · "ASUMSI" = dilabeli eksplisit.

/** Ukuran input model (YOLO26n diekspor untuk 640×640). FAKTA: riset #48. */
export const MODEL_INPUT_SIZE = 640;

/**
 * Ambang kepercayaan minimum — di bawah ini kotak dibuang.
 * #62: default 0,5 (seimbang). #68: 0,5 → 0,4 — BUKTI dari screenshot Rama
 * (15 Okt 2026, CCTV malam): kendaraan JELAS terdeteksi di 51–54% (hampir
 * gugur), kendaraan agak jauh/gelap skor 0,3–0,5 → "akurasi <10%" yang
 * dikeluhkan Rama sebagian besar adalah kendaraan NYATA yang skornya di
 * bawah 0,5, bukan model gagal total. 0,4 menangkapnya; false positive
 * tambahan diredam graceFrames + prediksi tracker, dan Rama bisa menggeser
 * live via slider (0,1–0,9). Bila box palsu mengganggu → naikkan lagi.
 * Riset #48 §4.1: default Ultralytics 0,25 (untuk mAP benchmark); 0,4 adalah
 * kompromi tampilan-live untuk CCTV malam.
 */
export const CONFIDENCE_THRESHOLD = 0.4;

/** Target frame deteksi per detik (video 60fps TIDAK boleh block — §60). */
export const CAPTURE_FPS = 10;

/**
 * #68: rantai execution provider ONNX Runtime — dicoba BERURUTAN, yang
 * pertama berhasil dipakai untuk semua inferensi berikutnya.
 * "webgl" dulu: di laptop dengan GPU (termasuk iGPU Intel) inferensi YOLO
 * 640×640 umumnya 2–5× lebih cepat daripada WASM multi-thread; bila WebGL
 * tak tersedia atau gagal, otomatis jatuh ke "wasm" (perilaku lama).
 * Provider terpilih dicatat di log worker + chip deteksi — optimasi
 * berbasis PENGUKURAN (inferMs tampil live di UI), bukan asumsi.
 */
export const ORT_EXECUTION_PROVIDERS: readonly string[] = ["webgl", "wasm"];

/**
 * #68: tangkap frame video dalam resolusi lebih kecil (960×540, bukan
 * 1920×1080). Dua penghematan: (a) transfer ImageBitmap antar-thread
 * 8MB → ±2MB per frame; (b) waktu createImageBitmap di main thread turun.
 * TIDAK mengurangi detail input model: letterbox tetap menskala ke
 * 640×640 (isi efektif 640×360 — sama seperti dari 1080p), hanya langkah
 * resampling-nya dua tahap. Bila createImageBitmap(resize) gagal di
 * browser tertentu, otomatis fallback ke capture penuh.
 */
export const CAPTURE_RESIZE_WIDTH = 960;
export const CAPTURE_RESIZE_HEIGHT = 540;

/**
 * Thread WASM ONNX Runtime.
 * FAKTA: onnxruntime-web ≥1.30 hanya menyediakan build threaded → butuh
 * SharedArrayBuffer → butuh header COOP/COEP (dipasang di backend/server.js
 * dan vite.config.ts, pola Ventra 2026-10-14). Tanpa COOP/COEP, ORT otomatis
 * memaksa 1 thread (peringatan di console) — deteksi tetap jalan, lebih lambat.
 */
export const ORT_NUM_THREADS = 4;

/** Maksimum 1 inferensi berjalan — frame baru dilewati bila worker sibuk. */
export const MAX_INFLIGHT = 1;

/**
 * Pemetaan class-id COCO → label kendaraan GODS EYE.
 * FAKTA: YOLO26n dilatih di COCO 80 kelas (Ultralytics); id 2 = car,
 * id 3 = motorcycle (konvensi COCO baku).
 * #62 (koreksi Rama, 15 Okt 2026): HANYA motor & mobil. Kelas truk (id 7)
 * DIHAPUS TOTAL — logika split "truk kecil/besar" (TRUCK_BIG_AREA_RATIO)
 * ikut dibuang, bukan sekadar disembunyikan.
 */
export const COCO_TO_VEHICLE: Record<number, "mobil" | "motor"> = {
  2: "mobil",
  3: "motor",
};

/** Warna box overlay per arah (kontrak visual #60 — JANGAN diubah diam-diam). */
export const DIRECTION_COLORS = {
  atas: "#38bdf8", // BIRU = kendaraan ke ATAS
  bawah: "#22c55e", // HIJAU = kendaraan ke BAWAH
  unknown: "#94a3b8", // abu-abu = arah belum pasti
} as const;

/** URL model & wasm dihitung dari base dokumen agar tahan base './'. */
export function modelUrl(base: string): string {
  return new URL("models/yolo26n.onnx", base).href;
}

/** Slot fallback PP-PicoDet-S (#60): diisi setelah file .onnx + format
 *  outputnya TERVERIFIKASI. Sampai saat itu string kosong = tidak dipakai. */
export function modelFallbackUrl(_base: string): string {
  return "";
}

/** Folder file .wasm ONNX Runtime (disalin saat build — scripts/copy-ort-wasm.mjs). */
export function ortWasmBase(base: string): string {
  return new URL("ort/", base).href;
}

/**
 * URL resmi bobot YOLO26n (dipakai scripts/unduh-model.*).
 * FAKTA: https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx
 * (9.941.957 byte — riset #48, diverifikasi 15 Okt 2026).
 */
export const YOLO26N_OFFICIAL_URL =
  "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx";
export const YOLO26N_EXPECTED_BYTES = 9_941_957;
