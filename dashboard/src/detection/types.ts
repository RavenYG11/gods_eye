// Rujukan: docs/arsitektur.md §2
// ★ KONTRAK SAJA — tidak ada file model, tidak ada bobot, tidak ada kode
// inferensi di v0.1. Modul ini hanya mendefinisikan BENTUK data dan BENTUK
// interface, supaya dashboard "detection-ready" (agnostik-model).
//
// Skema JSON Broto (beku):
//   camera_id → cameraId · frame_pts → framePts · wall_time → wallTime/timestamp
//   conf → confidence · bbox_xywh → bbox

/** Satu kotak deteksi — selaras dengan skema JSON Broto (beku). */
export interface Detection {
  classId: number; // ← class_id (Broto)
  label: string; // ← label, mis. "mobil", "motor", "orang"
  confidence: number; // ← conf, 0..1
  bbox: [number, number, number, number]; // ← bbox_xywh: [x, y, w, h] piksel
  trackId?: number; // opsional — diisi tracker bila ada
  timestamp: number; // ← wall_time, epoch ms
}

/** Satu frame hasil deteksi. */
export interface DetectionFrame {
  cameraId: string; // ← camera_id
  framePts: number; // ← frame_pts (presentation timestamp stream)
  wallTime: number; // ← wall_time
  detections: Detection[];
}

/** Kontrak yang WAJIB dipenuhi implementasi model apapun (YOLO26n, PicoDet, dst). */
export interface Detector {
  /** Muat model sekali di awal. Melempar Error bila gagal. */
  init(opts: { modelUrl: string; labels: string[] }): Promise<void>;
  /** Satu frame video → daftar kotak. TIDAK boleh melempar saat stream jalan. */
  detect(frame: ImageData | HTMLVideoElement): Promise<Detection[]>;
  /** Bebaskan resource (dipanggil saat ganti kamera / unmount). */
  dispose(): Promise<void>;
}

/** Port yang dipakai dashboard — dashboard TIDAK pernah import model langsung. */
export type DetectionPort = Detector;
