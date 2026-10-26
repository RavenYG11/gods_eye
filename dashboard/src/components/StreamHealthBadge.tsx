// Rujukan: docs/arsitektur.md §4 — "satu badge, satu sumber kebenaran".
// Visual 1:1 dari mockup (docs/mockup-dashboard.html): badge selalu terlihat
// di pojok kiri atas video, warna berbeda per status, klik → popover metrik.

import type { StreamStatus } from "../lib/streamHealth";

interface Props {
  status: StreamStatus;
  delaySec: number;
  attempt: number;
  maxAttempts: number;
  countdownSec: number;
  metricsOpen: boolean;
  onToggleMetrics: () => void;
}

const CLASS: Record<StreamStatus, string> = {
  loading: "st-loading",
  live: "st-live",
  delay: "st-delay",
  buffering: "st-buffering",
  reconnecting: "st-reconnecting",
  offline: "st-offline",
  error: "st-error",
};

export function StreamHealthBadge(props: Props) {
  const { status, attempt, countdownSec, metricsOpen, onToggleMetrics } =
    props;

  let label: string;
  switch (status) {
    case "loading":
      label = "MEMUAT…";
      break;
    case "live":
      label = "● LIVE";
      break;
    case "delay":
      return null;
    case "buffering":
      label = "◌ BUFFERING";
      break;
    case "reconnecting":
      label =
        countdownSec > 0
          ? `↻ MENYAMBUNG ULANG · ${countdownSec} dtk`
          : `↻ MENYAMBUNG ULANG · PERCOBAAN KE-${Math.max(attempt, 1)}`;
      break;
    case "offline":
      label = "■ OFFLINE";
      break;
    case "error":
      label = "✕ GALAT";
      break;
  }

  return (
    <button
      id="statusBadge"
      className={CLASS[status]}
      aria-live="polite"
      aria-expanded={metricsOpen}
      aria-controls="metricsPop"
      title="Klik untuk melihat metrik stream"
      onClick={onToggleMetrics}
    >
      <span className="bdot" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
