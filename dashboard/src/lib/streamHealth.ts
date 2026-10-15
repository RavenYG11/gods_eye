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
 * #69 — INFO PLAYBACK TERKINI (bahan kontrol play/pause + tampilan waktu +
 * bar jendela DVR). Diperbarui tiap 1 dtk oleh tickDelay() — selalu nilai
 * TERBARU (bukan ring buffer seperti telemetri #68). Nilai −1 = tak tersedia
 * saat itu (jujur, bukan nol).
 */
export interface PlaybackInfo {
  /** video.currentTime (dtk). */
  pos: number;
  /** buffered.start(0) (dtk); −1 bila buffer kosong. */
  bufStart: number;
  /** buffered.end(terakhir) (dtk); −1 bila buffer kosong. */
  bufEnd: number;
  /** hls.liveSyncPosition (dtk); −1 bila tak diketahui. */
  edge: number;
  /** Awal sliding window playlist (frags[0].start, dtk); −1 bila tak diketahui. */
  windowStart: number;
}

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
 * (edge − 25 dtk) — bukan ke tepi.
 */
/**
 * #68: PENJAGA JENDELA DVR — trigger bila sisa jendela playlist di belakang
 * posisi play kurang dari ini. BUKAN timer catch-up: hanya aktif bila posisi
 * benar-benar hampir kedaluwarsa (data dari level.details.fragments).
 */
const DVR_GUARD_MARGIN_SEC = 10;
/** #68: target seek penjaga DVR — tetap 25 dtk di belakang live edge (jauh dari tepi, cushion tebal). */
const DVR_SAFE_BEHIND_SEC = 25;
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
  /** #69: state jeda dari event play/pause nyata <video> (bukan tebakan UI). */
  private paused = false;
  /** #69: info playback terkini (pos/buffer/edge/window), refresh tiap 1 dtk. */
  private playback: PlaybackInfo = {
    pos: 0,
    bufStart: -1,
    bufEnd: -1,
    edge: -1,
    windowStart: -1,
  };
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
  private telemetryTimer: number | null = null;
  /** #68: ring buffer sampel playback (bukti uji 10+ menit). */
  private telemetry: TelemetrySample[] = [];
  private mediaRecoverTried = false;
  private prevFrames = 0;
  private prevFramesAt = 0;
  private nativeHls = false;

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
  }

  attach(video: HTMLVideoElement, camera: CameraConfig): void {
    this.detach();
    this.video = video;
    this.camera = camera;
    video.addEventListener("waiting", this.onVideoWaiting);
    video.addEventListener("playing", this.onVideoPlaying);
    // #69: lacak jeda user dari event nyata (tombol play/pause + klik video).
    video.addEventListener("play", this.onVideoPlay);
    video.addEventListener("pause", this.onVideoPause);
    this.pushLog("info", `Memuat manifest HLS kamera "${camera.id}"…`);
    this.setStatus("loading");
    this.startCycle();
    this.delayTimer = window.setInterval(() => this.tickDelay(), 1000);
    this.uptimeTimer = window.setInterval(() => {
      this.metrics.uptimeSec += 1;
      this.emit();
    }, 1000);
    this.fpsTimer = window.setInterval(() => this.tickFps(), 2000);
    // #68: sampling telemetri playback tiap 2 dtk (bukti uji 10+ menit).
    this.telemetryTimer = window.setInterval(
      () => this.tickTelemetry(),
      TELEMETRY_INTERVAL_MS,
    );
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
      this.video.removeEventListener("play", this.onVideoPlay);
      this.video.removeEventListener("pause", this.onVideoPause);
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
      // #66: maxBufferLength 30 dtk dipertahankan — untuk LIVE, buffer maju
      // memang dibatasi live edge (cushion ±5 dtk, lihat bawah); angka lebih
      // besar tidak menambah ketahanan jitter. Jitter ditangani di (a)
      // keep-alive proksi dan (b) tanpa seek manual.
      maxBufferLength: 30,
      // #66: offset anti-buffering ±5 dtk DITANGANI NATIF oleh hls.js —
      // BUKAN via seek manual. Seek manual tiap detik (pola #60) berkelahi
      // dengan manajemen buffer internal hls.js: tiap seek menginvalidasi
      // buffer → siklus rebuffer = buffering 80% (laporan Rama).
      // liveSyncDuration: 5 → hls.js menargetkan posisi TEPAT 5 dtk di
      // belakang live edge (detik, bukan kelipatan durasi segmen — presisi,
      // selaras janji strip "±5 dtk"). Diverifikasi di hls.js 1.7.3
      // (latency-controller: targetLatency = liveSyncDuration bila di-set).
      liveSyncDuration: 5,
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
      // #66: TIDAK ADA seek manual saat start — hls.js dengan
      // liveSyncDuration: 5 otomatis mulai 5 dtk di belakang live edge.
      // Seek manual di sini (pola #60) mengganggu stabilisasi buffer
      // awal dan memicu rebuffer.
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
    const video = this.video;
    if (!video) return;
    // #69: info playback terkini (pos/buffer/edge/window) SELALU di-refresh
    // tiap detik — terpisah dari logika status di bawah, karena kontrol
    // play/pause + tampilan waktu butuh datanya di semua state sesi berjalan.
    this.updatePlaybackInfo();
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
    if (this.dvrWindowGuard()) {
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
    // Masih aman: lebih dari margin di dalam jendela → tidak usah apa-apa.
    if (pos > windowStart + DVR_GUARD_MARGIN_SEC) return false;

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
   * #69: baca posisi/buffer/edge/window terkini dari <video> + hls.js.
   * Dipanggil tiap 1 dtk oleh tickDelay(). UI me-render dari snapshot —
   * tidak ada pembacaan video langsung di komponen (konsisten §4).
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
    this.playback = {
      pos: video.currentTime,
      bufStart,
      bufEnd,
      edge,
      windowStart: this.dvrWindowStart(),
    };
  }

  /** #69: awal sliding window playlist (frags[0].start); −1 bila tak diketahui. */
  private dvrWindowStart(): number {
    const hls = this.hls;
    const frags = hls?.levels?.[hls.currentLevel]?.details?.fragments;
    if (!frags || frags.length === 0) return -1;
    const s = frags[0].start;
    return typeof s === "number" && Number.isFinite(s) ? s : -1;
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

  /**
   * #68: satu sampel telemetri playback → ring buffer.
   * Hanya dicatat saat status live/delay/buffering (sesi berjalan).
   * bufStart/bufEnd/edge = −1 bila tak tersedia saat itu (jujur, bukan nol).
   */
  private tickTelemetry(): void {
    const hls = this.hls;
    const video = this.video;
    if (
      !video ||
      (this.status !== "live" &&
        this.status !== "delay" &&
        this.status !== "buffering")
    ) {
      return;
    }
    let bufStart = -1;
    let bufEnd = -1;
    try {
      const b = video.buffered;
      if (b.length > 0) {
        bufStart = b.start(0);
        bufEnd = b.end(b.length - 1);
      }
    } catch {
      // buffered tak terbaca — biarkan −1.
    }
    const edge =
      hls && typeof hls.liveSyncPosition === "number"
        ? hls.liveSyncPosition
        : -1;
    const pos = video.currentTime;
    this.telemetry.push({
      t: Date.now(),
      pos,
      bufStart,
      bufEnd,
      edge,
      delay: edge >= 0 ? edge - pos : -1,
      gap: bufEnd >= 0 ? bufEnd - pos : -1,
      stalls: this.metrics.stalls,
      status: this.status,
    });
    if (this.telemetry.length > TELEMETRY_MAX) {
      this.telemetry.splice(0, this.telemetry.length - TELEMETRY_MAX);
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
