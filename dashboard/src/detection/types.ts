// Rujukan: docs/arsitektur.md §2
// v0.1: modul ini hanya KONTRAK (detection-ready, agnostik-model).
// #60 (15 Okt 2026): larangan deteksi DICABUT Rama — modul ini sekarang berisi
// implementasi nyata YOLO26n via kontrak Detector/DetectionPort di bawah.
// Bobot model TIDAK di-commit (diunduh terpisah — lihat scripts/unduh-model.*).
//
// Skema JSON Broto (beku):
//   camera_id → cameraId · frame_pts → framePts · wall_time → wallTime/timestamp
//   conf → confidence · bbox_xywh → bbox

/**
 * Arah gerak kendaraan antar-frame, dari delta y centroid (tracker.ts).
 * "atas" = centroid bergerak ke atas frame · "bawah" = ke bawah frame.
 * "unknown" = belum cukup data gerak (belum bisa diklasifikasi).
 */
export type VehicleDirection = "atas" | "bawah" | "unknown";

/** Satu kotak deteksi — selaras dengan skema JSON Broto (beku). */
export interface Detection {
  classId: number; // ← class_id (Broto)
  label: string; // ← label: "motor" | "mobil" | "truk kecil" | "truk besar"
  confidence: number; // ← conf, 0..1
  bbox: [number, number, number, number]; // ← bbox_xywh: [x, y, w, h] piksel
  trackId?: number; // opsional — diisi tracker bila ada
  timestamp: number; // ← wall_time, epoch ms
  /**
   * EKSTENSI UI (bukan bagian skema Broto — tidak diserialisasi ke JSON).
   * Dipakai overlay untuk warna box: BIRU = "atas", HIJAU = "bawah".
   */
  direction?: VehicleDirection;
}

/** Satu frame hasil deteksi. */
export interface DetectionFrame {
  cameraId: string; // ← camera_id
  framePts: number; // ← frame_pts (presentation timestamp stream)
  wallTime: number; // ← wall_time
  detections: Detection[];
  /**
   * #68: DIAGNOSTIK INTERNAL (bukan skema Broto — tidak diserialisasi ke JSON).
   * Milidetik yang dihabiskan worker untuk SATU putaran detect (termasuk
   * letterbox + inferensi ONNX). Ditampilkan di chip UI agar bottleneck
   * fps bisa dibaca langsung dari screenshot Rama berikutnya.
   */
  inferMs: number;
}

/** Kontrak yang WAJIB dipenuhi implementasi model apapun (YOLO26n, PicoDet, dst). */
export interface Detector {
  /** Muat model sekali di awal. Melempar Error bila gagal. */
  init(opts: { modelUrl: string; labels: string[] }): Promise<void>;
  /** Satu frame video → daftar kotak. TIDAK boleh melempar saat stream jalan. */
  detect(frame: ImageData | HTMLVideoElement): Promise<Detection[]>;
  /** Bebaskan resource (dipanggil saat ganti kamera / unmount). */
  dispose(): Promise<void>;
  /**
   * #65: ubah ambang confidence live — OPSIONAL, tidak semua implementasi
   * mendukung. WorkerVehicleDetector & OnnxVehicleDetector mendukung.
   */
  setThreshold?(threshold: number): void;
}

/** Port yang dipakai dashboard — dashboard TIDAK pernah import model langsung. */
export type DetectionPort = Detector;
