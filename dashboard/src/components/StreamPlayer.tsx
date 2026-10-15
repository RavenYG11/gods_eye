// Rujukan visual: docs/mockup-dashboard.html (player 16:9 + badge + OSD +
// overlay per state + delay strip + popover metrik).
// Rujukan perilaku: docs/arsitektur.md §4. TIDAK ada panel simulasi —
// semua state di sini berasal dari event nyata hls.js via StreamHealth.

import { useEffect, useRef, useState } from "react";
import type { CameraConfig } from "../config/cameras";
import { formatJamWIB } from "../lib/log";
import type { StreamSession } from "../lib/useStreamSession";
import { StreamHealthBadge } from "./StreamHealthBadge";

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
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [clock, setClock] = useState(() => formatJamWIB(Date.now()));

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
        ref={attachVideo}
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

      {/* Strip delay non-blocking — jujur soal keterlambatan (§4). */}
      <div
        id="delayStrip"
        className={status === "delay" ? "show" : ""}
        aria-live="polite"
      >
        {status === "delay" && (
          <>
            Tertinggal <strong>±{snap.delaySec} dtk</strong> dari siaran
            langsung — menampilkan data terakhir yang diterima.
          </>
        )}
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
