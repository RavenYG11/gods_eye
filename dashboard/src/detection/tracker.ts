// Tracker kendaraan antar-frame — centroid + prediksi velocity (constant-velocity).
// Rujukan: assignment #60 (centroid/IoU sederhana; arah dari delta y),
//   #62 (persistensi temporal + EMA smoothing anti-kedip),
//   #67 (maxDistPx 90→200 untuk fps aktual ±4,3; minSeenToRender 2→1),
//   #68 (prediksi gerakan: box diekstrapolasi pada frame-rate VIDEO di antara
//        hasil deteksi yang jarang — akar "box tertinggal dari mobil").
//
// Cara kerja:
//   1. Tiap deteksi diwakili titik tengah (centroid) bbox-nya.
//   2. Deteksi dipasangkan ke track lama yang POSISI PREDIKSI-nya paling dekat
//      (bukan posisi terakhir — prediksi = cx + vx*dt, ala langkah "predict"
//      ByteTrack/Kalman yang disederhanakan), selama jarak ≤ maxDistPx DAN
//      label sama (mobil≠motor). → greedy, confidence tertinggi dulu.
//   3. Deteksi tanpa pasangan = kendaraan baru → track baru (id naik).
//   4. Tiap track menyimpan velocity (vx, vy; piksel per detik-WAKTU VIDEO)
//      dari riwayat centroid, dihaluskan EMA + dijepit MAX_SPEED_PX_S.
//   5. Track yang N frame tak terlihat = dihapus (kendaraan pergi).
//   6. Arah = tanda delta y centroid dalam jendela riwayat.
//
// Anti-kedip (#62): box dirender dari TRACKER (bukan raw detection); track
// dalam masa tenggang (graceFrames) tetap dirender di posisi TERAKHIR bila
// tak ada info gerak — overlay-lah yang mengekstrapolasi (#68).
//
// Kenapa bukan library ByteTrack/DeepSORT (#68): diagnosis menunjukkan
// asosiasi centroid sudah bekerja; masalahnya deteksi JARANG (0,1–4,3 fps)
// sehingga box basi 1–10 dtk. Langkah "predict" Kalman itulah yang hilang —
// diimplementasikan di sini ±30 baris, tanpa dependensi baru, tetap offline.

import type { Detection, VehicleDirection } from "./types";

export interface TrackerOptions {
  /** Jarak centroid maksimum (piksel, ruang frame sumber) untuk dipasangkan. */
  maxDistPx: number;
  /** Track dihapus setelah N frame berturut-turut tak terlihat. */
  ttlFrames: number;
  /** |delta y| minimum (piksel) agar arah berani dinyatakan. */
  minDyPx: number;
  /** Track harus terlihat ≥ N frame sebelum arah diklasifikasi. */
  minSeenForDirection: number;
  /** Panjang jendela riwayat centroid untuk hitung delta y. */
  historyLen: number;
  /**
   * #62: masa tenggang render — track yang tak terdeteksi frame ini TETAP
   * dirender (posisi terakhir) selama missed ≤ graceFrames.
   */
  graceFrames: number;
  /** #62/#67: track dirender hanya bila sudah terlihat ≥ N frame. */
  minSeenToRender: number;
  /** #62: bobot EMA smoothing bbox — 0,65 = responsif tapi halus. */
  smoothAlpha: number;
  /**
   * #68: bobot EMA smoothing VELOCITY — 0,4 = velocity stabil, tidak
   * melompat mengikuti jitter centroid model antar-frame.
   */
  velocityAlpha: number;
  /**
   * #68: jepit kecepatan (piksel/detik-waktu-video, ruang 1920×1080).
   * Menolak outlier: centroid mismatch yang lolos maxDistPx tidak boleh
   * menghasilkan velocity liar → prediksi tidak "terbang".
   */
  maxSpeedPxS: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  /**
   * #67 (15 Okt 2026): 90 → 200. Inferensi aktual di laptop Rama hanya
   * ±4,3 fps (model WASM ±230ms), kendaraan bergerak ±2,3× lebih jauh
   * antar-frame dibanding asumsi 10fps. 200px = 90 × 2,3, aman karena
   * label harus sama + greedy dari confidence tertinggi.
   * #68: jarak kini diukur ke POSISI PREDIKSI (bukan posisi terakhir),
   * sehingga 200px tetap longgar untuk kendaraan cepat.
   */
  maxDistPx: 200,
  ttlFrames: 10,
  minDyPx: 8, // di bawah ini = getaran centroid, bukan gerak nyata
  minSeenForDirection: 3, // cegah arah ngaco dari 1–2 frame
  historyLen: 8,
  graceFrames: 7,
  /** #67: 2 → 1 — box langsung muncul sejak deteksi pertama (minta Rama). */
  minSeenToRender: 1,
  smoothAlpha: 0.65, // #62: EMA — 65% posisi baru, 35% posisi lama
  velocityAlpha: 0.4, // #68: EMA velocity — 40% instan, 60% riwayat
  maxSpeedPxS: 800, // #68: ~2,4 dtk melintasi lebar frame 1920px
};

/**
 * #68: batas ekstrapolasi overlay (detik-waktu-video). Di luar ini, overlay
 * menggambar posisi beku (tidak mengekstrapolasi ke entah ke mana).
 * Diekspor agar overlay & uji memakai angka yang sama.
 */
export const PREDICT_CAP_S = 3;

/** Detection yang sudah punya identitas track + arah + velocity (siap digambar). */
export interface TrackedDetection extends Detection {
  trackId: number;
  direction: VehicleDirection;
  /**
   * #62: true = posisi TERAKHIR dari track dalam masa tenggang (frame ini
   * tidak ada deteksi mentah yang cocok). Overlay menggambarnya sedikit
   * redup agar jujur bahwa ini prediksi, bukan deteksi segar.
   */
  stale: boolean;
  /**
   * #68: velocity centroid (piksel per detik-WAKTU VIDEO). Overlay
   * mengekstrapolasi bbox pada frame-rate video: pos = bbox + v*dt.
   */
  vx: number;
  vy: number;
  /**
   * #68: framePts (video.currentTime) saat track TERAKHIR dicocokkan
   * deteksi segar. Overlay: dt = video.currentTime - framePts. Untuk track
   * stale ini pts LAMA — prediksi tetap jalan selama masa tenggang.
   */
  framePts: number;
}

interface Track {
  id: number;
  label: string;
  classId: number;
  /** Bbox yang DIHALUSKAN (EMA) — inilah yang dirender. */
  bbox: [number, number, number, number];
  cx: number;
  cy: number;
  history: Array<{ cx: number; cy: number; pts: number }>;
  seen: number;
  missed: number;
  /** Confidence deteksi mentah terakhir (untuk chip label saat stale). */
  lastConfidence: number;
  /** #68: velocity (px/detik-waktu-video), EMA-smoothed. */
  vx: number;
  vy: number;
  /** #68: framePts saat terakhir dicocokkan deteksi segar. */
  lastSeenPts: number;
}

function centroid(bbox: [number, number, number, number]): {
  cx: number;
  cy: number;
} {
  return { cx: bbox[0] + bbox[2] / 2, cy: bbox[1] + bbox[3] / 2 };
}

/** Rata-rata bergerak eksponensial per komponen bbox: halus, tetap responsif. */
function smoothBox(
  prev: [number, number, number, number],
  next: [number, number, number, number],
  alpha: number,
): [number, number, number, number] {
  return [
    prev[0] + alpha * (next[0] - prev[0]),
    prev[1] + alpha * (next[1] - prev[1]),
    prev[2] + alpha * (next[2] - prev[2]),
    prev[3] + alpha * (next[3] - prev[3]),
  ];
}

/**
 * #68: ekstrapolasi bbox MURNI (tanpa DOM) — dipakai overlay TIAP frame
 * video (rAF 60fps) agar box mengikuti kendaraan di antara hasil deteksi
 * yang jarang (0,1–4,3 fps). dt dijepit [0, PREDICT_CAP_S]; di luar itu
 * overlay menggambar posisi beku.
 */
export function predictBbox(
  bbox: [number, number, number, number],
  vx: number,
  vy: number,
  dtSec: number,
): [number, number, number, number] {
  const dt = Math.min(Math.max(dtSec, 0), PREDICT_CAP_S);
  if (dt === 0 || (vx === 0 && vy === 0)) return bbox;
  const dx = vx * dt;
  const dy = vy * dt;
  return [bbox[0] + dx, bbox[1] + dy, bbox[2], bbox[3]];
}

export class CentroidTracker {
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(private readonly opts: TrackerOptions = DEFAULT_TRACKER_OPTIONS) {}

  /** Kosongkan semua track (dipakai saat ganti kamera / deteksi dimatikan). */
  reset(): void {
    this.tracks = [];
    this.nextId = 1;
  }

  /**
   * Satu frame deteksi → track ber-ID + ber-arah + ber-velocity, SIAP RENDER.
   * @param framePts video.currentTime saat frame DITANGKAP (bukan saat
   *        inferensi selesai) — basis waktu velocity & prediksi.
   */
  update(detections: Detection[], framePts: number): TrackedDetection[] {
    const matched = new Set<Track>();

    // Urut confidence tertinggi dulu: kotak paling yakin dapat pasangan dulu.
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);

    for (const det of sorted) {
      const { cx, cy } = centroid(det.bbox);
      let best: Track | null = null;
      let bestDist = Infinity;

      for (const t of this.tracks) {
        if (matched.has(t) || t.label !== det.label) continue;
        // #68: cocokkan ke POSISI PREDIKSI pada framePts ini, bukan posisi
        // terakhir — kendaraan sudah bergerak sejak deteksi sebelumnya.
        const pdt = Math.min(Math.max(framePts - t.lastSeenPts, 0), PREDICT_CAP_S);
        const px = t.cx + t.vx * pdt;
        const py = t.cy + t.vy * pdt;
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }

      if (best && bestDist <= this.opts.maxDistPx) {
        // Lanjutan track lama — haluskan posisi (EMA), bukan teleport.
        matched.add(best);
        best.bbox = smoothBox(best.bbox, det.bbox, this.opts.smoothAlpha);
        const c = centroid(best.bbox);
        // #68: velocity dari perpindahan centroid (smoothed) per detik-waktu-video.
        const dt = framePts - best.lastSeenPts;
        if (dt > 1e-3) {
          const ivx = (c.cx - best.cx) / dt;
          const ivy = (c.cy - best.cy) / dt;
          // Jepit dulu (tolak outlier mismatch), baru EMA.
          const sp = Math.hypot(ivx, ivy);
          const k = sp > this.opts.maxSpeedPxS ? this.opts.maxSpeedPxS / sp : 1;
          const a = this.opts.velocityAlpha;
          best.vx += a * (ivx * k - best.vx);
          best.vy += a * (ivy * k - best.vy);
        }
        best.cx = c.cx;
        best.cy = c.cy;
        best.seen += 1;
        best.missed = 0;
        best.lastConfidence = det.confidence;
        best.lastSeenPts = framePts;
        best.history.push({ cx: best.cx, cy: best.cy, pts: framePts });
        if (best.history.length > this.opts.historyLen) best.history.shift();
      } else {
        // Kendaraan baru — bbox awal = deteksi mentah (belum ada yang dihaluskan).
        const track: Track = {
          id: this.nextId++,
          label: det.label,
          classId: det.classId,
          bbox: [...det.bbox] as [number, number, number, number],
          cx,
          cy,
          history: [{ cx, cy, pts: framePts }],
          seen: 1,
          missed: 0,
          lastConfidence: det.confidence,
          vx: 0,
          vy: 0,
          lastSeenPts: framePts,
        };
        this.tracks.push(track);
        matched.add(track);
      }
    }

    // Track yang tak terlihat frame ini: umur-miss +1; buang bila kadaluarsa.
    this.tracks = this.tracks.filter((t) => {
      if (!matched.has(t)) t.missed += 1;
      return t.missed <= this.opts.ttlFrames;
    });

    // Render dari TRACKER: track terkonfirmasi (seen cukup) yang cocok frame
    // ini ATAU masih dalam masa tenggang (stale). #68: tiap hasil membawa
    // vx/vy + framePts (terakhir terlihat) agar overlay bisa prediksi.
    const result: TrackedDetection[] = [];
    for (const t of this.tracks) {
      if (t.seen < this.opts.minSeenToRender) continue;
      const isStale = !matched.has(t);
      if (isStale && t.missed > this.opts.graceFrames) continue;
      result.push({
        classId: t.classId,
        label: t.label,
        confidence: t.lastConfidence,
        bbox: t.bbox,
        timestamp: Date.now(),
        trackId: t.id,
        direction: this.classifyDirection(t),
        stale: isStale,
        vx: t.vx,
        vy: t.vy,
        framePts: t.lastSeenPts,
      });
    }
    return result;
  }

  /** Arah dari delta y ujung-ke-ujung jendela riwayat. */
  private classifyDirection(t: Track): VehicleDirection {
    if (t.seen < this.opts.minSeenForDirection || t.history.length < 2) {
      return "unknown";
    }
    const first = t.history[0];
    const last = t.history[t.history.length - 1];
    const dy = last.cy - first.cy; // y kanvas: positif = ke bawah
    if (Math.abs(dy) < this.opts.minDyPx) return "unknown";
    return dy > 0 ? "bawah" : "atas";
  }

  /** Untuk uji: jumlah track aktif saat ini. */
  get activeTracks(): number {
    return this.tracks.length;
  }
}
