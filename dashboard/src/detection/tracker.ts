// Tracker kendaraan antar-frame — centroid sederhana (tanpa IoU).
// Rujukan: assignment #60 — "Tracking antar-frame (centroid/IoU sederhana);
// arah dari delta y".
//
// Cara kerja (sengaja sederhana agar mudah dipahami junior):
//   1. Tiap deteksi diwakili titik tengah (centroid) bbox-nya.
//   2. Deteksi dipasangkan ke track lama yang centroid-nya PALING DEKAT,
//      selama jaraknya ≤ maxDistPx DAN labelnya sama (mobil≠truk).
//      → pencocokan greedy, diurut dari confidence tertinggi.
//   3. Deteksi tanpa pasangan = kendaraan baru → track baru (id naik).
//   4. Track yang N frame tidak terlihat = dihapus (kendaraan pergi).
//   5. Arah = tanda delta y centroid dalam jendela riwayat:
//      y membesar ke bawah (konvensi kanvas) → dy > 0 = "bawah".

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
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  maxDistPx: 90, // ASUMSI: pada 1920×1080 & 10fps, kendaraan tak lompat >90px/frame
  ttlFrames: 10, // ≈1 dtk tak terlihat → dianggap pergi
  minDyPx: 8, // di bawah ini = getaran centroid, bukan gerak nyata
  minSeenForDirection: 3, // cegah arah ngaco dari 1–2 frame
  historyLen: 8,
};

/** Detection yang sudah punya identitas track + arah (siap digambar). */
export interface TrackedDetection extends Detection {
  trackId: number;
  direction: VehicleDirection;
}

interface Track {
  id: number;
  label: string;
  cx: number;
  cy: number;
  history: Array<{ cx: number; cy: number }>;
  seen: number;
  missed: number;
}

function centroid(bbox: [number, number, number, number]): {
  cx: number;
  cy: number;
} {
  return { cx: bbox[0] + bbox[2] / 2, cy: bbox[1] + bbox[3] / 2 };
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

  /** Satu frame deteksi → deteksi ber-trackId + ber-arah. */
  update(detections: Detection[]): TrackedDetection[] {
    const matched = new Set<Track>();
    const result: TrackedDetection[] = [];

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
        // Lanjutan track lama.
        matched.add(best);
        best.cx = cx;
        best.cy = cy;
        best.seen += 1;
        best.missed = 0;
        best.history.push({ cx, cy });
        if (best.history.length > this.opts.historyLen) best.history.shift();
        result.push({
          ...det,
          trackId: best.id,
          direction: this.classifyDirection(best),
        });
      } else {
        // Kendaraan baru.
        const track: Track = {
          id: this.nextId++,
          label: det.label,
          cx,
          cy,
          history: [{ cx, cy }],
          seen: 1,
          missed: 0,
        };
        this.tracks.push(track);
        matched.add(track);
        result.push({ ...det, trackId: track.id, direction: "unknown" });
      }
    }

    // Track yang tak terlihat frame ini: umur-miss +1; buang bila kadaluarsa.
    this.tracks = this.tracks.filter((t) => {
      if (!matched.has(t)) t.missed += 1;
      return t.missed <= this.opts.ttlFrames;
    });

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
