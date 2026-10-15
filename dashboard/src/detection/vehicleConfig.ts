// Rujukan: docs/arsitektur.md §2 · riset #48 (workspace/riset-object-detection/)
// SEMUA angka ajaib deteksi tinggal di file ini — bukan tersebar di kode.
// "FAKTA" = terverifikasi sumber resmi · "ASUMSI" = dilabeli eksplisit.

/** Ukuran input model (YOLO26n diekspor untuk 640×640). FAKTA: riset #48. */
export const MODEL_INPUT_SIZE = 640;

/**
 * Ambang kepercayaan minimum — di bawah ini kotak dibuang.
 * #62: default 0,5 (seimbang). Bukti: riset #48 §4.1 — default conf Ultralytics
 * 0,25 (dioptimalkan untuk mAP benchmark, bukan untuk tampilan live);
 * model NMS-free YOLO26n memancarkan 300 proposal/frame sehingga ambang rendah
 * membanjiri overlay dengan kotak borderline yang ikut berkedip. 0,5 memotong
 * sebagian besar false positive tanpa mengorbankan kendaraan jelas —
 * dan Rama bisa menggesernya live via slider di UI (range 0,1–0,9).
 */
export const CONFIDENCE_THRESHOLD = 0.5;

/** Target frame deteksi per detik (video 60fps TIDAK boleh block — §60). */
export const CAPTURE_FPS = 10;

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
