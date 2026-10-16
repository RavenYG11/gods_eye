// Rujukan visual: docs/mockup-dashboard.html (player 16:9 + badge + OSD +
// overlay per state + popover metrik). #71: delay strip & panel deteksi
// dalam player DIHAPUS (strip → panel Log koneksi; deteksi → card kanan).
// Rujukan perilaku: docs/arsitektur.md §4. TIDAK ada panel simulasi —
// semua state di sini berasal dari event nyata hls.js via StreamHealth.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { CameraConfig } from "../config/cameras";
import { formatJamWIB } from "../lib/log";
import { downloadTelemetryJson } from "../lib/telemetry";
import type { StreamSession } from "../lib/useStreamSession";
import type { DetectionState } from "../lib/useDetection";
import { StreamHealthBadge } from "./StreamHealthBadge";
import { DetectionOverlay } from "./DetectionOverlay";

interface Props {
  session: StreamSession;
  camera: CameraConfig;
  /**
   * #71: state deteksi diangkat ke App — card "Deteksi kendaraan" di kanan
   * video me-render indikator + slider confidence + toggle; StreamPlayer
   * hanya memakai overlay box + status visible.
   */
  detection: DetectionState;
  /** #71: App memegang ref video agar hook deteksi bisa membaca frame. */
  videoSinkRef: { current: HTMLVideoElement | null };
}

function formatUptime(totalSec: number): string {
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** #70: jam:menit:detik untuk teks angka di bawah bar DVR (mm:ss bila < 1 jam). */
function formatDvrClock(totalSec: number): string {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function StreamPlayer({ session, camera, detection, videoSinkRef }: Props) {
  const { snap, attachVideo, retry, seekTo, resumePlayback } = session;
  // #71: prebuffering = jeda INTERNAL mesin (bukan user) — chip waktu &
  // tombol play memperlakukannya sebagai "sedang jalan".
  const { status, metrics, paused, playback, prebuffering } = snap;
  const playerRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [clock, setClock] = useState(() => formatJamWIB(Date.now()));
  // #71: patokan lifetime tab — denominator angka durasi ("posisi / total").
  // Di-set sekali saat mount; reset hanya bila tab di-close/restart.
  const bootRef = useRef(Date.now());

  // Ref callback STABIL (useCallback): inline arrow di prop `ref` dibuat
  // ulang tiap render → React detach/attach ulang → engine.attach() tiap
  // render → setStatus → re-render = INFINITE LOOP (temuan uji headless #60).
  // (#69: state `paused` dibaca dari snapshot engine — engine memasang
  // listener play/pause nyata di <video>, bukan tebakan UI.)
  const setVideoRefs = useCallback(
    (el: HTMLVideoElement | null) => {
      attachVideo(el);
      videoRef.current = el;
      // #71: teruskan ke App — hook deteksi (di App) membaca frame dari sini.
      videoSinkRef.current = el;
    },
    [attachVideo, videoSinkRef],
  );

  // #60: deteksi kendaraan (YOLO26n, worker) — overlay di atas video.
  // #71: hook useDetection diangkat ke App (state dipakai panel kanan);
  // StreamPlayer hanya me-render overlay box dari state yang diterima.
  const detVisible =
    detection.enabled && detection.status === "ready";

  // Jam WIB header OSD — tick tiap detik.
  useEffect(() => {
    const t = window.setInterval(
      () => setClock(formatJamWIB(Date.now())),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  // Tutup popover metrik saat klik di luar / tekan Escape.
  useEffect(() => {
    if (!metricsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const pop = document.getElementById("metricsPop");
      const badge = document.getElementById("statusBadge");
      const target = e.target as Node;
      if (pop && !pop.contains(target) && badge && !badge.contains(target)) {
        setMetricsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMetricsOpen(false);
        document.getElementById("statusBadge")?.focus();
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [metricsOpen]);

  const toggleFullscreen = () => {
    const el = playerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen?.();
    }
  };

  // #69 — KONTROL PLAYBACK.
  // #70.3: resume() kini mendelegasikan ke engine.resumePlayback() —
  // guard DVR + clamp jendela + hls.startLoad() + watchdog pemulihan.
  // Menggantikan pola guardDvrWindow()+play() (#69) yang bisa stuck
  // "buffering" selamanya bila posisi kedaluwarsa (bug #70.3).
  // pause(): video.pause() saja — overlay #68 memakai basis video.currentTime
  // sehingga box ikut freeze otomatis. Guard DVR TIDAK lagi jalan selama
  // pause (menarik frame yang sedang dilihat = salah); posisi kedaluwarsa
  // ditangani saat resume.
  const resume = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.paused) return;
    resumePlayback();
  }, [resumePlayback]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      resume();
    } else {
      v.pause();
    }
  }, [resume]);

  // #70.1 — SCRUB DVR BAR (klik / drag / arrow keys). Kebijakan display-only
  // #69 DIBATALKAN atas permintaan Rama: bar kini interaktif. Target seek
  // dijepit engine ke dalam jendela DVR [windowStart..liveEdge].
  const seekRatio = useCallback(
    (ratio: number) => {
      const { windowStart, edge } = playback;
      if (!(windowStart >= 0) || !(edge > windowStart)) return;
      const r = Math.min(1, Math.max(0, ratio));
      seekTo(windowStart + r * (edge - windowStart));
    },
    [playback, seekTo],
  );

  const barSeekFromPointer = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekRatio((clientX - rect.left) / rect.width);
  };

  const onBarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    scrubbingRef.current = true;
    barRef.current?.setPointerCapture(e.pointerId);
    barSeekFromPointer(e.clientX);
  };
  const onBarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbingRef.current) barSeekFromPointer(e.clientX);
  };
  const onBarPointerUp = () => {
    scrubbingRef.current = false;
  };
  const onBarKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const { windowStart, edge, pos } = playback;
    if (!(windowStart >= 0) || !(edge > windowStart)) return;
    const step = (edge - windowStart) / 20; // ±5% jendela per tekan
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekTo(pos - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seekTo(pos + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(windowStart + 1);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(edge - 1);
    }
  };

  // #69 — TAMPILAN WAKTU. Stream ini LIVE HLS (duration = Infinity) → tidak
  // ada "durasi" klasik. Yang ditampilkan: jarak posisi play dari live edge.
  // #71: jeda internal prebuffer (prebuffering) BUKAN jeda user — chip tetap
  // menampilkan offset waktu normal, bukan "DIJEDA".
  const showPaused = paused && !prebuffering;
  const behindSec =
    playback.edge >= 0 ? Math.max(0, Math.round(playback.edge - playback.pos)) : -1;
  const timeText = showPaused
    ? "DIJEDA"
    : behindSec < 0
      ? "–"
      : behindSec <= 3
        ? "LIVE"
        : `−${behindSec} dtk dari live`;
  const timeClass = showPaused
    ? "paused"
    : behindSec < 0
      ? ""
      : behindSec <= 3
        ? "live"
        : "behind";

  // #70.1 — BAR JENDELA DVR KINI BISA DI-SCRUB (klik/drag/arrow keys).
  // Kebijakan display-only #69 DIBATALKAN atas permintaan Rama.
  // Bar menunjukkan posisi play dalam [windowStart, liveEdge]; engine
  // menjepit target seek ke dalam jendela + memberi masa tenggang guard.
  const barPct =
    playback.windowStart >= 0 && playback.edge > playback.windowStart
      ? Math.min(
          100,
          Math.max(
            0,
            ((playback.pos - playback.windowStart) /
              (playback.edge - playback.windowStart)) *
              100,
          ),
        )
      : 0;
  const gapSec =
    playback.bufEnd >= 0 ? Math.max(0, playback.bufEnd - playback.pos) : -1;
  const pbTitle =
    playback.edge < 0
      ? "Info jendela DVR belum tersedia"
      : `Posisi ${playback.pos.toFixed(1)} dtk · jendela DVR ` +
        `${playback.windowStart.toFixed(0)}–${playback.edge.toFixed(0)} dtk` +
        (gapSec >= 0 ? ` · buffer ${gapSec.toFixed(1)} dtk di depan` : "") +
        " · klik/drag/←→ untuk maju-mundur (#70)";

  // #71 — ANGKA DURASI "posisi / total": denominator = LIFETIME sejak
  // tab/web dibuka (reset hanya saat tab di-close/restart), BUKAN panjang
  // jendela DVR. Posisi = posisi playback dalam jendela DVR (tak berubah).
  // Contoh: "00:46 / 12:03".
  const lifetimeSec = Math.max(
    0,
    Math.floor((Date.now() - bootRef.current) / 1000),
  );
  const dvrTimeText =
    playback.windowStart >= 0 && playback.edge > playback.windowStart
      ? `${formatDvrClock(playback.pos - playback.windowStart)} / ${formatDvrClock(lifetimeSec)}`
      : "–";

  const bitrateText =
    metrics.bitrateMbps !== null ? `${metrics.bitrateMbps} Mbps` : "–";
  const resText =
    metrics.width && metrics.height
      ? `${metrics.width} × ${metrics.height}`
      : "–";
  const fpsText = metrics.fps !== null ? String(metrics.fps) : "–";

  return (
    <section
      className="player"
      id="player"
      ref={playerRef}
      aria-label="Pemutar stream CCTV"
    >
      {/* muted: stream CCTV tanpa audio; autoplay policy browser. */}
      <video
        ref={setVideoRefs}
        className="feed"
        muted
        playsInline
        aria-label={`Stream ${camera.name}`}
        // #69: klik video = toggle putar/jeda (standar kontrol pemutar).
        onClick={togglePlay}
      />
      <div className="vignette" aria-hidden="true" />

      {/* #60: overlay box kendaraan (canvas) — di atas video, di bawah badge. */}
      <DetectionOverlay
        getVideo={() => videoRef.current}
        detections={detection.detections}
        visible={detVisible}
      />

      {status === "loading" && (
        <div className="shimmer show" aria-hidden="true" />
      )}

      <StreamHealthBadge
        status={status}
        delaySec={snap.delaySec}
        attempt={snap.attempt}
        maxAttempts={snap.maxAttempts}
        countdownSec={snap.countdownSec}
        metricsOpen={metricsOpen}
        onToggleMetrics={() => setMetricsOpen((o) => !o)}
      />

      {metricsOpen && (
        <div id="metricsPop" className="show" role="dialog" aria-label="Metrik stream sesi berjalan">
          <h3>Metrik sesi berjalan</h3>
          <dl>
            <dt>Bitrate aktif</dt>
            <dd>{bitrateText}</dd>
            <dt>Resolusi</dt>
            <dd>{resText}</dd>
            <dt>FPS (estimasi)</dt>
            <dd>{fpsText}</dd>
            <dt>Stall</dt>
            <dd>{metrics.stalls}×</dd>
            <dt>Reconnect</dt>
            <dd>{metrics.reconnects}×</dd>
            <dt>Uptime sesi</dt>
            <dd>{formatUptime(metrics.uptimeSec)}</dd>
          </dl>
          <p className="note">
            Metrik dihitung di browser selama sesi berjalan dan tidak
            disimpan. (§4 butir 5)
          </p>
          {/* #68: bukti uji anti-buffering 10+ menit — log posisi play vs
              ujung buffer vs live edge tiap 2 dtk (format JSON). Kriteria
              lolos: tidak ada siklus buffering berulang dan kolom `gap`
              (bufEnd − pos) tumbuh/stabil, bukan menyusut ke nol.
              #70.4: tombol yang sama juga ada di panel Log koneksi (App) —
              di sini dipertahankan untuk yang membuka popover metrik. */}
          <button
            type="button"
            className="btn"
            onClick={() => downloadTelemetryJson(session.getTelemetry(), camera.id)}
          >
            Unduh log playback (JSON)
          </button>
        </div>
      )}

      <div className="osd" aria-hidden="true">
        A.YANI–RS MITRA KELUARGA · {clock.replace(" WIB", "")}
      </div>

      {/* Overlay tengah — hanya untuk state yang menghentikan gambar. */}
      {status === "loading" && (
        <div className="overlay show" role="status">
          <div className="spinner" aria-hidden="true" />
          <h2>Memuat stream…</h2>
          <p>Menghubungi kamera CCTV Kota Bekasi.</p>
        </div>
      )}

      {status === "buffering" && (
        <div className="overlay show" role="status">
          <div className="spinner" aria-hidden="true" />
          <h2>Buffering…</h2>
          <p>
            Menunggu data stream. Kondisi normal pada jaringan ini — gambar
            akan lanjut otomatis begitu data tiba.
          </p>
        </div>
      )}

      {status === "reconnecting" && (
        <div className="overlay show" role="status">
          <div className="spinner orange" aria-hidden="true" />
          <h2>
            Menyambung ulang… (percobaan ke-{Math.max(snap.attempt, 1)})
          </h2>
          <p>
            {snap.countdownSec > 0
              ? `Mencoba lagi dalam ${snap.countdownSec} dtk.`
              : "Menghubungi kamera…"}
          </p>
        </div>
      )}

      {status === "offline" && (
        <div className="overlay show" role="status">
          <h2>Stream sedang offline</h2>
          <p>
            Kamera tidak merespons setelah beberapa percobaan. Pemeriksaan
            otomatis tetap berjalan di latar.
          </p>
          <button type="button" className="btn primary" onClick={retry}>
            Coba sambungkan lagi
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="overlay show" role="status">
          <h2>Gagal memuat stream</h2>
          <p>Player tidak dapat memutar stream. Periksa koneksi lalu muat ulang.</p>
          {snap.errorCode && (
            <span className="err-code">{snap.errorCode}</span>
          )}
          <button type="button" className="btn primary" onClick={retry}>
            Muat ulang
          </button>
        </div>
      )}

      {/* #71: strip delay kuning DIHAPUS (permintaan Rama) — info "berapa
          detik tertinggal dari live" pindah ke panel Log koneksi sebagai
          ringkasan (props delaySec/status di ConnectionLog). Badge status
          "● DELAY · ±N dtk" tetap sebagai indikator sekilas. */}
      {/* #71: chip status deteksi + slider confidence + tombol toggle
          deteksi PINDAH ke card "Deteksi kendaraan" di kanan video
          (DetectionPanel) — card video bersih: hanya video + DVR bar +
          kontrol play. */}
      {/* #69: tombol putar/jeda. Ikon mengikuti state video (event
          play/pause, bukan tebakan); #71: jeda internal prebuffer
          ditampilkan sebagai "sedang jalan" (showPaused). */}
      <button
        id="playBtn"
        type="button"
        aria-label={showPaused ? "Putar stream" : "Jeda stream"}
        aria-pressed={showPaused}
        className={showPaused ? "is-paused" : ""}
        onClick={togglePlay}
      >
        {showPaused ? "▶" : "❚❚"}
      </button>
      {/* #69: chip waktu — offset dari live edge (LIVE HLS: duration tak
          terhingga, jadi ini "durasi" yang bermakna). timeText/timeClass
          dari logika tampilan di atas (DIJEDA/LIVE/−N dtk dari live).
          Tanpa aria-live: teks berubah tiap detik, akan membanjiri
          screen reader bila diumumkan.
          #71: tooltip (title) DIHAPUS TOTAL atas permintaan Rama — info
          delay kini di panel Log koneksi. */}
      <div className={`play-time ${timeClass}`}>
        {timeText}
      </div>
      {/* #70.1: bar jendela DVR INTERAKTIF — klik/drag/arrow keys untuk
          maju-mundur dalam [windowStart..liveEdge] (barPct). role=slider
          + aria agar terbaca screen reader & bisa keyboard.
          #71: tooltip (title) DIHAPUS TOTAL atas permintaan Rama
          ("−24 dtk dari live" saat hover). aria-valuetext dipertahankan
          untuk screen reader (bukan tooltip visual). */}
      <div
        ref={barRef}
        className="dvr-bar"
        role="slider"
        tabIndex={0}
        aria-label="Posisi dalam jendela DVR — klik, drag, atau tombol panah untuk maju-mundur"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barPct)}
        aria-valuetext={pbTitle}
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarPointerUp}
        onPointerCancel={onBarPointerUp}
        onKeyDown={onBarKeyDown}
      >
        <div className="dvr-track">
          <div className="dvr-pos" style={{ left: `${barPct}%` }} />
        </div>
      </div>
      {/* #70 (tambahan Rama 21:24): angka durasi TEPAT di bawah bar.
          #71: format "posisi / total" — total = lifetime tab (bukan panjang
          jendela DVR). Tooltip (title) DIHAPUS TOTAL (permintaan Rama). */}
      <div className="dvr-time" aria-hidden="true">
        {dvrTimeText}
      </div>
      <button
        id="fsBtn"
        type="button"
        aria-label="Layar penuh"
        onClick={toggleFullscreen}
      >
        ⛶
      </button>
    </section>
  );
}
