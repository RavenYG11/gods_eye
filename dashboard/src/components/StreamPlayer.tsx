// Rujukan visual: docs/mockup-dashboard.html (player 16:9 + badge + OSD +
// overlay per state + delay strip + popover metrik).
// Rujukan perilaku: docs/arsitektur.md §4. TIDAK ada panel simulasi —
// semua state di sini berasal dari event nyata hls.js via StreamHealth.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraConfig } from "../config/cameras";
import { formatJamWIB } from "../lib/log";
import type { StreamSession } from "../lib/useStreamSession";
import { useDetection } from "../lib/useDetection";
import { StreamHealthBadge } from "./StreamHealthBadge";
import { DetectionOverlay } from "./DetectionOverlay";

interface Props {
  session: StreamSession;
  camera: CameraConfig;
}

function formatUptime(totalSec: number): string {
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function StreamPlayer({ session, camera }: Props) {
  const { snap, attachVideo, retry, guardDvrWindow } = session;
  const { status, metrics, paused, playback } = snap;
  const playerRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [clock, setClock] = useState(() => formatJamWIB(Date.now()));

  // Ref callback STABIL (useCallback): inline arrow di prop `ref` dibuat
  // ulang tiap render → React detach/attach ulang → engine.attach() tiap
  // render → setStatus → re-render = INFINITE LOOP (temuan uji headless #60).
  // (#69: state `paused` dibaca dari snapshot engine — engine memasang
  // listener play/pause nyata di <video>, bukan tebakan UI.)
  const setVideoRefs = useCallback(
    (el: HTMLVideoElement | null) => {
      attachVideo(el);
      videoRef.current = el;
    },
    [attachVideo],
  );

  // #60: deteksi kendaraan (YOLO26n, worker) — overlay di atas video.
  // #69: paused diteruskan agar loop inferensi berhenti saat video dijeda
  // (frame sama berulang = buang CPU); overlay freeze otomatis via basis
  // video.currentTime (#68) — tidak perlu logika tambahan di sini.
  const detection = useDetection(() => videoRef.current, paused);
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
  // resume(): dipanggil tombol play + klik video. SEBELUM video.play(),
  // penjaga jendela DVR dijalankan dulu: bila pause-nya lama sampai posisi
  // hampir kedaluwarsa dari playlist, posisi dipindah SEKALI ke tempat aman
  // (edge − 25 dtk, jauh dari tepi) — resume tidak pernah menabrak posisi
  // basi → tidak ada seek brutal / rebuffer.
  // pause(): video.pause() saja — overlay #68 memakai basis video.currentTime
  // sehingga box ikut freeze otomatis; guard DVR tetap jalan di tickDelay
  // selama pause agar titik resume selalu valid.
  const resume = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.paused) return;
    guardDvrWindow();
    void v.play().catch(() => undefined);
  }, [guardDvrWindow]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      resume();
    } else {
      v.pause();
    }
  }, [resume]);

  // #69 — TAMPILAN WAKTU. Stream ini LIVE HLS (duration = Infinity) → tidak
  // ada "durasi" klasik. Yang ditampilkan: jarak posisi play dari live edge.
  const behindSec =
    playback.edge >= 0 ? Math.max(0, Math.round(playback.edge - playback.pos)) : -1;
  const timeText = paused
    ? "DIJEDA"
    : behindSec < 0
      ? "–"
      : behindSec <= 3
        ? "LIVE"
        : `−${behindSec} dtk dari live`;
  const timeClass = paused
    ? "paused"
    : behindSec < 0
      ? ""
      : behindSec <= 3
        ? "live"
        : "behind";

  // #69 — BAR JENDELA DVR (display-only, TANPA scrub): kebijakan #68 melarang
  // seek manual user (tiap seek menginvalidasi buffer hls.js → rebuffer).
  // Bar hanya menunjukkan posisi play dalam [windowStart, liveEdge].
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
        " (tampilan saja — kebijakan #68: tanpa scrub/seek manual)";

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
            Tanpa backend, metrik hanya dihitung selama sesi berjalan dan tidak
            disimpan. (§4 butir 5)
          </p>
          {/* #68: bukti uji anti-buffering 10+ menit — log posisi play vs
              ujung buffer vs live edge tiap 2 dtk (format JSON). Kriteria
              lolos: tidak ada siklus buffering berulang dan kolom `gap`
              (bufEnd − pos) tumbuh/stabil, bukan menyusut ke nol. */}
          <button
            type="button"
            className="btn"
            onClick={() => {
              const samples = session.getTelemetry();
              const payload = {
                program: "GODS EYE",
                assignment: 68,
                camera: camera.id,
                exportedAt: new Date().toISOString(),
                sampleIntervalSec: 2,
                // Cara baca: tiap sampel = {t, pos, bufStart, bufEnd, edge,
                // delay (edge−pos), gap (bufEnd−pos), stalls, status}.
                samples,
              };
              const blob = new Blob([JSON.stringify(payload, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `gods-eye-telemetry-${Date.now()}.json`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            }}
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

      {/* Strip delay non-blocking — JUJUR soal keterlambatan (§4, #60).
          Player SENGAJA dijaga ~5 dtk di belakang live edge (anti-buffering,
          trik web resmi Bekasi) — strip ini menjelaskannya, bukan menyembunyikannya. */}
      <div
        id="delayStrip"
        className={status === "delay" ? "show" : ""}
        aria-live="polite"
      >
        {status === "delay" && (
          <>
            Anti-buffering aktif — tertinggal{" "}
            <strong>±{snap.delaySec} dtk</strong> dari siaran langsung (sengaja,
            agar gambar tidak tersendat).
          </>
        )}
      </div>

      {/* #60: status model deteksi (ringkas, tak menutupi video). */}
      {detection.enabled && detection.status === "loading" && (
        <div className="det-chip" role="status">
          Memuat model deteksi…
        </div>
      )}
      {detection.enabled && detection.status === "error" && (
        <button
          type="button"
          className="det-chip error"
          onClick={detection.retry}
          title={detection.error}
        >
          Model deteksi gagal dimuat — klik untuk coba lagi
        </button>
      )}
      {detVisible && (
        <div className="det-chip ok" aria-live="polite">
          Deteksi: {detection.detFps !== null ? `${detection.detFps} fps` : "…"}
          {/* #68: biaya inferensi + execution provider — diagnosis bottleneck
              langsung dari screenshot (bukan tebakan). */}
          {detection.inferMs !== null && ` · ${detection.inferMs}ms`}
          {detection.provider !== null && ` · ${detection.provider}`}
          {Object.entries(detection.counts).map(([label, n]) => (
            <span key={label}>
              {" "}
              · {label}: {n}
            </span>
          ))}
        </div>
      )}

      <button
        id="detBtn"
        type="button"
        aria-label={
          detection.enabled
            ? "Matikan deteksi kendaraan"
            : "Nyalakan deteksi kendaraan"
        }
        aria-pressed={detection.enabled}
        className={detection.enabled ? "on" : ""}
        onClick={detection.toggle}
      >
        ◎
      </button>
      {/* #69: tombol putar/jeda — di kiri tombol deteksi. Ikon mengikuti
          state video (event play/pause, bukan tebakan). */}
      <button
        id="playBtn"
        type="button"
        aria-label={paused ? "Putar stream" : "Jeda stream"}
        aria-pressed={paused}
        className={paused ? "is-paused" : ""}
        onClick={togglePlay}
      >
        {paused ? "▶" : "❚❚"}
      </button>
      {/* #69: chip waktu — offset dari live edge (LIVE HLS: duration tak
          terhingga, jadi ini "durasi" yang bermakna). timeText/timeClass
          dari logika tampilan di atas (DIJEDA/LIVE/−N dtk dari live).
          Tanpa aria-live: teks berubah tiap detik, akan membanjiri
          screen reader bila diumumkan. */}
      <div className={`play-time ${timeClass}`} title={pbTitle}>
        {timeText}
      </div>
      {/* #69: progress bar jendela DVR — visual posisi play dalam
          [windowStart..liveEdge] (barPct). Bukan scrubber (live): hanya
          indikator, kebijakan #68 melarang seek manual. */}
      <div className="dvr-bar" aria-hidden="true" title={pbTitle}>
        <div className="dvr-track">
          <div className="dvr-pos" style={{ left: `${barPct}%` }} />
        </div>
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
