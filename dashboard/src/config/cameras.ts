// Rujukan: docs/arsitektur.md §3 + Addendum #59 (backend fullstack)
// ATURAN KERAS: URL stream JANGAN hardcode di komponen. Semua URL hidup di
// file ini. Ganti/tambah kamera = edit file ini saja, tanpa sentuh komponen.
//
// ARSITEKTUR STREAM (#59, Gunet 2026-10-15):
// app SELALU memakai path relatif "/cctv/…" (same-origin). Yang melayani
// path itu tergantung mode jalan:
//   - DEV  (npm run dev)  → proksi Vite (server.proxy di vite.config.ts)
//   - PROD (backend)      → reverse proxy Express (backend/server.js)
// Keduanya meneruskan ke https://eofficev2.bekasikota.go.id → browser tidak
// kena CORS di semua environment. Tidak ada lagi logika DEV-vs-PROD di sini
// (bug CORS #58 → perintah fullstack Rama #59).

export interface CameraConfig {
  /** Slug stabil, dipakai sebagai camera_id. */
  id: string;
  /** Nama tampil di UI. */
  name: string;
  /**
   * URL HLS .m3u8 (upstream asli). Ini URL KANONIK — komponen TIDAK BOLEH
   * memakai field ini langsung; pakai getStreamUrl() agar path proksi
   * konsisten di satu tempat.
   */
  streamUrl: string;
  location?: string;
}

/** Prefix proksi stream (harus cocok dengan backend/server.js DAN vite.config.ts). */
export const STREAM_PROXY_PREFIX = "/cctv";

/**
 * URL stream EFEKTIF yang dipakai komponen/player.
 * Selalu path relatif same-origin, mis:
 *   "/cctv/backupcctv/m3/Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi.m3u8"
 * Proksi (Vite saat dev, Express saat production) meneruskannya ke upstream.
 */
export function getStreamUrl(camera: CameraConfig): string {
  const upstream = new URL(camera.streamUrl);
  return `${STREAM_PROXY_PREFIX}${upstream.pathname}${upstream.search}`;
}

export const CAMERAS: CameraConfig[] = [
  {
    id: "Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi",
    name: "Jl. Jend. A. Yani — RS Mitra Keluarga, Kota Bekasi",
    streamUrl:
      "https://eofficev2.bekasikota.go.id/backupcctv/m3/Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi.m3u8",
    location: "Kota Bekasi",
  },
];

// v0.1 dikunci 1 kamera (keputusan Meeting #4 D1–D6). Struktur data sudah
// list agar multi-kamera tinggal tambah entri di CAMERAS.
export const DEFAULT_CAMERA_ID = CAMERAS[0].id;
