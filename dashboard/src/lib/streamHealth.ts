import Hls, { type ErrorData } from "hls.js";
import type { CameraConfig } from "../config/cameras";
import { getStreamUrl } from "../config/cameras";
import { makeLogEntry, type LogEntry, type LogLevel } from "./log";
import { bufferedAt, bufferGoal, safePlaybackPosition, PLAYBACK_DELAY_SEC } from "./bufferPolicy";

<<<<<<< HEAD
export type StreamStatus = "loading" | "live" | "delay" | "buffering" | "reconnecting" | "offline" | "error";
=======
export type StreamStatus =
  | "loading"
  | "live"
  | "delay"
  | "buffering"
  | "reconnecting"
  | "offline"
  | "error";

export interface StreamMetrics {
  bitrateMbps: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  stalls: number;
  reconnects: number;
  uptimeSec: number;
}

export interface StreamSnapshot {
  status: StreamStatus;
  /** #69: true bila <video> sedang dijeda user (dari event play/pause nyata). */
  paused: boolean;
  /**
   * #69: info playback terkini — bahan kontrol play/pause + tampilan waktu
   * + bar jendela DVR. Diperbarui tiap 1 dtk oleh tickDelay() (selalu nilai
   * TERBARU, bukan ring buffer seperti telemetri #68).
   */
  playback: PlaybackInfo;
  /** Detik keterlambatan dari live edge (relevan saat status 'delay'). */
  delaySec: number;
  /** Nomor percobaan reconnect berjalan (1-based). */
  attempt: number;
  maxAttempts: number;
  /** Hitung mundur (detik) menuju percobaan reconnect berikutnya. */
  countdownSec: number;
  /** Kode galat singkat (relevan saat status 'error'). */
  errorCode: string;
  metrics: StreamMetrics;
  log: LogEntry[];
}

type Listener = (snap: StreamSnapshot) => void;

/**
 * #68 — TELEMETRI PLAYBACK (bukti untuk uji 10+ menit Rama).
 * Satu sampel tiap 2 dtk: posisi play vs ujung buffer vs live edge.
 * Kriteria lolos uji: TIDAK ADA siklus buffering berulang DAN
 * gap (bufEnd − pos) TUMBUH/STABIL — bukan menyusut ke nol.
 * Diunduh sebagai JSON dari popover metrik ("Unduh log playback").
 */
export interface TelemetrySample {
  /** Wall time (epoch ms). */
  t: number;
  /** video.currentTime (dtk). */
  pos: number;
  /** buffered.start(0) (dtk); −1 bila buffer kosong. */
  bufStart: number;
  /** buffered.end(terakhir) (dtk); −1 bila buffer kosong. */
  bufEnd: number;
  /** hls.liveSyncPosition (dtk); −1 bila tak diketahui. */
  edge: number;
  /** edge − pos (dtk): keterlambatan dari live edge. */
  delay: number;
  /** bufEnd − pos (dtk): "cushion" ala trik Bekasi — harus tumbuh/stabil. */
  gap: number;
  /** Jumlah stall kumulatif sesi. */
  stalls: number;
  status: StreamStatus;
}

/** Interval sampling telemetri (ms). */
const TELEMETRY_INTERVAL_MS = 2000;
/** Kapasitas ring buffer telemetri: 2000 sampel ≈ 66 menit @2 dtk. */
const TELEMETRY_MAX = 2000;

/**
 * #75: status info jendela DVR.
 * - "loading"      = masih wajar menunggu (manifest baru dimuat).
 * - "ready"        = jendela valid, bar/angka bisa dipakai.
 * - "unavailable"  = JUJUR: >20 dtk setelah manifest dimuat info jendela
 *                    tak kunjung ada (mis. HLS native / playlist tak lazim) —
 *                    UI menampilkan pesan yang benar, bukan "menunggu…" abadi.
 */
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
export type DvrState = "loading" | "ready" | "unavailable";
export interface StreamMetrics {
  bitrateMbps: number | null; width: number | null; height: number | null;
  fps: number | null; stalls: number; reconnects: number; uptimeSec: number;
}
export interface PlaybackInfo {
  pos: number; bufStart: number; bufEnd: number;
  /** Actual playlist edge, never hls.liveSyncPosition (which is a target). */
  edge: number; windowStart: number; windowEnd: number; dvrState: DvrState;
}
export interface StreamSnapshot {
  status: StreamStatus; paused: boolean; prebuffering: boolean;
  playback: PlaybackInfo; delaySec: number; attempt: number; maxAttempts: number;
  countdownSec: number; errorCode: string; metrics: StreamMetrics; log: LogEntry[];
}
export interface TelemetrySample {
  t: number; pos: number; bufStart: number; bufEnd: number; edge: number;
  delay: number; gap: number; stalls: number; status: StreamStatus;
  prebuffering: boolean; droppedFrames: number;
}
const BACKOFF = [1000, 2000, 5000, 15000, 30000];
const emptyPlayback = (): PlaybackInfo => ({ pos: 0, bufStart: -1, bufEnd: -1,
  edge: -1, windowStart: -1, windowEnd: -1, dvrState: "loading" });
const emptyMetrics = (): StreamMetrics => ({ bitrateMbps: null, width: null,
  height: null, fps: null, stalls: 0, reconnects: 0, uptimeSec: 0 });

<<<<<<< HEAD
/** Startup buffer first, then uninterrupted 1x playback. No proactive pauses. */
=======
/** Jadwal backoff antar percobaan reconnect (ms): 1→2→5→15→30 dtk. */
const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
/** Batas log agar memori tidak tumbuh tanpa batas (entri terlama dibuang). */
const MAX_LOG = 300;
/** Ambang LIVE vs DELAY: frame ≤ 3 dtk dari ujung playlist = LIVE. */
const LIVE_THRESHOLD_SEC = 3;
/**
 * ANTI-BUFFERING — trik web resmi CCTV Bekasi (#60, observasi Rama 15 Okt 2026):
 * situs Bekasi tidak pernah buffering karena (a) video mulai diputar
 * BEBERAPA DETIK DI BELAKANG tepi buffer, dan (b) player TIDAK PERNAH
 * mengejar live edge — selisih buffer-play DIBIARKAN MEMBESAR seiring waktu
 * (bisa 1 menit+), tetap lancar karena cushion buffer selalu tebal.
 *
 * #66 (15 Okt 2026) — KOREKSI IMPLEMENTASI: pola #60 (seek manual
 * video.currentTime tiap detik via applyIntentionalDelay) TERBUKTI menjadi
 * akar buffering 80%: tiap seek menginvalidasi buffer internal hls.js →
 * siklus rebuffer tanpa henti. Offset ±5 dtk dialihkan ke NATIF hls.js
 * (liveSyncDuration: 5, maxLiveSyncPlaybackRate: 1).
 *
 * #68 (15 Okt 2026, perintah Rama ~20:40) — KOREKSI KEDUA, berbasis bukti:
 * `liveMaxLatencyDuration: 30` (#66) TERNYATA masih "mengejar edge".
 * BUKTI (hls.js 1.7.3, stream-controller, diverifikasi dari source):
 * bila `currentTime < end − maxLatency`, hls.js MELAKUKAN SEEK KE
 * liveSyncPosition (TEPI!). Jadi tiap drift > 30 dtk (mis. setelah stall)
 * player "ditarik" ke tepi = buffer tipis = SIKLUS REBUFFER yang Rama
 * laporkan. Mulai #68: liveMaxLatencyDuration = Infinity → catch-up natif
 * MATI TOTAL; player tidak pernah ditarik ke tepi. Satu-satunya seek yang
 * tersisa adalah saat posisi SUDAH KELUAR dari sliding window playlist
 * (tidak bisa diputar sama sekali — last resort bawaan hls.js sendiri).
 * `emergencyResync()` #66 (seek ke edge−6 bila drift > 60 dtk) DIHAPUS —
 * itu bentuk lain "mengejar edge". Diganti PENJAGA JENDELA DVR
 * (dvrWindowGuard): seek HANYA bila posisi play hampir kedaluwarsa dari
 * playlist (data-driven, bukan timer), dan targetnya TETAP JAUH dari tepi
 * (edge − DVR_SAFE_BEHIND_SEC, selaras cushion anti-buffering — bukan
 * mengejar edge).
 */
/**
 * #68: PENJAGA JENDELA DVR — trigger bila sisa jendela playlist di belakang
 * posisi play kurang dari ini. BUKAN timer catch-up: hanya aktif bila posisi
 * benar-benar hampir kedaluwarsa (data dari level.details.fragments).
 */
const DVR_GUARD_MARGIN_SEC = 10;
/**
 * #76: target seek penjaga DVR — 10 dtk di belakang live edge, SELARAS
 * dengan cushion anti-buffering (liveSyncDuration: 10, permintaan Rama
 * 16 Okt 2026). Nilai lama 45 dtk (#71) memaksa offset yang tidak cocok
 * dengan jendela playlist pendek dan memperbesar risiko posisi basi.
 */
const DVR_SAFE_BEHIND_SEC = 10;
/**
 * #76 — PENJAGA PREBUFFER INTERNAL (#71) DIHAPUS TOTAL (16 Okt 2026,
 * perintah eksplisit Rama): "jangan melakukan pause otomatis berulang
 * untuk mengejar target buffer" dan "memutar bagian stream yang sudah
 * tersedia sambil mengunduh bagian berikutnya, bukan berhenti dulu untuk
 * menunggu buffer puluhan detik". Pola lama — gap (bufEnd−pos) < 8 dtk →
 * video.pause(), tunggu gap ≥ 30 dtk atau timeout 25 dtk — adalah SIKLUS
 * JEDA BUATAN: video berhenti walau sumber stream lancar. Kini bila
 * buffer menipis, player memutar apa yang tersedia sampai event 'waiting'
 * alami → status buffering normal (jujur, terlihat user).
 */
/** Stall > 10 dtk + multi-bitrate → turunkan kualitas dulu (§4 butir 4). */
const STALL_DOWNGRADE_MS = 10_000;
/** Interval pemeriksaan latar saat OFFLINE (mockup: "pemeriksaan otomatis
 *  tetap berjalan di latar"). */
const OFFLINE_RETRY_MS = 60_000;

const EMPTY_METRICS: StreamMetrics = {
  bitrateMbps: null,
  width: null,
  height: null,
  fps: null,
  stalls: 0,
  reconnects: 0,
  uptimeSec: 0,
};

>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
export class StreamHealth {
  private hls: Hls | null = null;
  private video: HTMLVideoElement | null = null;
  private camera: CameraConfig | null = null;
  private listeners = new Set<(snap: StreamSnapshot) => void>();
  private logEntries: LogEntry[] = [];
  private telemetry: TelemetrySample[] = [];
  private status: StreamStatus = "loading";
  private paused = false;
<<<<<<< HEAD
  private prebuffering = false;
  private userPaused = false;
  private started = false;
  private cycle = 0;
  private cycleAt = 0;
  private gateAt = 0;
  private mediaRecovered = false;
  private attempt = 0;
=======
  /** #69: info playback terkini (pos/buffer/edge/window), refresh tiap 1 dtk. */
  private playback: PlaybackInfo = {
    pos: 0,
    bufStart: -1,
    bufEnd: -1,
    edge: -1,
    windowStart: -1,
    windowEnd: -1,
    dvrState: "loading",
  };
  private delaySec = 0;
  private attempt = 0; // 0 = belum ada percobaan; 1..5 saat reconnecting
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
  private countdownSec = 0;
  private errorCode = "";
  private metrics = emptyMetrics();
  private playback = emptyPlayback();
  private dvr: { start: number; end: number } | null = null;
  private ticker = 0;
  private reconnectTimer = 0;
  private reconnectAt = 0;
  private manualSeekAt = 0;
  private prevFrames = 0;
  private prevFramesAt = 0;
  private lastTelemetry = 0;
  private connectedAt = 0;
  private detectionReady = true;
  private playPending = false;

<<<<<<< HEAD
  setDetectionReady(ready: boolean): void {
    this.detectionReady = ready;
    if (ready) this.tryStart();
  }

  subscribe(fn: (snap: StreamSnapshot) => void): () => void {
    this.listeners.add(fn); fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
=======
  /**
   * Sinyal "player nunggu data" yang jujur: event 'waiting' milik <video>.
   * (hls.js v1.6 tidak mengekspos event BUFFER_STALLED; stall internal
   * dilaporkan via STALL_RESOLVED — lihat startCycle.)
   * Rujukan perilaku: arsitektur.md §4 tabel status → BUFFERING.
   */
  private onVideoWaiting = (): void => {
    if (this.status === "live" || this.status === "delay") {
      this.metrics.stalls += 1;
      this.setStatus("buffering");
      this.pushLog(
        "warn",
        "Buffering — player menunggu data stream (jaringan lambat).",
      );
      // §4 butir 4: stall > 10 dtk + multi-bitrate → turunkan kualitas.
      this.stallTimer = window.setTimeout(() => {
        this.downgradeOnLongStall();
      }, STALL_DOWNGRADE_MS);
    }
  };

  private onVideoPlaying = (): void => {
    // #70.3: resume berhasil — batalkan watchdog pemulihan.
    if (this.resumeWatchdogTimer !== null) {
      clearTimeout(this.resumeWatchdogTimer);
      this.resumeWatchdogTimer = null;
    }
    if (this.status === "buffering") {
      this.clearStallTimer();
      this.pushLog("ok", "Data stream kembali — pemutaran lanjut.");
      this.setStatus("live");
    }
  };

  /**
   * #69: state jeda yang JUJUR — dari event nyata <video>, bukan dari
   * asumsi UI. Emit agar tombol play/pause + label waktu langsung sinkron.
   */
  private onVideoPlay = (): void => {
    if (this.paused) {
      this.paused = false;
      this.emit();
    }
  };

  private onVideoPause = (): void => {
    if (!this.paused) {
      this.paused = true;
      this.emit();
    }
  };

  // ---------- API publik ----------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * #69: PENJAGA JENDELA DVR versi publik — dipanggil UI TEPAT SEBELUM
   * resume dari pause (tombol play / klik video). Memastikan posisi play
   * masih di dalam sliding window playlist SEBELUM video.play() dipanggil,
   * sehingga resume tidak pernah menabrak posisi kedaluwarsa (yang akan
   * memicu seek brutal / rebuffer). Mengembalikan true bila melakukan seek.
   * Logika inti tetap di dvrWindowGuard() (#68) — tidak diduplikasi.
   */
  guardDvrWindow(): boolean {
    return this.dvrWindowGuard();
  }

  /**
   * #70.1 — SEEK MANUAL USER (scrub DVR bar). Kebijakan #69 (display-only)
   * DIBATALKAN atas permintaan eksplisit Rama (15 Okt 2026 ~21:22).
   * Target dijepit ke dalam jendela DVR [windowStart+1 .. fragEnd−0.5]
   * agar tidak menabrak posisi kedaluwarsa/tepi live. Setelah seek,
   * hls.startLoad() dipanggil agar pemuatan fragmen lanjut cepat
   * (khusus saat paused, hls.js kadang idle).
   * State pause TIDAK diubah: scrub saat jeda tetap jeda di posisi baru.
   */
  seekTo(targetSec: number): boolean {
    const video = this.video;
    const hls = this.hls;
    if (!video) return false;
    let lo = 0;
    let hi = Number.POSITIVE_INFINITY;
    const frags = hls?.levels?.[hls.currentLevel]?.details?.fragments;
    if (frags && frags.length > 0) {
      // #74: lo = windowStart+2 (was +1) — margin kecil agar posisi hasil
      // seek tidak "lahir" tepat di bibir kedaluwarsa; guard DVR tidak
      // menyentuh posisi ini selama 30 dtk masa tenggang (lihat
      // dvrWindowGuard) → posisi tidak mental balik.
      lo = frags[0].start + 2;
      const last = frags[frags.length - 1];
      hi = last.start + (last.duration || 0) - 0.5;
    }
    const t = Math.min(hi, Math.max(lo, targetSec));
    if (!Number.isFinite(t)) return false;
    try {
      video.currentTime = t;
      if (hls) {
        try {
          hls.startLoad();
        } catch {
          /* abaikan */
        }
      }
      this.lastManualSeekAt = Date.now();
      this.pushLog(
        "info",
        `Seek manual ke ${t.toFixed(1)} dtk (dalam jendela DVR).`,
      );
      this.updatePlaybackInfo();
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * #70.3 — RESUME TAHAN BANTING (pengganti pola guardDvrWindow()+play()
   * di UI). Dipanggil UI sebagai pengganti video.play() langsung. Urutan:
   *   (1) penjaga DVR: pastikan posisi valid (bisa seek sekali);
   *   (2) jaring pengaman clampToDvrWindow: bila posisi masih DI LUAR
   *       jendela playlist (kedaluwarsa total — mis. jeda sangat lama),
   *       paksa ke posisi aman; tanpa ini, play() di posisi basi = stuck
   *       "buffering" selamanya (bug #70.3 laporan Rama);
   *   (3) hls.startLoad(): setelah seek saat paused / posisi kedaluwarsa,
   *       hls.js kadang tidak melanjutkan pemuatan fragmen sendiri
   *       (startLoad no-op bila sudah loading — aman selalu dipanggil);
   *   (4) watchdog resume: bila 4 dtk kemudian belum 'playing' dan masih
   *       macet → recoverMediaError() sekali.
   */
  resumePlayback(): void {
    const video = this.video;
    if (!video || !video.paused) return;
    this.dvrWindowGuard();
    this.clampToDvrWindow();
    if (this.hls) {
      try {
        this.hls.startLoad();
      } catch {
        /* abaikan */
      }
    }
    void video.play().catch(() => undefined);
    this.armResumeWatchdog();
  }

  /**
   * #68: salinan ring buffer telemetri playback (urutan waktu menaik).
   * Dipakai tombol "Unduh log playback (JSON)" di popover metrik —
   * bukti uji 10+ menit: kolom `gap` (bufEnd − pos) harus tumbuh/stabil.
   */
  getTelemetry(): TelemetrySample[] {
    return [...this.telemetry];
  }

  /** Tombol "Coba sambungkan lagi" / "Muat ulang" — langsung percobaan ke-1. */
  retry(): void {
    this.clearReconnectTimers();
    if (this.offlineTimer !== null) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
    this.attempt = 1;
    this.mediaRecoverTried = false;
    this.pushLog(
      "info",
      `Percobaan ke-1/${BACKOFF_MS.length} (manual) — memuat ulang stream…`,
    );
    this.setStatus("reconnecting");
    this.countdownSec = 0;
    this.startCycle();
    this.armWatchdog();
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
  }
  getTelemetry(): TelemetrySample[] { return this.telemetry.map((row) => ({ ...row })); }

  attach(video: HTMLVideoElement, camera: CameraConfig): void {
    this.detach();
    this.video = video; this.camera = camera;
    this.metrics = emptyMetrics(); this.playback = emptyPlayback(); this.telemetry = [];
    this.attempt = 0; this.started = false; this.userPaused = false;
    this.connectedAt = Date.now(); this.prevFramesAt = 0;
    for (const [event, handler] of this.events) video.addEventListener(event, handler);
    this.startCycle();
    this.ticker = window.setInterval(() => this.tick(), 500);
  }
  detach(): void {
    this.cycle++;
    clearInterval(this.ticker); clearTimeout(this.reconnectTimer);
    this.ticker = this.reconnectTimer = 0;
    this.hls?.destroy(); this.hls = null;
    if (this.video) {
      for (const [event, handler] of this.events) this.video.removeEventListener(event, handler);
      this.video.pause(); this.video.removeAttribute("src"); this.video.load();
    }
    this.video = null; this.dvr = null; this.prebuffering = false;
  }
  retry(): void {
    clearTimeout(this.reconnectTimer);
    this.attempt = 0; this.userPaused = false;
    this.startCycle();
  }
  pausePlayback(): void {
    this.userPaused = true; this.prebuffering = false;
    this.video?.pause(); this.paused = true; this.emit();
  }
  resumePlayback(): void {
    if (!this.video) return;
    this.userPaused = false; this.paused = false;
    this.guardDvrWindow();
    this.hls?.resumeBuffering();
    this.updatePlayback();
    const range = bufferedAt(this.video.buffered, this.video.currentTime);
    if (!this.started || !range || range.end - this.video.currentTime < 1) this.beginGate();
    else this.play();
    this.emit();
  }
  seekTo(target: number): boolean {
    const video = this.video;
    this.updatePlayback();
    const { windowStart: start, windowEnd: end } = this.playback;
    if (!video || !Number.isFinite(target) || !(end > start)) return false;
    const margin = Math.min(0.5, (end - start) / 4);
    video.currentTime = Math.max(start + margin, Math.min(end - margin, target));
    this.manualSeekAt = Date.now();
    this.hls?.resumeBuffering();
    this.updatePlayback(); this.emit();
    return true;
  }
  guardDvrWindow(): boolean {
    const video = this.video, dvr = this.dvr;
    if (!video || !dvr || !this.started) return false;
    // Buffered old segments remain playable even after leaving the playlist.
    const buffered = bufferedAt(video.buffered, video.currentTime);
    if (buffered && buffered.end - video.currentTime > 0.25) return false;
    if (video.currentTime >= dvr.start && video.currentTime < dvr.end) return false;
    if (Date.now() - this.manualSeekAt < 1500) return false;
    const target = safePlaybackPosition(dvr.start, dvr.end);
    video.currentTime = target;
    this.log("warn", `Posisi kedaluwarsa; lanjut dari cadangan video pada ${target.toFixed(1)} dtk.`);
    return true;
  }

  private startCycle(): void {
    const video = this.video, camera = this.camera;
    if (!video || !camera) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0; this.countdownSec = 0;
    this.hls?.destroy(); this.hls = null;
    const cycle = ++this.cycle;
    this.cycleAt = Date.now(); this.gateAt = this.cycleAt;
    this.playPending = false;
    this.dvr = null; this.started = false; this.mediaRecovered = false;
    this.prebuffering = !this.userPaused; this.paused = this.userPaused;
    this.playback = emptyPlayback();
    video.pause(); video.playbackRate = 1;
    this.status = "loading";
    this.log("info", "Memuat stream dan mengisi cadangan video sebelum diputar.");
    if (!Hls.isSupported()) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) {
        this.errorCode = "Browser tidak mendukung HLS."; this.status = "error"; this.emit(); return;
      }
      video.src = getStreamUrl(camera); video.preload = "auto"; video.load();
      return;
    }
    const hls = new Hls({
<<<<<<< HEAD
      enableWorker: true, lowLatencyMode: false,
      liveSyncDuration: PLAYBACK_DELAY_SEC, liveMaxLatencyDuration: Infinity,
=======
      enableWorker: true,
      manifestLoadingMaxRetry: 2,
      manifestLoadingRetryDelay: 2000,
      levelLoadingMaxRetry: 3,
      levelLoadingRetryDelay: 2000,
      fragLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 2000,
      // #71 (16 Okt 2026) — STRATEGI BUFFER AGRESIF, berbasis bukti kode
      // (akar lag laporan Rama — lihat komentar liveSyncDuration di bawah):
      //   - maxBufferLength: 30 → 120. Untuk LIVE, buffer maju MEMANG
      //     dibatasi live edge (playlist tak punya segmen di depan tepi),
      //     jadi angka ini hanya plafon — tapi 30 terlalu kecil sebagai
      //     plafon saat cushion kini 10 dtk.
      //   - maxMaxBufferLength: 600 (plafon absolut hls.js; eksplisit agar
      //     tidak tergantung default).
      //   - backBufferLength: 90 (default 30). Buffer ke BELAKANG yang
      //     lebih tebal → scrub DVR bar mundur tidak langsung fetch ulang.
      maxBufferLength: 120,
      maxMaxBufferLength: 600,
      backBufferLength: 90,
      // #76 (16 Okt 2026, perintah Rama): liveSyncDuration 45 → 10.
      // Rama menerima playback ~10 dtk di belakang ujung stream; offset 45
      // dtk (#71) tidak cocok dengan jendela playlist pendek (posisi play
      // lahir di bibir kedaluwarsa → risiko rebuffer/guard tak perlu).
      // Prinsip tetap: putar bagian yang SUDAH tersedia (±10 dtk di
      // belakang edge) sambil mengunduh berikutnya — BUKAN berhenti
      // menunggu buffer puluhan detik (penjaga prebuffer #71 DIHAPUS di
      // #76 karena itu siklus jeda buatan).
      // liveMaxLatencyDuration: Infinity tetap — catch-up natif MATI TOTAL
      // (kebijakan #68, bukan penyebab lag).
      liveSyncDuration: 10,
      // #68: CATCH-UP NATIF DIMATIKAN TOTAL (Infinity). BUKTI (hls.js 1.7.3,
      // stream-controller): bila currentTime < end − maxLatency, hls.js
      // MELAKUKAN SEEK KE liveSyncPosition (tepi!). Nilai 30 (#66) berarti
      // tiap drift > 30 dtk (mis. setelah stall) player "ditarik" ke tepi =
      // buffer tipis = SIKLUS REBUFFER. Infinity = tidak pernah ditarik;
      // seek hanya terjadi bila posisi sudah KELUAR dari sliding window
      // (tidak bisa diputar sama sekali — last resort bawaan hls.js).
      // Penyesuaian playbackRate tidak relevan di sini (hanya untuk
      // lowLatencyMode — diverifikasi dari source latency-controller).
      liveMaxLatencyDuration: Infinity,
      // #60 anti-buffering: JANGAN kejar live edge dengan mempercepat playback.
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
      maxLiveSyncPlaybackRate: 1,
      maxBufferLength: 60, maxMaxBufferLength: 120,
      maxBufferSize: 64 * 1024 * 1024, backBufferLength: 30,
      manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4,
      manifestLoadingTimeOut: 15000, levelLoadingTimeOut: 15000, fragLoadingTimeOut: 20000,
    });
    this.hls = hls;
    const current = () => this.cycle === cycle && this.hls === hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!current()) return;
      this.log("ok", `Manifest siap; target delay ${PLAYBACK_DELAY_SEC} dtk, kecepatan tetap 1×.`);
    });
    hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
      if (!current()) return;
      const fragments = data.details.fragments;
      const first = fragments[0], last = fragments[fragments.length - 1];
      if (first && last) this.dvr = { start: first.start, end: last.start + last.duration };
      this.updatePlayback();
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => { if (current()) this.tryStart(); });
    hls.on(Hls.Events.ERROR, (_event, data) => { if (current()) this.onHlsError(data); });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (!current()) return;
      const level = hls.levels[data.level];
      if (!level) return;
      this.metrics.bitrateMbps = level.bitrate ? +(level.bitrate / 1e6).toFixed(1) : null;
      this.metrics.width = level.width || null; this.metrics.height = level.height || null;
      this.emit();
    });
    hls.loadSource(getStreamUrl(camera)); hls.attachMedia(video);
  }

  private beginGate(): void {
    if (!this.video || this.userPaused) return;
    if (!this.prebuffering) this.gateAt = Date.now();
    this.prebuffering = true;
    this.status = this.started ? "buffering" : "loading";
    this.video.pause(); this.paused = false;
    this.tryStart(); this.emit();
  }
  private tryStart(): void {
    const video = this.video;
    if (!video || !this.prebuffering || this.userPaused || video.seeking || (!this.started && !this.detectionReady)) return;
    // Initial media time can be zero while HLS segments start later.
    if (!this.started && video.buffered.length && video.currentTime < video.buffered.start(0) - 0.1) {
      video.currentTime = video.buffered.start(0) + 0.05;
    }
    // Model warmup may outlast the playlist. Start once from a safe, current
    // buffered position instead of playing an already-expired old segment.
    if (!this.started && this.dvr && video.buffered.length && video.currentTime < this.dvr.start + 0.5) {
      video.currentTime = safePlaybackPosition(this.dvr.start, this.dvr.end);
      return;
    }
    this.updatePlayback();
    const p = this.playback;
    const goal = bufferGoal(this.dvr?.start ?? -1, this.dvr?.end ?? -1, p.pos, !this.started);
    if (p.bufEnd < 0 || p.bufEnd - p.pos < goal || video.readyState < 2) return;
    this.prebuffering = false;
    this.log("ok", `Cadangan siap: ${(p.bufEnd - p.pos).toFixed(1)} dtk; pemutaran dimulai.`);
    this.play();
  }
  private play(): void {
    const video = this.video;
    const cycle = this.cycle;
    if (!video || this.userPaused || this.playPending) return;
    this.playPending = true;
    void video.play().catch((err: DOMException) => {
      if (cycle !== this.cycle || err.name === "AbortError") return;
      this.userPaused = true; this.paused = true; this.prebuffering = false;
      this.log("warn", "Klik tombol play untuk melanjutkan pemutaran.");
    }).finally(() => { if (cycle === this.cycle) this.playPending = false; });
  }

  private onPlaying = (): void => {
    if (this.userPaused) { this.video?.pause(); return; }
    if (!this.started && this.attempt > 0) this.metrics.reconnects++;
    this.started = true; this.prebuffering = false; this.paused = false;
    this.attempt = 0; this.countdownSec = 0;
    this.status = "delay"; this.updatePlayback(); this.emit();
  };
  private onWaiting = (): void => {
    if (this.userPaused || this.prebuffering || !this.started) return;
    const range = this.video && bufferedAt(this.video.buffered, this.video.currentTime);
    // A busy decoder is not a network shortage. Pausing here creates a pause/play race.
    if (range && this.video && range.end - this.video.currentTime > 1) return;
    this.metrics.stalls++;
    this.log("warn", "Cadangan habis; mengisi ulang buffer sebelum melanjutkan.");
    this.beginGate();
  };
  private onPause = (): void => {
    // pause events are queued: an internal pause can arrive after play().
    // User intent is owned by pausePlayback(), never inferred from this event.
    this.paused = this.userPaused;
    this.emit();
  };
  private onPlay = (): void => { this.paused = false; this.emit(); };
  private onProgress = (): void => { this.tryStart(); };
  private onNativeError = (): void => {
    if (!this.hls && this.video?.error) this.scheduleReconnect("Stream native gagal dimuat.");
  };
  private events: Array<[string, EventListener]> = [
    ["playing", this.onPlaying], ["waiting", this.onWaiting], ["pause", this.onPause],
    ["play", this.onPlay], ["progress", this.onProgress], ["loadeddata", this.onProgress],
    ["seeked", this.onProgress], ["error", this.onNativeError],
  ];

  private onHlsError(data: ErrorData): void {
    if (!data.fatal) return; // ordinary HLS retries do not need a player restart
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered && this.hls) {
      this.mediaRecovered = true;
      this.log("warn", `Memulihkan decoder (${data.details}).`);
      this.hls.recoverMediaError(); return;
    }
    this.scheduleReconnect(data.details);
  }
  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) return;
    this.cycle++; // invalidate callbacks before destroying the old instance
    this.hls?.destroy(); this.hls = null;
    this.prebuffering = false;
    const offline = this.attempt >= BACKOFF.length;
    const wait = offline ? 60000 : BACKOFF[this.attempt++];
    this.status = offline ? "offline" : "reconnecting";
    this.video?.pause();
    this.reconnectAt = Date.now() + wait;
    this.log("warn", `Sambung ulang dalam ${wait / 1000} dtk: ${reason}`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      if (offline) this.attempt = 0;
      this.startCycle();
    }, wait);
  }

  private updatePlayback(): void {
    const video = this.video;
    if (!video) return;
<<<<<<< HEAD
    if (!this.hls && video.seekable.length) this.dvr = {
      start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1),
=======
    // #69: info playback terkini (pos/buffer/edge/window) SELALU di-refresh
    // tiap detik — terpisah dari logika status di bawah, karena kontrol
    // play/pause + tampilan waktu butuh datanya di semua state sesi berjalan.
    this.updatePlaybackInfo();
    // #70.2: emit TIAP DETIK walau status/delaySec tidak berubah. Akar bug
    // "bar mentok": snapshot sebelumnya hanya di-emit saat status berubah —
    // saat delay stabil (mis. "DELAY ±16 dtk" terus-menerus) UI tidak pernah
    // menerima data playback baru → bar DVR & chip waktu tampak beku.
    this.emit();
    const hls = this.hls;
    if (!hls || (this.status !== "live" && this.status !== "delay")) {
      return;
    }
    const edge = hls.liveSyncPosition;
    if (typeof edge !== "number" || !Number.isFinite(edge)) return;
    if (video.currentTime <= 0) return;
    const delay = Math.max(0, edge - video.currentTime);

    // #68 (15 Okt 2026): emergencyResync() #66 DIHAPUS — seek ke (edge−6)
    // bila drift > 60 dtk adalah bentuk lain "mengejar edge" (buffer tipis →
    // rebuffer). Kebijakan final ala situs Bekasi: player TIDAK PERNAH
    // mengejar live edge; gap dibiarkan membesar. Satu-satunya seek yang
    // tersisa: PENJAGA JENDELA DVR di bawah — hanya bila posisi play hampir
    // kedaluwarsa dari playlist (data-driven), target tetap JAUH dari tepi.
    // #70.3: JANGAN jalankan guard saat video dijeda user — menarik frame
    // yang sedang dilihat = perilaku salah; posisi kedaluwarsa ditangani
    // saat resume via resumePlayback() (guard + clamp + startLoad).
    if (!video.paused && this.dvrWindowGuard()) {
      return;
    }

    const sec = Math.round(delay);
    if (delay <= LIVE_THRESHOLD_SEC) {
      if (this.status !== "live" || this.delaySec !== 0) {
        this.delaySec = 0;
        this.setStatus("live");
      }
    } else if (this.status !== "delay" || this.delaySec !== sec) {
      this.delaySec = sec;
      this.setStatus("delay");
    }
  }

  /**
   * #68 — PENJAGA JENDELA DVR (pengganti emergencyResync #66).
   * Untuk stream LIVE, playlist adalah sliding window: fragmen lama
   * kedaluwarsa dan hilang. Karena player #68 TIDAK PERNAH mengejar live
   * edge, posisi play bisa (sangat jarang, setelah stall panjang beruntun)
   * mendekati batas kedaluwarsa. Guard ini SATU-SATUNYA seek yang tersisa:
   *   - trigger: sisa jendela di belakang posisi play < DVR_GUARD_MARGIN_SEC
   *     (data NYATA dari level.details.fragments — bukan timer, bukan tebakan);
   *   - target: edge − DVR_SAFE_BEHIND_SEC (TETAP JAUH dari tepi, cushion
   *     tebal — bukan "mengejar edge"), dijepit agar di dalam jendela.
   * Mengembalikan true bila melakukan seek (tickDelay berhenti di sini).
   */
  private dvrWindowGuard(): boolean {
    const hls = this.hls;
    const video = this.video;
    if (!hls || !video) return false;
    const level = hls.levels?.[hls.currentLevel];
    const frags = level?.details?.fragments;
    if (!frags || frags.length === 0) return false;
    const edge = hls.liveSyncPosition;
    if (typeof edge !== "number" || !Number.isFinite(edge) || edge <= 0) {
      return false;
    }

    const windowStart = frags[0].start;
    const pos = video.currentTime;
    // #74: masa tenggang setelah scrub manual — JANGAN SENTUH SAMA SEKALI
    // posisi yang baru dipilih user. SEBELUM #74: margin 2 dtk + clamp seek
    // lo=windowStart+1 → seek ke tepi kiri bar SELALU ditarik balik ke
    // edge−45 oleh guard ini ("posisi mental balik" — keluhan Rama #74).
    // Guard kembali normal setelah 30 dtk; saat itu jendela sudah bergeser
    // dan konten di posisi lama memang kedaluwarsa (benar untuk ditarik).
    if (Date.now() - this.lastManualSeekAt < this.SCRUB_GRACE_MS) return false;
    const margin = DVR_GUARD_MARGIN_SEC;
    // Masih aman: lebih dari margin di dalam jendela → tidak usah apa-apa.
    if (pos > windowStart + margin) return false;

    // Hampir kedaluwarsa: lompat SEKALI ke posisi aman yang tetap jauh
    // dari tepi. Jepit ke dalam jendela agar tidak seek ke posisi basi.
    const target = Math.max(
      windowStart + DVR_GUARD_MARGIN_SEC,
      edge - DVR_SAFE_BEHIND_SEC,
    );
    if (target <= pos) return false; // tidak ada posisi lebih baik — diam.
    try {
      video.currentTime = target;
      this.pushLog(
        "warn",
        `Penjaga DVR: posisi hampir kedaluwarsa dari playlist ` +
          `(sisa jendela ${(pos - windowStart).toFixed(1)} dtk) — lompat ` +
          `ke ${DVR_SAFE_BEHIND_SEC} dtk di belakang live edge ` +
          `(tetap jauh dari tepi, bukan mengejar edge).`,
      );
      return true;
    } catch {
      // seek gagal — biarkan hls.js yang mengatur.
      return false;
    }
  }

  /**
   * #70.3: paksa posisi ke dalam jendela DVR bila sudah keluar seluruhnya.
   * dvrWindowGuard() hanya menangani "hampir kedaluwarsa"; ini menangani
   * "sudah kedaluwarsa" (pos < windowStart, mis. jeda sangat lama) atau
   * "melampaui live" (pos > edge). Mengembalikan true bila melakukan seek.
   */
  private clampToDvrWindow(): boolean {
    const hls = this.hls;
    const video = this.video;
    if (!hls || !video) return false;
    const frags = hls.levels?.[hls.currentLevel]?.details?.fragments;
    if (!frags || frags.length === 0) return false;
    const windowStart = frags[0].start;
    const last = frags[frags.length - 1];
    const windowEnd = last.start + (last.duration || 0);
    const edge = hls.liveSyncPosition;
    const edgeKnown = typeof edge === "number" && Number.isFinite(edge);
    const pos = video.currentTime;
    if (pos >= windowStart && (!edgeKnown || pos <= edge)) return false;
    const target = Math.max(
      windowStart + DVR_GUARD_MARGIN_SEC,
      (edgeKnown ? edge : windowEnd) - DVR_SAFE_BEHIND_SEC,
    );
    try {
      video.currentTime = target;
      this.pushLog(
        "warn",
        `Resume: posisi ${pos.toFixed(1)} dtk di luar jendela DVR — dipindah ` +
          `ke ${DVR_SAFE_BEHIND_SEC} dtk di belakang live edge.`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * #70.3: watchdog pasca-resume. Bila 4 dtk setelah resumePlayback() video
   * belum 'playing' dan masih macet (buffering / readyState rendah),
   * coba pemulihan media hls.js sekali + startLoad().
   */
  private armResumeWatchdog(): void {
    if (this.resumeWatchdogTimer !== null) {
      clearTimeout(this.resumeWatchdogTimer);
    }
    this.resumeWatchdogTimer = window.setTimeout(() => {
      this.resumeWatchdogTimer = null;
      const video = this.video;
      const hls = this.hls;
      if (!video || !hls) return;
      // Sudah jalan normal: diam.
      if (!video.paused && this.status !== "buffering") return;
      if (this.status === "buffering" || video.readyState < 2) {
        this.pushLog(
          "warn",
          "Resume macet >4 dtk — mencoba pemulihan media hls.js…",
        );
        try {
          hls.recoverMediaError();
        } catch {
          /* abaikan */
        }
        try {
          hls.startLoad();
        } catch {
          /* abaikan */
        }
      }
    }, 4000);
  }

  /**
   * #69: baca posisi/buffer/edge/window terkini dari <video> + hls.js.
   * Dipanggil tiap 1 dtk oleh tickDelay(). UI me-render dari snapshot —
   * tidak ada pembacaan video langsung di komponen (konsisten §4).
   *
   * #75: jendela DVR dibaca dari STATE EVENT-DRIVEN (dvrWindow, diisi
   * LEVEL_UPDATED) — bukan polling hls.levels[currentLevel] tiap detik
   * (rapuh: currentLevel = −1 sebelum frag pertama). Fallback baca langsung
   * dipertahankan untuk kompatibilitas; −1 bila tak diketahui (jujur).
   * 'edge' TETAP liveSyncPosition (semantik chip waktu + guard DVR) —
   * bar DVR memakai windowEnd yang faktual (lihat PlaybackInfo).
   */
  private updatePlaybackInfo(): void {
    const video = this.video;
    if (!video) return;
    let bufStart = -1;
    let bufEnd = -1;
    try {
      const b = video.buffered;
      if (b.length > 0) {
        bufStart = b.start(0);
        bufEnd = b.end(b.length - 1);
      }
    } catch {
      // buffered tak terbaca — biarkan −1 (jujur).
    }
    const hls = this.hls;
    const edge =
      hls && typeof hls.liveSyncPosition === "number"
        ? hls.liveSyncPosition
        : -1;
    let windowStart = -1;
    let windowEnd = -1;
    if (this.dvrWindow) {
      windowStart = this.dvrWindow.start;
      windowEnd = this.dvrWindow.end;
    } else {
      // Fallback: baca langsung (mis. event belum datang).
      const frags = hls?.levels?.[hls.currentLevel]?.details?.fragments;
      if (frags && frags.length > 0) {
        const s = frags[0].start;
        const last = frags[frags.length - 1];
        const e = last.start + (last.duration || 0);
        if (typeof s === "number" && Number.isFinite(s)) windowStart = s;
        if (Number.isFinite(e) && e > windowStart) windowEnd = e;
      }
    }
    // #75: fallback JUJUR — 20 dtk setelah manifest dimuat info jendela tak
    // kunjung ada → nyatakan tidak tersedia; UI menampilkan pesan yang
    // benar, bukan "menunggu…" selamanya.
    const dvrState: DvrState =
      windowStart >= 0 && windowEnd > windowStart
        ? "ready"
        : this.manifestAt > 0 &&
            Date.now() - this.manifestAt > DVR_INFO_TIMEOUT_MS
          ? "unavailable"
          : "loading";
    this.playback = {
      pos: video.currentTime,
      bufStart,
      bufEnd,
      edge,
      windowStart,
      windowEnd,
      dvrState,
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
    };
    const range = bufferedAt(video.buffered, video.currentTime);
    const start = this.dvr?.start ?? -1, end = this.dvr?.end ?? -1;
    this.playback = { pos: video.currentTime, bufStart: range?.start ?? -1,
      bufEnd: range?.end ?? -1, edge: end,
      windowStart: range ? Math.min(start >= 0 ? start : range.start, range.start) : start,
      windowEnd: end, dvrState: end > start && start >= 0 ? "ready" :
        Date.now() - this.cycleAt > 20000 ? "unavailable" : "loading" };
  }
  private tick(): void {
    const video = this.video;
    if (!video) return;
    const now = Date.now();
    this.updatePlayback();
    // A seek/source update may abort play() after the buffer gate opens.
    // Retry the desired playback; only explicit user intent keeps it paused.
    if (!this.userPaused && !this.prebuffering && video.paused &&
      (this.status === "loading" || this.status === "delay" || this.status === "live")) this.play();
    this.metrics.uptimeSec = Math.floor((now - this.connectedAt) / 1000);
    if (this.reconnectTimer) this.countdownSec = Math.max(0, Math.ceil((this.reconnectAt - now) / 1000));
    else if (this.prebuffering) {
      if (this.started) this.guardDvrWindow();
      this.tryStart();
      if (this.prebuffering && this.detectionReady && now - this.gateAt > 45000) this.scheduleReconnect("Buffer tidak terisi dalam 45 detik.");
    } else if (this.started && !this.userPaused && (this.status === "delay" || this.status === "live")) {
      this.guardDvrWindow();
      this.status = this.playback.edge - this.playback.pos <= 3 ? "live" : "delay";
    }
    const quality = video.getVideoPlaybackQuality?.();
    if (quality && now - this.prevFramesAt >= 2000) {
      if (this.prevFramesAt) this.metrics.fps = Math.round((quality.totalVideoFrames - this.prevFrames) * 1000 / (now - this.prevFramesAt));
      this.prevFrames = quality.totalVideoFrames; this.prevFramesAt = now;
    }
    if (video.videoWidth) { this.metrics.width = video.videoWidth; this.metrics.height = video.videoHeight; }
    if (now - this.lastTelemetry >= 2000) {
      this.lastTelemetry = now;
      const p = this.playback;
      this.telemetry.push({ t: now, pos: p.pos, bufStart: p.bufStart, bufEnd: p.bufEnd,
        edge: p.edge, delay: p.edge >= 0 ? Math.max(0, p.edge - p.pos) : -1,
        gap: p.bufEnd >= 0 ? Math.max(0, p.bufEnd - p.pos) : 0,
        stalls: this.metrics.stalls, status: this.status, prebuffering: this.prebuffering,
        droppedFrames: quality?.droppedVideoFrames ?? 0 });
      if (this.telemetry.length > 2000) this.telemetry.shift();
    }
    this.emit();
  }
  private log(level: LogLevel, message: string): void {
    this.logEntries.push(makeLogEntry(level, message));
    if (this.logEntries.length > 300) this.logEntries.shift();
    this.emit();
  }
<<<<<<< HEAD
  private snapshot(): StreamSnapshot {
    return { status: this.status, paused: this.paused, prebuffering: this.prebuffering,
      playback: { ...this.playback }, delaySec: this.playback.edge >= 0
        ? Math.max(0, Math.round(this.playback.edge - this.playback.pos)) : 0,
      attempt: this.attempt, maxAttempts: BACKOFF.length, countdownSec: this.countdownSec,
      errorCode: this.errorCode, metrics: { ...this.metrics }, log: [...this.logEntries] };
=======

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearReconnectTimers();
    this.clearStallTimer();
    if (this.resumeWatchdogTimer !== null) {
      clearTimeout(this.resumeWatchdogTimer);
      this.resumeWatchdogTimer = null;
    }
    const timers = [
      this.delayTimer,
      this.uptimeTimer,
      this.fpsTimer,
      this.telemetryTimer,
      this.offlineTimer,
    ];
    for (const t of timers) {
      if (t !== null) clearInterval(t);
    }
    this.delayTimer = this.uptimeTimer = this.fpsTimer = null;
    this.telemetryTimer = null;
    if (this.offlineTimer !== null) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
  }

  private snapshot(): StreamSnapshot {
    return {
      status: this.status,
      paused: this.paused,
      playback: { ...this.playback },
      delaySec: this.delaySec,
      attempt: this.attempt,
      maxAttempts: BACKOFF_MS.length,
      countdownSec: this.countdownSec,
      errorCode: this.errorCode,
      metrics: { ...this.metrics },
      log: [...this.logEntries],
    };
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
  }
  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}
