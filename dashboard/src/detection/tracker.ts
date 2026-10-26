// ByteTrack associates YOLO observations. Pixel tracking and latency replay
// live in motionTracker.ts; observed anchors must retain the raw model box.
import type { Detection, VehicleDirection } from "./types";
import { DETECTOR_PARSE_FLOOR, VEHICLE_POLICY } from "./vehicleConfig";
import { coastDuration, INITIAL_SAMPLE_INTERVAL_SEC, updateSampleInterval } from "./trackingTiming";

export interface TrackerOptions {
  /**
   * Ambang confidence TAHAP-1 (deteksi "tinggi"). Disinkron dari slider UI
   * via setHighThreshold() — default = CONFIDENCE_THRESHOLD (0,4).
   * Deteksi di bawah ini tapi ≥ lowConfFloor dipakai TAHAP-2 (re-id).
   */
  highConfThreshold: number;
  /**
   * Lantai parse detector (== DETECTOR_PARSE_FLOOR di vehicleConfig).
   * Deteksi < ini tidak pernah keluar dari model → tidak terlihat tracker.
   */
  lowConfFloor: number;
  /** Gate IoU tahap-1 (ByteTrack asli: jarak 0,8 ⇔ IoU 0,2). */
  iouGateHigh: number;
  /** Gate IoU tahap-2 — LEBIH KETAT (hanya untuk re-identifikasi). */
  iouGateLow: number;
  /**
   * Fallback jarak-pusat tahap-1 (piksel RUANG BITMAP, mis. 960×540):
   * bila IoU < gate tapi pusat bergerak ≤ ini, asosiasi tetap diizinkan
   * (adaptasi fps-rendah — lihat komentar berkas).
   */
  distGateHighPx: number;
  /** Fallback jarak-pusat tahap-2 (lebih ketat). */
  distGateLowPx: number;
  /**
   * Track yang hilang (tak cocok di kedua tahap) disimpan N frame deteksi
   * untuk re-identifikasi, lalu dihapus. 30 frame ≈ ±7 dtk @ 4,3 fps —
   * cukup untuk oklusi tiang/kendaraan lain.
   */
  maxTimeLostFrames: number;
  /**
   * Track yang baru hilang TETAP DIRENDER (redup, posisi prediksi Kalman)
   * selama N frame — anti-kedip warisan #62 (dulu "graceFrames").
   */
  graceFrames: number;
  /** |delta y| minimum (piksel bitmap) agar arah berani dinyatakan. */
  minDyPx: number;
  /** Track harus terlihat ≥ N frame sebelum arah diklasifikasi. */
  minSeenForDirection: number;
  /** Panjang jendela riwayat pusat untuk hitung delta y arah. */
  historyLen: number;
  /** Bobot EMA smoothing velocity output (0,5 = stabil, tetap responsif). */
  velocityAlpha: number;
  /**
   * Jepit kecepatan output (piksel BITMAP per detik-waktu-video).
   * Menolak outlier: mismatch yang lolos gate tidak boleh membuat prediksi
   * "terbang". 400 ≈ 800 px/dtk di ruang 1920 (nilai lama #68).
   */
  maxSpeedPxS: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  highConfThreshold: 0.4,
  lowConfFloor: DETECTOR_PARSE_FLOOR,
  iouGateHigh: 0.2,
  iouGateLow: 0.3,
  distGateHighPx: 45,
  distGateLowPx: 25,
  maxTimeLostFrames: 30,
  graceFrames: 7,
  minDyPx: 8,
  minSeenForDirection: 3,
  historyLen: 8,
  velocityAlpha: 0.5,
  maxSpeedPxS: 400,
};

/**
 * Batas ekstrapolasi overlay (detik-waktu-video). Di luar ini overlay
 * menggambar posisi beku (tidak mengekstrapolasi ke entah ke mana).
 * Diekspor agar overlay & uji memakai angka yang sama (warisan #68).
 */
export const PREDICT_CAP_S = 0.75;

/** Detection yang sudah punya identitas track + arah + velocity (siap digambar). */
export interface TrackedDetection extends Detection {
  trackId: number;
  direction: VehicleDirection;
  /**
   * true = track HILANG sementara (tak ada deteksi cocok frame ini) tapi
   * masih dalam masa tenggang render — posisi dari prediksi Kalman.
   * Overlay menggambarnya sedikit redup (jujur: prediksi, bukan deteksi).
   */
  stale: boolean;
  /** Velocity (piksel per detik-WAKTU-VIDEO, ruang bitmap). */
  vx: number;
  vy: number;
  /** Video timestamp of the current Kalman prediction. */
  framePts: number;
  /** Last real observation; independent of the current Kalman prediction. */
  lastSeenPts: number;
  observations: number;
  reliable: boolean;
  sampleIntervalSec: number;
  /** Main thread measures actual video-time lag at result delivery. */
  captureLagSec?: number;
  /** Pixel-tracker cadence and the bounded gap it can bridge. */
  motionIntervalSec?: number;
  coastSec?: number;
  presentationLagSec?: number;
}

// ---------------------------------------------------------------------------
// Aljabar linear minimal (cukup untuk Kalman 8-state / 4-measurement).
// Matriks = number[][]. Ukuran kecil (≤8×8), sedikit track — tanpa depedensi.
// ---------------------------------------------------------------------------

type Mat = number[][];

function matMul(a: Mat, b: Mat): Mat {
  const n = a.length;
  const m = b[0].length;
  const k = b.length;
  const out: Mat = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < k; t++) {
      const aik = a[i][t];
      if (aik === 0) continue;
      for (let j = 0; j < m; j++) out[i][j] += aik * b[t][j];
    }
  }
  return out;
}

function matTrans(a: Mat): Mat {
  const n = a.length;
  const m = a[0].length;
  const out: Mat = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) out[j][i] = a[i][j];
  return out;
}

function matAdd(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]));
}

function matSub(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((v, j) => v - b[i][j]));
}

function matEye(n: number): Mat {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

function matDiag(d: number[]): Mat {
  return d.map((v, i) => d.map((_, j) => (i === j ? v : 0)));
}

/** Invers matriks bujur sangkar via eliminasi Gauss-Jordan (untuk S 4×4). */
function matInv(a: Mat): Mat {
  const n = a.length;
  const aug: Mat = a.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[piv][col])) piv = r;
    }
    if (Math.abs(aug[piv][col]) < 1e-12) {
      // Singular — kembalikan identitas (jangan meledak di tengah jalan).
      return matEye(n);
    }
    [aug[col], aug[piv]] = [aug[piv], aug[col]];
    const d = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= f * aug[col][j];
    }
  }
  return aug.map((row) => row.slice(n));
}

// ---------------------------------------------------------------------------
// Kalman filter constant-velocity: state [cx,cy,w,h,vx,vy,vw,vh] (8),
// measurement [cx,cy,w,h] (4). Bobot noise mengikuti ByteTrack
// (_std_weight_position = 1/20, _std_weight_velocity = 1/160).
// ---------------------------------------------------------------------------

class KalmanFilter {
  private x: Mat; // 8×1
  private p: Mat; // 8×8
  private readonly f: Mat;
  private readonly h: Mat;
  private readonly q: Mat;
  private readonly r: Mat;

  constructor(cx: number, cy: number, w: number, h: number) {
    const sw = Math.max(w, 1);
    const sh = Math.max(h, 1);
    this.x = [[cx], [cy], [w], [h], [0], [0], [0], [0]];
    // P0: posisi cukup yakin (dari deteksi), velocity sangat tak yakin.
    this.p = matDiag([4, 4, 4, 4, 1000, 1000, 1000, 1000]);
    this.f = matEye(8);
    this.f[0][4] = 1;
    this.f[1][5] = 1;
    this.f[2][6] = 1;
    this.f[3][7] = 1;
    this.h = [
      [1, 0, 0, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 0],
    ];
    const sp = 1 / 20;
    const sv = 1 / 160;
    this.q = matDiag([
      (sp * sw) ** 2,
      (sp * sh) ** 2,
      (sp * sw) ** 2,
      (sp * sh) ** 2,
      (sv * sw) ** 2,
      (sv * sh) ** 2,
      (sv * sw) ** 2,
      (sv * sh) ** 2,
    ]);
    this.r = matDiag([
      (sp * sw) ** 2,
      (sp * sh) ** 2,
      (sp * sw) ** 2,
      (sp * sh) ** 2,
    ]);
  }

  /** Predict: x' = Fx, P' = FPFᵀ + Q. */
  predict(dt = 1): void {
    for (let i = 0; i < 4; i++) this.f[i][i + 4] = dt;
    this.x = matMul(this.f, this.x);
    this.p = matAdd(matMul(matMul(this.f, this.p), matTrans(this.f)),
      this.q.map((row) => row.map((v) => v * Math.max(dt, 0.001))));
  }

  /** Update dengan measurement [cx,cy,w,h]. */
  update(z: [number, number, number, number]): void {
    const zm: Mat = [[z[0]], [z[1]], [z[2]], [z[3]]];
    const ht = matTrans(this.h);
    const s = matAdd(matMul(matMul(this.h, this.p), ht), this.r);
    const k = matMul(matMul(this.p, ht), matInv(s));
    const y = matSub(zm, matMul(this.h, this.x));
    this.x = matAdd(this.x, matMul(k, y));
    const kh = matMul(k, this.h);
    this.p = matMul(matSub(matEye(8), kh), this.p);
  }

  /** State terfilter [cx,cy,w,h] (posisi saja). */
  get box(): [number, number, number, number] {
    const cx = this.x[0][0];
    const cy = this.x[1][0];
    const w = Math.max(1, this.x[2][0]);
    const h = Math.max(1, this.x[3][0]);
    return [cx - w / 2, cy - h / 2, w, h];
  }

  get center(): { cx: number; cy: number } {
    return { cx: this.x[0][0], cy: this.x[1][0] };
  }
}

// ---------------------------------------------------------------------------
// IoU + Hungarian (penugasan optimum) untuk asosiasi dua tahap.
// ---------------------------------------------------------------------------

function iouXYWH(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

function centerDist(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  return Math.hypot(
    a[0] + a[2] / 2 - (b[0] + b[2] / 2),
    a[1] + a[3] / 2 - (b[1] + b[3] / 2),
  );
}

/**
 * Hungarian (Kuhn-Munkres) O(n³) untuk matriks bujur sangkar — minimasi.
 * Mengembalikan assignment[row] = col (0-indexed).
 */
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const ans = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] !== 0) ans[p[j] - 1] = j - 1;
  }
  return ans;
}

/** Biaya asosiasi hibrida (lihat komentar berkas): < gate = boleh. */
const FORBIDDEN_COST = 2;

function pairCost(
  trackBox: [number, number, number, number],
  detBox: [number, number, number, number],
  iouGate: number,
  /**
   * #75: gate jarak PER PASANGAN (boleh beda per track — lihat gateFor di
   * updateGroup: dibuka sebanding dt sejak track terakhir terlihat).
   */
  distGatePx: number,
): number {
  const areaRatio = (detBox[2] * detBox[3]) / (trackBox[2] * trackBox[3]);
  if (!Number.isFinite(areaRatio) || areaRatio < 0.25 || areaRatio > 4) return FORBIDDEN_COST;
  const iou = iouXYWH(trackBox, detBox);
  if (iou >= iouGate) return 1 - iou;
  const d = centerDist(trackBox, detBox);
  if (d <= distGatePx) return 1 - iouGate + (d / distGatePx) * 0.2;
  return FORBIDDEN_COST;
}

/**
 * Asosiasi optimum track↔deteksi. Mengembalikan pasangan (trackIdx, detIdx)
 * yang biayanya < FORBIDDEN_COST; sisanya "tak cocok".
 * #75: distGatesPx = gate jarak PER TRACK (sepanjang nT) — asosiasi kini
 * sadar-waktu (lihat gateFor di updateGroup).
 */
function associate(
  trackBoxes: Array<[number, number, number, number]>,
  detBoxes: Array<[number, number, number, number]>,
  iouGate: number,
  distGatesPx: number[],
): {
  matches: Array<[number, number]>;
  unmatchedTracks: number[];
  unmatchedDets: number[];
} {
  const nT = trackBoxes.length;
  const nD = detBoxes.length;
  const matches: Array<[number, number]> = [];
  const unmatchedTracks: number[] = [];
  const unmatchedDets: number[] = [];
  if (nT === 0 || nD === 0) {
    for (let i = 0; i < nT; i++) unmatchedTracks.push(i);
    for (let j = 0; j < nD; j++) unmatchedDets.push(j);
    return { matches, unmatchedTracks, unmatchedDets };
  }
  const n = Math.max(nT, nD);
  const cost: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i < nT && j < nD)
        return pairCost(trackBoxes[i], detBoxes[j], iouGate, distGatesPx[i]);
      return FORBIDDEN_COST; // sel dummy — selalu kalah dari pasangan valid
    }),
  );
  const assign = hungarian(cost);
  const usedDet = new Set<number>();
  for (let i = 0; i < nT; i++) {
    const j = assign[i];
    if (j >= 0 && j < nD && cost[i][j] < FORBIDDEN_COST) {
      matches.push([i, j]);
      usedDet.add(j);
    } else {
      unmatchedTracks.push(i);
    }
  }
  for (let j = 0; j < nD; j++) {
    if (!usedDet.has(j)) unmatchedDets.push(j);
  }
  return { matches, unmatchedTracks, unmatchedDets };
}

// ---------------------------------------------------------------------------
// ByteTracker
// ---------------------------------------------------------------------------

interface Track {
  id: number;
  kf: KalmanFilter;
  label: string;
  classId: number;
  /** "active" = cocok baru-baru ini; "lost" = menunggu re-identifikasi. */
  state: "active" | "lost";
  /** Frame deteksi sejak cocok terakhir (0 = cocok frame ini). */
  timeSinceUpdate: number;
  /** Jumlah frame cocok beruntun (untuk klasifikasi arah). */
  hits: number;
  highHits: number;
  lastConfidence: number;
  history: Array<{ cx: number; cy: number; pts: number }>;
  /** Velocity output (piksel bitmap / detik-waktu-video), EMA. */
  vx: number;
  vy: number;
  prevCx: number;
  prevCy: number;
  prevPts: number;
  /** framePts saat TERAKHIR dicocokkan deteksi (basis prediksi overlay). */
  lastSeenPts: number;
  predictedPts: number;
  lastBox: [number, number, number, number];
}

export class ByteTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private highThresh: number | null = null;
  private previousPts = -1;
  private sampleIntervalSec = INITIAL_SAMPLE_INTERVAL_SEC;

  constructor(private readonly opts: TrackerOptions = DEFAULT_TRACKER_OPTIONS) {

  }

  private thresholdFor(label: string): number {
    return this.highThresh ?? VEHICLE_POLICY[label as keyof typeof VEHICLE_POLICY]?.newTrackConfidence ?? this.opts.highConfThreshold;
  }

  /** Ambang tahap-1 — disinkron dari slider confidence UI (via worker). */
  setHighThreshold(t: number): void {
    this.highThresh = Math.min(0.9, Math.max(0.05, t));
  }

  /** Kosongkan semua track (dipakai saat ganti kamera / deteksi dimatikan). */
  reset(): void {
    this.tracks = [];
    this.nextId = 1;
    this.previousPts = -1;
    this.sampleIntervalSec = INITIAL_SAMPLE_INTERVAL_SEC;
  }

  /**
   * Satu frame deteksi → track ber-ID + ber-arah + ber-velocity, SIAP RENDER.
   * @param detections deteksi mentah dari model (sudah ≥ lowConfFloor).
   * @param framePts video.currentTime saat frame DITANGKAP — basis waktu
   *        velocity & prediksi overlay.
   */
  update(detections: Detection[], framePts: number): TrackedDetection[] {
    const o = this.opts;
    if (!Number.isFinite(framePts)) return [];
    if (this.previousPts >= 0 && (framePts < this.previousPts || framePts - this.previousPts > 3)) this.reset();
    if (this.previousPts >= 0) this.sampleIntervalSec = updateSampleInterval(this.sampleIntervalSec, framePts - this.previousPts);
    this.previousPts = framePts;
    this.tracks = this.tracks.filter((t) => framePts - t.lastSeenPts <= 3);

    // Asosiasi per label (mobil≠motor tidak boleh tertukar ID).
    const labels = new Set<string>();
    for (const t of this.tracks) labels.add(t.label);
    for (const d of detections) labels.add(d.label);

    for (const label of labels) {
      const groupTracks = this.tracks.filter((t) => t.label === label);
      const groupDets = detections.filter((d) => d.label === label);
      this.updateGroup(groupTracks, groupDets, framePts);
    }

    // Hapus yang hilang terlalu lama (di luar jangkauan re-identifikasi).
    this.tracks = this.tracks.filter(
      (t) => t.timeSinceUpdate <= o.maxTimeLostFrames,
    );

    // Confirmed tracks bridge brief misses. Grace follows measured inference
    // cadence, rather than a fixed cutoff shorter than a single slow inference.
    const result: TrackedDetection[] = [];
    for (const t of this.tracks) {
      const isStale = t.state === "lost";
      if (isStale && (t.hits < 2 || t.timeSinceUpdate > o.graceFrames ||
        framePts - t.lastSeenPts > this.coastFor(t))) continue;
      const [x, y, w, h] = isStale ? t.kf.box : t.lastBox;
      result.push({
        classId: t.classId,
        label: t.label,
        confidence: t.lastConfidence,
        bbox: [x, y, w, h],
        timestamp: Date.now(),
        trackId: t.id,
        direction: this.classifyDirection(t),
        stale: isStale,
        vx: t.vx,
        vy: t.vy,
        // kf.box has ALREADY been predicted to this frame, never predict twice.
        framePts,
        lastSeenPts: t.lastSeenPts,
        observations: t.hits,
        reliable: t.hits >= 4 && t.highHits >= 2,
        sampleIntervalSec: this.sampleIntervalSec,
      });
    }
    // Urutan stabil untuk overlay: ID menaik.
    result.sort((a, b) => a.trackId - b.trackId);
    return result;
  }

  /**
   * Satu langkah ByteTrack untuk satu grup label:
   * predict → tahap-1 (SEMUA track, aktif+hilang, vs deteksi high) →
   * tahap-2 (track aktif yang gagal tahap-1 vs deteksi low) →
   * lahir baru → tandai hilang.
   *
   * Catatan kesetiaan pada algoritma asli: strack_pool tahap-1 =
   * tracked + lost (ifzhang/ByteTrack bytetrack.py) — track yang hilang
   * bisa re-identifikasi LANGSUNG oleh deteksi high-confidence, bukan
   * hanya via low-conf. Tahap-2 hanya untuk track AKTIF yang gagal
   * tahap-1 (oklus parsial → skor turun).
   */
  private updateGroup(
    groupTracks: Track[],
    groupDets: Detection[],
    framePts: number,
  ): void {
    const o = this.opts;

    // 1) Prediksi SEMUA track (termasuk yang hilang — Kalman jalan terus).
    for (const t of groupTracks) {
      t.kf.predict(Math.max(0.001, framePts - t.predictedPts));
      t.predictedPts = framePts;
    }

    // 2) Bagi deteksi: tinggi (tahap-1) vs rendah (tahap-2, re-id).
    const high: Detection[] = [];
    const low: Detection[] = [];
    for (const d of groupDets) {
      // Di bawah lantai = noise model, bukan kandidat (kontrak detector).
      if (d.confidence < Math.min(o.lowConfFloor, this.thresholdFor(d.label))) continue;
      (d.confidence >= this.thresholdFor(d.label) ? high : low).push(d);
    }

    const refreshed = new Set<Track>();

    // #75 — GATE ADAPTIF WAKTU (akar "box muncul lalu DIAM"; bukti: uji Node
    // stress.mjs skenario A — 12 frame deteksi @1fps, objek 250px/dtk →
    // 12 ID berbeda, semua vx=0.0). Jarak tempuh antar-deteksi = kecepatan ×
    // dt; gate piksel TETAP (200px) + inferensi lambat (dt besar di CPU i5)
    // = asosiasi SELALU gagal untuk kendaraan cepat/dekat kamera → tiap
    // deteksi melahirkan track BARU berv=0 → overlay mengekstrapolasi dengan
    // v=0 → box DIAM di posisi lahir, lalu melompat ke posisi baru
    // ("patah-patah"). Gate kini dibuka sebanding dt sejak track terakhir
    // terlihat, dibatasi kecepatan maksimum yang masih masuk akal
    // (maxSpeedPxS — KONSISTEN dengan jepit velocity output di refreshTrack:
    // track tak mungkin ditemukan lebih jauh dari maxSpeed×dt). Untuk
    // deteksi cepat (dt kecil) gate = nilai dasar → perilaku tak berubah.
    // Catatan tradeoff (jujur): gate lebar memudahkan re-identifikasi BENAR
    // sekaligus membuka peluang salah-re-id bila kendaraan asli sudah pergi;
    // Hungarian (biaya global minimum) + IoU tetap memprioritaskan pasangan
    // terdekat, dan kerusakan ID-switch kronis (pasti) lebih buruk daripada
    // risiko salah-re-id (kadang-kadang).
    const gateFor = (t: Track, basePx: number): number => {
      const dt = Math.max(0, framePts - t.lastSeenPts);
      // Established tracks are already predicted. Gating by the ENTIRE possible
      // travel distance again lets them steal nearby vehicles after an occlusion.
      if (t.hits >= 3) {
        const box = t.kf.box;
        const uncertainty = 30 + Math.hypot(t.vx, t.vy) * 0.2;
        return Math.max(12, Math.min(basePx, Math.hypot(box[2], box[3]) * 0.65)) + uncertainty * dt;
      }
      return Math.max(basePx, o.maxSpeedPxS * dt);
    };

    // 3) TAHAP-1: semua track (aktif + hilang) ↔ deteksi high-confidence.
    const s1 = associate(
      groupTracks.map((t) => t.kf.box),
      high.map((d) => d.bbox),
      o.iouGateHigh,
      groupTracks.map((t) => gateFor(t, o.distGateHighPx)),
    );
    const s1MatchedTrackIdx = new Set<number>();
    const s1MatchedDetIdx = new Set<number>();
    for (const [ti, di] of s1.matches) {
      s1MatchedTrackIdx.add(ti);
      s1MatchedDetIdx.add(di);
      const tr = groupTracks[ti];
      this.refreshTrack(tr, high[di], framePts);
      refreshed.add(tr);
    }

    // 4) A recently lost, confirmed track may recover through a weak detection.
    // Older lost tracks are excluded so low-confidence noise cannot revive them.
    const s1UnmatchedActive = groupTracks.filter(
      (t, i) => !s1MatchedTrackIdx.has(i) && (t.state === "active" ||
        (t.hits >= 2 && framePts - t.lastSeenPts <= this.coastFor(t) + this.sampleIntervalSec)),
    );
    const s2 = associate(
      s1UnmatchedActive.map((t) => t.kf.box),
      low.map((d) => d.bbox),
      o.iouGateLow,
      s1UnmatchedActive.map((t) => gateFor(t, o.distGateLowPx)),
    );
    for (const [ti, di] of s2.matches) {
      const tr = s1UnmatchedActive[ti];
      this.refreshTrack(tr, low[di], framePts);
      refreshed.add(tr);
    }

    // 5) Track yang tak cocok di kedua tahap → hilang (umur +1).
    for (const t of groupTracks) {
      if (refreshed.has(t)) continue;
      t.timeSinceUpdate += 1;
      t.state = "lost";
    }

    // 6) Deteksi high yang tak cocok → kendaraan BARU (langsung aktif —
    //    box muncul sejak deteksi pertama, syarat Rama #67).
    for (let j = 0; j < high.length; j++) {
      if (s1MatchedDetIdx.has(j)) continue;
      const d = high[j];
      const [x, y, w, h] = d.bbox;
      const cx = x + w / 2;
      const cy = y + h / 2;
      this.tracks.push({
        id: this.nextId++,
        kf: new KalmanFilter(cx, cy, w, h),
        label: d.label,
        classId: d.classId,
        state: "active",
        timeSinceUpdate: 0,
        hits: 1,
        highHits: 1,
        lastConfidence: d.confidence,
        history: [{ cx, cy, pts: framePts }],
        vx: 0,
        vy: 0,
        prevCx: cx,
        prevCy: cy,
        prevPts: framePts,
        lastSeenPts: framePts,
        predictedPts: framePts,
        lastBox: [...d.bbox],
      });
    }
  }

  /** Terapkan hasil asosiasi ke track: Kalman update + velocity + riwayat. */
  private coastFor(track: Track): number {
    return coastDuration(this.sampleIntervalSec, track.hits >= 4 && track.highHits >= 2);
  }

  private refreshTrack(t: Track, det: Detection, framePts: number): void {
    const o = this.opts;
    const [x, y, w, h] = det.bbox;
    t.lastBox = [...det.bbox];
    t.kf.update([x + w / 2, y + h / 2, w, h]);
    const c = t.kf.center;
    // Velocity output dari posisi TERFILTER (jauh lebih halus daripada
    // centroid mentah): px bitmap per detik-waktu-video, EMA + jepit.
    const dt = Math.max(framePts - t.prevPts, 1e-3);
    const ivx = (c.cx - t.prevCx) / dt;
    const ivy = (c.cy - t.prevCy) / dt;
    const sp = Math.hypot(ivx, ivy);
    const k = sp > o.maxSpeedPxS ? o.maxSpeedPxS / sp : 1;
    // The first motion measurement must not start at half speed, otherwise
    // newly acquired vehicles get a stationary/lagging box for another frame.
    const a = t.hits === 1 ? 1 : o.velocityAlpha;
    t.vx += a * (ivx * k - t.vx);
    t.vy += a * (ivy * k - t.vy);
    t.prevCx = c.cx;
    t.prevCy = c.cy;
    t.prevPts = framePts;
    t.timeSinceUpdate = 0;
    t.state = "active";
    t.hits += 1;
    if (det.confidence >= this.thresholdFor(det.label)) t.highHits++;
    t.lastConfidence = det.confidence;
    t.lastSeenPts = framePts;
    t.history.push({ cx: c.cx, cy: c.cy, pts: framePts });
    if (t.history.length > o.historyLen) t.history.shift();
  }

  /** Arah dari delta y ujung-ke-ujung jendela riwayat (kontrak visual #60). */
  private classifyDirection(t: Track): VehicleDirection {
    if (t.hits < this.opts.minSeenForDirection || t.history.length < 2) {
      return "unknown";
    }
    const first = t.history[0];
    const last = t.history[t.history.length - 1];
    const dy = last.cy - first.cy; // y kanvas: positif = ke bawah
    if (Math.abs(dy) < this.opts.minDyPx) return "unknown";
    return dy > 0 ? "bawah" : "atas";
  }

  /** Untuk uji: jumlah track aktif+hilang saat ini. */
  get activeTracks(): number {
    return this.tracks.length;
  }
}

/**
 * Ekstrapolasi bbox MURNI (tanpa DOM) — dipakai overlay TIAP frame video
 * (rAF 60fps) agar box mengikuti kendaraan di antara hasil deteksi yang
 * jarang (±4 fps). dt dijepit [0, PREDICT_CAP_S]; di luar itu overlay
 * menggambar posisi beku (warisan #68, kontrak tak berubah).
 */
export function predictBbox(
  bbox: [number, number, number, number],
  vx: number,
  vy: number,
  dtSec: number,
  limitSec = PREDICT_CAP_S,
): [number, number, number, number] {
  const dt = Math.min(Math.max(dtSec, 0), limitSec);
  if (dt === 0 || (vx === 0 && vy === 0)) return bbox;
  const dx = vx * dt;
  const dy = vy * dt;
  return [bbox[0] + dx, bbox[1] + dy, bbox[2], bbox[3]];
}
