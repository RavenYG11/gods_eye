// Rujukan: docs/arsitektur.md §3
// ATURAN KERAS: URL stream JANGAN hardcode di komponen. Semua URL hidup di
// file ini. Ganti/tambah kamera = edit file ini saja, tanpa sentuh komponen.
//
// BUG CORS (verifikasi Rama 2026-10-15 13:56 WIB — fix #58 Gunet):
// request .m3u8 via hls.js dari origin http://localhost:5173 GAGAL
// (Network tab: red X, 0 byte, tanpa status code) padahal URL yang sama
// dibuka langsung di tab baru → video LIVE. Pola klasik CORS-block:
// navigasi langsung tidak kena CORS, tapi XHR browser diblokir karena
// server tidak mengirim Access-Control-Allow-Origin.
// Fix: saat DEV, app memakai URL proksi same-origin /cctv/*
// (lihat "server.proxy" di vite.config.ts). Saat PROD, tetap URL absolut.

export interface CameraConfig {
  /** Slug stabil, dipakai sebagai camera_id. */
  id: string;
  /** Nama tampil di UI. */
  name: string;
  /**
   * URL HLS .m3u8 (upstream asli). Ini URL KANONIK — komponen TIDAK BOLEH
   * memakai field ini langsung; pakai getStreamUrl() agar logika
   * DEV-vs-PROD konsisten di satu tempat.
   */
  streamUrl: string;
  location?: string;
}

/** Prefix proksi dev (harus cocok dengan "server.proxy" di vite.config.ts). */
export const DEV_STREAM_PROXY_PREFIX = "/cctv";

/**
 * URL stream EFEKTIF yang dipakai komponen/player.
 * - DEV (`npm run dev`): "/cctv/backupcctv/m3/….m3u8" → request same-origin
 *   ke dev-server Vite, diteruskan ke server CCTV → bebas CORS (bug #58).
 * - PROD (`npm run build` + XAMPP): URL absolut langsung — lihat batasan
 *   CORS produksi di docs/runbook.md §6.
 */
export function getStreamUrl(camera: CameraConfig): string {
  if (import.meta.env.DEV) {
    const upstream = new URL(camera.streamUrl);
    return `${DEV_STREAM_PROXY_PREFIX}${upstream.pathname}${upstream.search}`;
  }
  return camera.streamUrl;
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
