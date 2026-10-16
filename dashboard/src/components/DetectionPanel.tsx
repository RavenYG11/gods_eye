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
    threshold,
    setThreshold,
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
          {Object.entries(counts).map(([label, n]) => (
            <span key={label}>
              {" "}
              · {label}: {n}
            </span>
          ))}
        </p>
      )}

      {status === "off" && (
        <p className="dp-note">
          Deteksi nonaktif — overlay box kendaraan disembunyikan.
        </p>
      )}

      {/* #62/#71: slider ambang confidence (0,10–0,90) — live ke worker
          via setThreshold, tanpa reload model. Mitigasi false positive
          (naikkan bila box ngaco, turunkan bila kendaraan tak terdeteksi). */}
      {(status === "ready" || status === "off") && (
        <div className="dp-threshold">
          <label htmlFor="thresholdRange">Confidence</label>
          <input
            id="thresholdRange"
            type="range"
            min={0.1}
            max={0.9}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            title="Ambang confidence deteksi (0,10–0,90) — berlaku langsung"
            disabled={!enabled}
          />
          <output>{threshold.toFixed(2)}</output>
        </div>
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
        Seed dataset: <span className="mono">dashboard/public/dataset/</span>{" "}
        (docs/dataset.md)
      </p>
    </aside>
  );
}
