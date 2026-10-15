// Tracker kendaraan antar-frame — centroid sederhana (tanpa IoU).
// Rujukan: assignment #60 — "Tracking antar-frame (centroid/IoU sederhana);
// arah dari delta y". Assignment #62 (15 Okt 2026) menambahkan persistensi
// temporal + smoothing agar box tidak kedip.
//
// Cara kerja (sengaja sederhana agar mudah dipahami junior):
//   1. Tiap deteksi diwakili titik tengah (centroid) bbox-nya.
//   2. Deteksi dipasangkan ke track lama yang centroid-nya PALING DEKAT,
//      selama jaraknya ≤ maxDistPx DAN labelnya sama (mobil≠motor).
//      → pencocokan greedy, diurut dari confidence tertinggi.
//   3. Deteksi tanpa pasangan = kendaraan baru → track baru (id naik).
//   4. Track yang N frame tidak terlihat = dihapus (kendaraan pergi).
//   5. Arah = tanda delta y centroid dalam jendela riwayat:
//      y membesar ke bawah (konvensi kanvas) → dy > 0 = "bawah".
//
// Anti-kedip (#62):
//   a. Box TIDAK dirender dari raw detection, melainkan dari TRACKER —
//      update() mengembalikan track yang masih dalam masa tenggang
//      (graceFrames) walau frame ini tidak terdeteksi, memakai posisi
//      terakhir (stale=true). → box bertahan 0,5–1 dtk setelah deteksi
//      terakhir hilang, tidak muncul-hilang sepersekian detik.
//   b. Track baru dirender hanya setelah terlihat ≥ minSeenToRender frame
//      (track "terkonfirmasi") — cegah box pop-in dari 1 deteksi sesaat.
//   c. Posisi bbox dihaluskan antar-frame (EMA, smoothAlpha) — box mengikuti
//      kendaraan dengan mulus, tidak melompat mengikuti jitter model.

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
   * dirender (posisi terakhir) selama missed ≤ graceFrames. 7 frame inferensi
   * ≈ 1,6 dtk pada fps aktual ±4,3 (asumsi awal 0,7 dtk pada CAPTURE_FPS=10
   * tidak tercapai di laptop Rama — model WASM ±230ms/inferensi).
   */
  graceFrames: number;
  /** #62: track dirender hanya bila sudah terlihat ≥ N frame (terkonfirmasi). */
  minSeenToRender: number;
  /** #62: bobot EMA smoothing bbox — 0,65 = responsif tapi halus. */
  smoothAlpha: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  /**
   * #67 (15 Okt 2026): 90 → 200. ASUMSI LAMA "10fps" SALAH — inferensi aktual
   * di laptop Rama hanya ±4,3 fps (model WASM ±230ms), sehingga kendaraan
   * bergerak ±2,3× LEBIH JAUH antar-frame inferensi dibanding asumsi 10fps.
   * Dengan 90px, kendaraan cepat TIDAK PERNAH cocok ke track lama → track
   * baru tiap frame → seen=1 terus → tidak pernah dirender (butuh 2) →
   * "box jarang muncul". 200px = 90 × 2,3 (faktor koreksi fps), masih aman
   * karena label harus sama (mobil≠motor) + greedy dari confidence tertinggi.
   */
  maxDistPx: 200,
  ttlFrames: 10, // ≈2,3 dtk tak terlihat pada 4,3fps → dianggap pergi
  minDyPx: 8, // di bawah ini = getaran centroid, bukan gerak nyata
  minSeenForDirection: 3, // cegah arah ngaco dari 1–2 frame
  historyLen: 8,
  graceFrames: 7, // #62: box bertahan ±0,7 dtk setelah deteksi hilang
  /**
   * #67 (15 Okt 2026): 2 → 1. Permintaan eksplisit Rama: "ketika muncul di
   * kamera, box bisa langsung muncul ga?" → YA. Track dirender sejak deteksi
   * PERTAMA, tanpa menunggu konfirmasi frame kedua. Tradeoff jujur: box dari
   * 1 deteksi sesaat (false positive) kini ikut tampil — tapi graceFrames
   * tetap menstabilkan, dan Rama bisa menaikkan threshold via slider bila
   * box palsu mengganggu.
   */
  minSeenToRender: 1,
  smoothAlpha: 0.65, // #62: EMA — 65% posisi baru, 35% posisi lama
};

/** Detection yang sudah punya identitas track + arah (siap digambar). */
export interface TrackedDetection extends Detection {
  trackId: number;
  direction: VehicleDirection;
  /**
   * #62: true = posisi TERAKHIR dari track dalam masa tenggang (frame ini
   * tidak ada deteksi mentah yang cocok). Overlay boleh menggambarnya
   * sedikit redup agar jujur bahwa ini prediksi, bukan deteksi segar.
   */
  stale: boolean;
}

interface Track {
  id: number;
  label: string;
  classId: number;
  /** Bbox yang DIHALUSKAN (EMA) — inilah yang dirender. */
  bbox: [number, number, number, number];
  cx: number;
  cy: number;
  history: Array<{ cx: number; cy: number }>;
  seen: number;
  missed: number;
  /** Confidence deteksi mentah terakhir (untuk chip label saat stale). */
  lastConfidence: number;
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
   * Satu frame deteksi → track ber-ID + ber-arah, SIAP RENDER.
   * Kontrak #62: yang dikembalikan BUKAN raw detection — track dalam masa
   * tenggang (stale) ikut disertakan dengan posisi terakhirnya, sehingga
   * overlay tidak pernah melihat box muncul-hilang sepersekian detik.
   */
  update(detections: Detection[]): TrackedDetection[] {
    const matched = new Set<Track>();

    // Urut confidence tertinggi dulu: kotak paling yakin dapat pasangan dulu.
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);

    for (const det of sorted) {
      const { cx, cy } = centroid(det.bbox);
      let best: Track | null = null;
      let bestDist = Infinity;

      for (const t of this.tracks) {
        if (matched.has(t) || t.label !== det.label) continue;
        const d = Math.hypot(t.cx - cx, t.cy - cy);
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
        best.cx = c.cx;
        best.cy = c.cy;
        best.seen += 1;
        best.missed = 0;
        best.lastConfidence = det.confidence;
        best.history.push({ cx: best.cx, cy: best.cy });
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
          history: [{ cx, cy }],
          seen: 1,
          missed: 0,
          lastConfidence: det.confidence,
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
    // ini ATAU masih dalam masa tenggang (stale, posisi terakhir).
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
