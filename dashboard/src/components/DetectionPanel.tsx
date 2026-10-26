// #71 — Card "Deteksi kendaraan" di SEBELAH KANAN card video.
// Dipindah dari dalam StreamPlayer (chip .det-chip + slider .det-threshold
// + tombol #detBtn) agar card video bersih: hanya video + DVR bar +
// kontrol play. Responsif: di layar sempit card turun ke bawah video
// (CSS .stage, styles.css).

import type { DetectionState } from "../lib/useDetection";

interface Props {
  detection: DetectionState;
}

export function DetectionPanel({ detection }: Props) {
  const {
    status,
    enabled,
    detFps,
    inferMs,
    provider,
    counts,
    error,
    toggle,
    retry,
  } = detection;

  const statusText =
    status === "loading"
      ? "Memuat model…"
      : status === "error"
        ? "Gagal dimuat"
        : status === "off"
          ? "Nonaktif"
          : "Aktif";

  const statusClass =
    status === "ready" && enabled
      ? "dp-on"
      : status === "error"
        ? "dp-err"
        : "dp-off";

  return (
    <aside className="det-panel" aria-label="Panel deteksi kendaraan">
      <div className="dp-head">
        <h2>
          <span className={`dp-dot ${statusClass}`} aria-hidden="true" />
          Deteksi kendaraan
        </h2>
        <span className={`dp-status ${statusClass}`}>{statusText}</span>
      </div>

      {status === "loading" && (
        <p className="dp-note" role="status">
          Memuat model deteksi (YOLO26n, ONNX di worker)…
        </p>
      )}

      {status === "error" && (
        <div className="dp-error" role="alert">
          <p>Model deteksi gagal dimuat.</p>
          <p>{error}</p>
          <button
            type="button"
            className="btn"
            onClick={retry}
            title={error}
          >
            Coba lagi
          </button>
        </div>
      )}

      {status === "ready" && enabled && (
        <p className="dp-indicator" aria-live="polite">
          Deteksi: {detFps !== null ? `${detFps} fps` : "…"}
          {/* #68: biaya inferensi + execution provider — diagnosis
              bottleneck langsung dari screenshot (bukan tebakan). */}
          {inferMs !== null && ` · ${inferMs}ms`}
          {provider !== null && ` · ${provider}`}
          {detection.trackingFps !== null && ` · tracking ${detection.trackingFps} fps`}
        </p>
      )}

      {status === "ready" && enabled && (
        <div className="dp-note" aria-live="polite">
          <p>Terlihat: mobil {counts.mobil ?? 0} · motor {counts.motor ?? 0}</p>
          <p>Masuk Bekasi (sesi ini): mobil {detection.enteredCounts.mobil ?? 0} · motor {detection.enteredCounts.motor ?? 0}</p>
        </div>
      )}

      {status === "off" && (
        <p className="dp-note">
          Deteksi nonaktif — overlay box kendaraan disembunyikan.
        </p>
      )}

      <button
        type="button"
        className={`btn dp-toggle ${enabled ? "is-on" : ""}`}
        onClick={toggle}
        aria-pressed={enabled}
      >
        {enabled ? "Matikan deteksi" : "Nyalakan deteksi"}
      </button>

      <p className="dp-hint">
        Fokus ruas menuju Bekasi (ke atas). Area masuk kanan bawah diprioritaskan,
        termasuk kendaraan yang baru terlihat sebagian. Kendaraan di seberang
        median disembunyikan. Hitungan bertambah sekali setelah gerak ke atas
        terkonfirmasi. Hitungan sesi diulang saat seek, memuat ulang, atau menyalakan ulang deteksi.
      </p>
    </aside>
  );
}
