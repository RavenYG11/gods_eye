// Panel "Log koneksi" — instruksi eksplisit Rama (15 Okt 2026):
// layout DI BAWAH video player, full-width horizontal (BUKAN di samping).
// Isi = EVENT NYATA dari player hls.js (connect, buffering/stall, reconnect +
// backoff, error, perubahan bitrate/resolusi) dengan timestamp WIB —
// bukan simulasi. Sumber: StreamHealth.pushLog().

import { useEffect, useRef, useState } from "react";
import { formatWaktuWIB, type LogEntry, type LogLevel } from "../lib/log";

const DOT_CLASS: Record<LogLevel, string> = {
  info: "lg-info",
  ok: "lg-ok",
  warn: "lg-warn",
  error: "lg-error",
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: "INFO",
  ok: "OK",
  warn: "PERINGATAN",
  error: "GALAT",
};

interface Props {
  entries: LogEntry[];
  /**
   * #70.4: unduh log playback (telemetri #68) — tombol di header panel,
   * di samping "Bersihkan". Sebelumnya tombol hanya ada di dalam popover
   * metrik (di balik klik badge) sehingga Rama tidak menemukannya.
   */
  onDownloadLog?: () => void;
}

export function ConnectionLog({ entries, onDownloadLog }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  // "Bersihkan" hanya menyembunyikan tampilan; engine tetap mencatat.
  const [clearedUpTo, setClearedUpTo] = useState(0);
  const visible = entries.filter((e) => e.id > clearedUpTo);

  // Ikuti ekor log hanya bila pengguna sedang di dasar (tidak merampas scroll).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const clearView = () => {
    const last = entries[entries.length - 1];
    if (last) setClearedUpTo(last.id);
  };

  return (
    <section className="log-panel" aria-label="Log koneksi stream">
      <div className="log-head">
        <h2>
          <span className="log-title-dot" aria-hidden="true" />
          Log koneksi
        </h2>
        <div className="log-head-right">
          <span className="log-count" aria-live="polite">
            {visible.length} event
          </span>
          <button
            type="button"
            className="log-clear"
            onClick={clearView}
            disabled={visible.length === 0}
            title="Bersihkan tampilan log (riwayat sesi tetap dicatat engine)"
          >
            Bersihkan
          </button>
          {onDownloadLog && (
            <button
              type="button"
              className="log-dl"
              onClick={onDownloadLog}
              title="Unduh log playback (JSON): posisi play vs ujung buffer vs live edge tiap 2 dtk — bukti uji anti-buffering 10+ menit"
            >
              Unduh log playback
            </button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="log-body"
        role="log"
        aria-label="Riwayat event koneksi stream (waktu WIB)"
        onScroll={onScroll}
      >
        {visible.length === 0 ? (
          <p className="log-empty">
            Belum ada event — log terisi otomatis dari player hls.js
            (connect, buffering, reconnect, error, perubahan kualitas).
          </p>
        ) : (
          <ul className="log-list">
            {visible.map((e) => (
              <li key={e.id} className="log-row">
                <span className="log-time">{formatWaktuWIB(e.t)}</span>
                <span
                  className={`log-level ${DOT_CLASS[e.level]}`}
                  title={LEVEL_LABEL[e.level]}
                >
                  {LEVEL_LABEL[e.level]}
                </span>
                <span className="log-msg">{e.msg}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="log-note">
        Event nyata dari player — tanpa backend, riwayat hanya selama sesi
        berjalan dan tidak disimpan.
      </p>
    </section>
  );
}
