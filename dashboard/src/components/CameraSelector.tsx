// Rujukan: docs/arsitektur.md §3 + §7.
// v0.1 dikunci 1 kamera → select DISABLED berisi 1 item. Struktur data sudah
// list (CAMERAS) agar multi-kamera tinggal tambah entri di config/cameras.ts.

import { CAMERAS } from "../config/cameras";

export function CameraSelector() {
  return (
    <div className="cam-left">
      <label htmlFor="camSelect">Kamera (v0.1: 1 kamera)</label>
      <select
        id="camSelect"
        disabled
        title="Multi-kamera tersedia di versi berikutnya — v0.1 dikunci 1 kamera"
        defaultValue={CAMERAS[0].id}
      >
        {CAMERAS.map((cam) => (
          <option key={cam.id} value={cam.id}>
            {cam.name}
          </option>
        ))}
      </select>
      <div className="cam-meta">
        <span>📍 {CAMERAS[0].location ?? "—"}</span>
        <span className="mono">ID: {CAMERAS[0].id}</span>
      </div>
    </div>
  );
}
