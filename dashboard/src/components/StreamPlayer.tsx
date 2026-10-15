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
  const { snap, attachVideo, retry } = session;
  const { status, metrics } = snap;
  const playerRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [clock, setClock] = useState(() => formatJamWIB(Date.now()));

  // Ref callback STABIL (useCallback): inline arrow di prop `ref` dibuat
  // ulang tiap render → React detach/attach ulang → engine.attach() tiap
  // render → setStatus → re-render = INFINITE LOOP (temuan uji headless #60).
  const setVideoRefs = useCallback(
    (el: HTMLVideoElement | null) => {
      attachVideo(el);
      videoRef.current = el;
    },
    [attachVideo],
  );

  // #60: deteksi kendaraan (YOLO26n, worker) — overlay di atas video.
  const detection = useDetection(() => videoRef.current);
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
        onClick={(e) => {
          const v = e.currentTarget;
          if (v.paused) void v.play().catch(() => undefined);
        }}
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
