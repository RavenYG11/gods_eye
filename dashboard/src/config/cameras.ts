// Rujukan: docs/arsitektur.md §3
// ATURAN KERAS: URL stream JANGAN hardcode di komponen. Semua URL hidup di
// file ini. Ganti/tambah kamera = edit file ini saja, tanpa sentuh komponen.

export interface CameraConfig {
  /** Slug stabil, dipakai sebagai camera_id. */
  id: string;
  /** Nama tampil di UI. */
  name: string;
  /** URL HLS .m3u8. */
  streamUrl: string;
  location?: string;
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
