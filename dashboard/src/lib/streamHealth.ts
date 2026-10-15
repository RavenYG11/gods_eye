// Rujukan: docs/arsitektur.md §4 (mesin status + auto-reconnect + metrik)
// + instruksi Rama 15 Okt 2026 (panel "Log koneksi" = EVENT NYATA hls.js).
//
// Kelas ini adalah SATU-SATUNYA tempat logika stream tinggal:
//  - memasang hls.js ke <video>,
//  - menerjemahkan event hls.js → status (LIVE/DELAY/BUFFERING/
//    RECONNECTING/OFFLINE/ERROR) + entri log koneksi,
//  - auto-reconnect dengan backoff 1→2→5→15→30 dtk,
//  - metrik sesi (bitrate, resolusi, fps estimasi, stall, reconnect, uptime).
//
// Komponen React hanya me-render snapshot — tidak ada logika hls.js di UI.

import Hls, {
  type ErrorData,
  type LevelSwitchedData,
  type ManifestParsedData,
} from "hls.js";
import type { CameraConfig } from "../config/cameras";
import { getStreamUrl } from "../config/cameras";
import { makeLogEntry, type LogEntry, type LogLevel } from "./log";

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

/** Jadwal backoff antar percobaan reconnect (ms): 1→2→5→15→30 dtk. */
const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
/** Batas log agar memori tidak tumbuh tanpa batas (entri terlama dibuang). */
const MAX_LOG = 300;
/** Ambang LIVE vs DELAY: frame ≤ 3 dtk dari ujung playlist = LIVE. */
const LIVE_THRESHOLD_SEC = 3;
/**
 * ANTI-BUFFERING — intentional delay (#60, temuan Rama 15 Okt 2026):
 * web resmi CCTV Bekasi tidak kelihatan buffering karena stream-nya SENGAJA
 * di-delay beberapa detik di belakang live edge (bukti: seret playhead ke
 * posisi terbaru → buffering langsung muncul). Kita tiru trik itu: player
 * dijaga ~5 dtk di belakang live edge. Ditampilkan JUJUR di UI (strip delay
 * "±5 dtk") — bukan disembunyikan.
 */
const INTENTIONAL_DELAY_SEC = 5;
/** Bila offset menyusut di bawah ini (hanyut ke live edge), dorong balik. */
const DELAY_NUDGE_FLOOR_SEC = 2;
/** Cooldown antar dorongan balik (ms) agar tidak seek berulang. */
const DELAY_NUDGE_COOLDOWN_MS = 10_000;
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

export class StreamHealth {
  private hls: Hls | null = null;
  private video: HTMLVideoElement | null = null;
  private camera: CameraConfig | null = null;
  private listeners = new Set<Listener>();
  private logEntries: LogEntry[] = [];

  private status: StreamStatus = "loading";
  private delaySec = 0;
  private attempt = 0; // 0 = belum ada percobaan; 1..5 saat reconnecting
  private countdownSec = 0;
  private errorCode = "";
  private metrics: StreamMetrics = { ...EMPTY_METRICS };

  private reconnectTimer: number | null = null;
  private countdownTimer: number | null = null;
  private delayTimer: number | null = null;
  private uptimeTimer: number | null = null;
  private fpsTimer: number | null = null;
  private stallTimer: number | null = null;
  private offlineTimer: number | null = null;
  private mediaRecoverTried = false;
  private prevFrames = 0;
  private prevFramesAt = 0;
  private nativeHls = false;
  private lastDelayNudgeAt = 0;

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
    if (this.status === "buffering") {
      this.clearStallTimer();
      this.pushLog("ok", "Data stream kembali — pemutaran lanjut.");
      this.setStatus("live");
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
  }

  attach(video: HTMLVideoElement, camera: CameraConfig): void {
    this.detach();
    this.video = video;
    this.camera = camera;
    video.addEventListener("waiting", this.onVideoWaiting);
    video.addEventListener("playing", this.onVideoPlaying);
    this.pushLog("info", `Memuat manifest HLS kamera "${camera.id}"…`);
    this.setStatus("loading");
    this.startCycle();
    this.delayTimer = window.setInterval(() => this.tickDelay(), 1000);
    this.uptimeTimer = window.setInterval(() => {
      this.metrics.uptimeSec += 1;
      this.emit();
    }, 1000);
    this.fpsTimer = window.setInterval(() => this.tickFps(), 2000);
  }

  detach(): void {
    this.clearAllTimers();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.video) {
      this.video.removeEventListener("waiting", this.onVideoWaiting);
      this.video.removeEventListener("playing", this.onVideoPlaying);
      this.unbindNativeEvents(this.video);
      this.video.removeAttribute("src");
      this.video.load();
      this.video = null;
    }
    this.nativeHls = false;
  }

  // ---------- Siklus hidup koneksi ----------

  /** Satu siklus = (hancurkan instance lama) + instance hls.js baru. */
  private startCycle(): void {
    const video = this.video;
    const camera = this.camera;
    if (!video || !camera) return;

    // Fix bug CORS #58: URL efektif — proksi /cctv/* saat DEV, URL absolut
    // saat PROD. Definisi tunggal di config/cameras.ts.
    const streamUrl = getStreamUrl(camera);

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    // Fallback Safari: HLS native tanpa hls.js (event terbatas).
    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        this.nativeHls = true;
        this.pushLog(
          "warn",
          "Browser memakai HLS native — sebagian event detail tidak tersedia.",
        );
        video.src = streamUrl;
        video.play().catch(() => undefined);
        this.bindNativeEvents(video);
        this.setStatus("loading");
      } else {
        this.fail("HLS tidak didukung browser ini.");
      }
      return;
    }

    this.nativeHls = false;
    const hls = new Hls({
      enableWorker: true,
      manifestLoadingMaxRetry: 2,
      manifestLoadingRetryDelay: 2000,
      levelLoadingMaxRetry: 3,
      levelLoadingRetryDelay: 2000,
      fragLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 2000,
      maxBufferLength: 30,
      // #60 anti-buffering: JANGAN kejar live edge dengan mempercepat playback.
      // Offset ~5 dtk dijaga manual (applyIntentionalDelay) agar stabil.
      maxLiveSyncPlaybackRate: 1,
    });
    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data: ManifestParsedData) => {
      this.attempt = 0;
      this.mediaRecoverTried = false;
      const levels = data.levels?.length ?? 0;
      const wasReconnecting = this.status === "reconnecting";
      if (wasReconnecting) {
        this.metrics.reconnects += 1;
        this.pushLog("ok", "Tersambung kembali — manifest dimuat ulang.");
      } else {
        this.pushLog(
          "ok",
          `Terhubung — manifest dimuat (${levels} level kualitas tersedia).`,
        );
      }
      // #60: mulai (dan tiap reconnect) langsung di posisi liveEdge − 5 dtk.
      this.applyIntentionalDelay("start");
      this.setStatus("live");
      video.play().catch(() => {
        this.pushLog(
          "warn",
          "Autoplay ditahan browser — klik video untuk memutar manual.",
        );
      });
    });

    hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
      this.onHlsError(data);
    });

    // BUFFER_STALLED = player kehabisan data → BUFFERING (§4).
    // hls.js internal melaporkan stall yang berhasil diatasi sendiri:
    hls.on(Hls.Events.STALL_RESOLVED, () => {
      this.pushLog("ok", "hls.js: stall teratasi.");
    });

    // Data kembali mengalir → pulih dari BUFFERING.
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (this.status === "buffering") {
        this.clearStallTimer();
        this.pushLog("ok", "Data stream kembali — pemutaran lanjut.");
        this.setStatus("live");
      }
    });

    // Perubahan bitrate/resolusi = event nyata untuk Log koneksi.
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data: LevelSwitchedData) => {
      const level = hls.levels[data.level];
      if (!level) return;
      this.metrics.bitrateMbps = +(level.bitrate / 1_000_000).toFixed(1);
      this.metrics.width = level.width ?? null;
      this.metrics.height = level.height ?? null;
      this.pushLog(
        "info",
        `Kualitas berubah: ${this.metrics.bitrateMbps} Mbps · ${level.width}×${level.height}.`,
      );
      this.emit();
    });

    hls.loadSource(streamUrl);
    hls.attachMedia(video);
  }

  private onHlsError(data: ErrorData): void {
    const detail = data.details || "unknown";
    if (!data.fatal) {
      this.pushLog("warn", `Peringatan hls.js (non-fatal): ${detail}.`);
      return;
    }

    // Fatal saat satu percobaan reconnect sedang berjalan → percobaan gagal,
    // lanjut ke backoff berikutnya (bukan siklus reconnect baru).
    if (this.status === "reconnecting") {
      this.onAttemptFailed(detail);
      return;
    }

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      this.pushLog(
        "error",
        `Galat media (fatal): ${detail} — mencoba pemulihan cepat.`,
      );
      // Satu kali recoverMediaError per siklus; bila gagal → reconnect penuh.
      if (!this.mediaRecoverTried && this.hls) {
        this.mediaRecoverTried = true;
        try {
          this.hls.recoverMediaError();
          this.pushLog("info", "Pemulihan media dijalankan, memantau hasil…");
          return;
        } catch {
          // jatuh ke reconnect di bawah
        }
      }
      this.beginReconnect(`galat media (${detail})`);
      return;
    }

    // NETWORK_ERROR fatal (manifest/level/frag gagal total setelah retry).
    this.pushLog("error", `Galat jaringan (fatal): ${detail}.`);
    this.beginReconnect(`galat jaringan (${detail})`);
  }

  /** Satu percobaan reconnect gagal → jadwalkan backoff berikutnya. */
  private onAttemptFailed(detail: string): void {
    this.clearReconnectTimers();
    this.pushLog("warn", `Percobaan ke-${this.attempt} gagal: ${detail}.`);
    this.scheduleNextAttempt();
  }

  // ---------- Reconnect dengan backoff ----------

  /** Guard: jangan tumpuk siklus reconnect (§4 butir 3). */
  private beginReconnect(reason: string): void {
    if (this.status === "reconnecting" || this.status === "offline") return;
    this.clearStallTimer();
    this.attempt = 0;
    this.pushLog(
      "warn",
      `Menyambung ulang: ${reason}. Backoff 1→2→5→15→30 dtk.`,
    );
    this.setStatus("reconnecting");
    this.scheduleNextAttempt();
  }

  private scheduleNextAttempt(): void {
    this.clearReconnectTimers();
    if (this.attempt >= BACKOFF_MS.length) {
      this.goOffline();
      return;
    }
    const waitMs = BACKOFF_MS[this.attempt];
    this.countdownSec = Math.round(waitMs / 1000);
    this.emit();
    this.countdownTimer = window.setInterval(() => {
      this.countdownSec = Math.max(0, this.countdownSec - 1);
      this.emit();
    }, 1000);
    this.reconnectTimer = window.setTimeout(() => {
      this.attempt += 1;
      this.countdownSec = 0;
      this.pushLog(
        "info",
        `Percobaan ke-${this.attempt}/${BACKOFF_MS.length} — memuat ulang stream…`,
      );
      this.setStatus("reconnecting");
      this.startCycle();
      // Bila MANIFEST_PARSED tidak datang dan tidak ada ERROR fatal,
      // watchdog di bawah yang melanjutkan ke backoff berikutnya.
      this.clearReconnectTimers();
      this.armWatchdog();
    }, waitMs);
  }

  /**
   * Watchdog: bila satu percobaan tidak menghasilkan MANIFEST_PARSED maupun
   * ERROR fatal dalam 20 dtk, anggap gagal dan lanjut ke backoff berikutnya.
   */
  private armWatchdog(): void {
    this.reconnectTimer = window.setTimeout(() => {
      if (this.status === "reconnecting") {
        this.pushLog(
          "warn",
          `Percobaan ke-${this.attempt} tidak merespons dalam 20 dtk.`,
        );
        this.scheduleNextAttempt();
      }
    }, 20_000);
  }

  private goOffline(): void {
    this.clearReconnectTimers();
    this.setStatus("offline");
    this.pushLog(
      "error",
      "Backoff habis (5 percobaan) — stream offline sementara. Pemeriksaan otomatis tetap berjalan tiap 60 dtk.",
    );
    this.offlineTimer = window.setTimeout(() => {
      if (this.status === "offline") {
        this.pushLog("info", "Pemeriksaan latar: mencoba sambung ulang…");
        this.retry();
      }
    }, OFFLINE_RETRY_MS);
  }

  private downgradeOnLongStall(): void {
    const hls = this.hls;
    if (this.status !== "buffering" || !hls) return;
    const levels = hls.levels?.length ?? 0;
    if (levels > 1 && hls.currentLevel > 0) {
      hls.nextLevel = hls.currentLevel - 1;
      const target = hls.levels[hls.nextLevel];
      this.pushLog(
        "warn",
        `Stall > 10 dtk — menurunkan kualitas ke ${(target.bitrate / 1_000_000).toFixed(1)} Mbps agar stream lanjut.`,
      );
    } else {
      this.pushLog(
        "warn",
        "Stall > 10 dtk — hanya 1 level kualitas tersedia, menunggu data.",
      );
    }
  }

  private fail(code: string): void {
    this.errorCode = code;
    this.setStatus("error");
    this.pushLog("error", `Gagal memuat stream: ${code}`);
  }

  // ---------- Ticker ----------

  /** Hitung delay dari live edge tiap detik → LIVE vs DELAY (§4 butir 1). */
  private tickDelay(): void {
    const hls = this.hls;
    const video = this.video;
    if (
      !hls ||
      !video ||
      (this.status !== "live" && this.status !== "delay")
    ) {
      return;
    }
    const edge = hls.liveSyncPosition;
    if (typeof edge !== "number" || !Number.isFinite(edge)) return;
    if (video.currentTime <= 0) return;
    const delay = Math.max(0, edge - video.currentTime);

    // #60: pertahankan offset anti-buffering —
    //  - hanyut terlalu dekat ke live edge (< 2 dtk) → dorong balik ke −5 dtk
    //    (terlalu dekat = risiko buffering, ini inti trik Bekasi);
    //  - tertinggal terlalu jauh (> 15 dtk, mis. setelah stall panjang) →
    //    lompat maju ke −5 dtk (strip berjanji "±5 dtk" — tepati).
    if (delay < DELAY_NUDGE_FLOOR_SEC || delay > INTENTIONAL_DELAY_SEC * 3) {
      this.applyIntentionalDelay("nudge");
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
   * #60 anti-buffering: set posisi play ke (liveEdge − 5 dtk).
   * Dipanggil saat start/reconnect ("start") dan saat offset menyusut
   * ("nudge", dibatasi cooldown). Reconnect logic existing tidak diubah —
   * fungsi ini hanya menggeser posisi setelah stream tersambung.
   */
  private applyIntentionalDelay(reason: "start" | "nudge"): void {
    const hls = this.hls;
    const video = this.video;
    if (!hls || !video) return;
    const edge = hls.liveSyncPosition;
    if (typeof edge !== "number" || !Number.isFinite(edge) || edge <= 0) return;

    const target = Math.max(0, edge - INTENTIONAL_DELAY_SEC);
    const gap = Math.abs(video.currentTime - target);
    if (reason === "start" && gap < 1.5) return; // sudah di posisi benar
    if (reason === "nudge") {
      const now = Date.now();
      if (now - this.lastDelayNudgeAt < DELAY_NUDGE_COOLDOWN_MS) return;
      this.lastDelayNudgeAt = now;
    }
    try {
      video.currentTime = target;
      this.pushLog(
        "info",
        `Anti-buffering: posisi diset ${INTENTIONAL_DELAY_SEC} dtk di belakang ` +
          `live edge (trik web resmi Bekasi — delay tampil jujur di strip bawah).`,
      );
    } catch {
      // seek gagal (mis. belum ada buffer) — biarkan hls.js yang mengatur.
    }
  }

  /** Estimasi fps dari delta totalVideoFrames (Chromium). */
  private tickFps(): void {
    const video = this.video;
    if (!video || (this.status !== "live" && this.status !== "delay")) {
      return;
    }
    try {
      const q = video.getVideoPlaybackQuality();
      const now = Date.now();
      if (this.prevFramesAt > 0) {
        const dt = (now - this.prevFramesAt) / 1000;
        if (dt > 0) {
          this.metrics.fps = Math.round(
            (q.totalVideoFrames - this.prevFrames) / dt,
          );
        }
      }
      this.prevFrames = q.totalVideoFrames;
      this.prevFramesAt = now;
      this.emit();
    } catch {
      // getVideoPlaybackQuality tidak tersedia — fps tetap null ("–").
    }
  }

  /** Event minimal untuk mode HLS native (Safari). 'waiting'/'playing'
   *  saat stall sudah ditangani handler bersama di atas; di sini hanya
   *  transisi loading → live (tidak ada MANIFEST_PARSED di mode native). */
  private onNativePlaying = (): void => {
    if (this.nativeHls && this.status === "loading") {
      this.pushLog("ok", "Terhubung (HLS native) — pemutaran berjalan.");
      this.setStatus("live");
    }
  };

  private onNativeError = (): void => {
    if (this.nativeHls) this.fail("VIDEO_ERROR (HLS native)");
  };

  private bindNativeEvents(video: HTMLVideoElement): void {
    video.addEventListener("playing", this.onNativePlaying);
    video.addEventListener("error", this.onNativeError);
  }

  private unbindNativeEvents(video: HTMLVideoElement): void {
    video.removeEventListener("playing", this.onNativePlaying);
    video.removeEventListener("error", this.onNativeError);
  }

  // ---------- Util internal ----------

  private setStatus(s: StreamStatus): void {
    this.status = s;
    this.emit();
  }

  private pushLog(level: LogLevel, msg: string): void {
    this.logEntries.push(makeLogEntry(level, msg));
    if (this.logEntries.length > MAX_LOG) {
      this.logEntries.splice(0, this.logEntries.length - MAX_LOG);
    }
    this.emit();
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearReconnectTimers();
    this.clearStallTimer();
    const timers = [
      this.delayTimer,
      this.uptimeTimer,
      this.fpsTimer,
      this.offlineTimer,
    ];
    for (const t of timers) {
      if (t !== null) clearInterval(t);
    }
    this.delayTimer = this.uptimeTimer = this.fpsTimer = null;
    if (this.offlineTimer !== null) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
  }

  private snapshot(): StreamSnapshot {
    return {
      status: this.status,
      delaySec: this.delaySec,
      attempt: this.attempt,
      maxAttempts: BACKOFF_MS.length,
      countdownSec: this.countdownSec,
      errorCode: this.errorCode,
      metrics: { ...this.metrics },
      log: [...this.logEntries],
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // Satu listener gagal tidak boleh meruntuhkan mesin stream.
      }
    }
  }
}
