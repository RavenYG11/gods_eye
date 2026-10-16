// Unduh ring buffer telemetri playback (#68) sebagai JSON.
// Dipakai di dua tempat (satu implementasi):
//   - popover metrik StreamPlayer ("Unduh log playback (JSON)")
//   - panel Log koneksi via App ("Unduh log playback") — #70.4: tombolnya
//     harus terlihat jelas, bukan tersembunyi di balik badge.

import type { TelemetrySample } from "./streamHealth";

export function downloadTelemetryJson(
  samples: TelemetrySample[],
  cameraId: string,
): void {
  const payload = {
    program: "GODS EYE",
    camera: cameraId,
    exportedAt: new Date().toISOString(),
    sampleIntervalSec: 2,
    // Cara baca: tiap sampel = {t, pos, bufStart, bufEnd, edge,
    // delay (edge−pos), gap (bufEnd−pos), stalls, status}.
    // Kriteria lolos uji anti-buffering: tidak ada siklus buffering
    // berulang DAN kolom `gap` tumbuh/stabil, bukan menyusut ke nol.
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
}
