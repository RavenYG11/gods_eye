# Arsitektur Gods Eye v0.1 — Dashboard CCTV Bekasi

> **Status:** Acuan desain (Meeting #4 D2, 15 Okt 2026)
> **Pembaca utama:** Gunet (implementasi) & Prapto (mockup)
> **Repo GitHub:** belum ada — dokumen dikumpulkan di workspace, push menyusul (Epthal, setelah Rama buat repo `gods_eye` manual)

Keputusan Meeting #4 yang mengunci dokumen ini: **Opsi C Hybrid** — MVP 100% frontend, tanpa backend, tanpa object detection. Modul `detection/` berisi **kontrak saja** (detection-ready, agnostik-model) supaya saat Rama mencabut larangan + hasil benchmark i5 keluar, modul deteksi tinggal dipasang tanpa mengubah dashboard.

> **Update 15 Okt 2026:** perintah fullstack Rama #59 menambah backend Node.js (proksi `/cctv/*` + serve `dist/`) — "tanpa backend" di atas DIBATALKAN. Perintah #60 mencabut larangan deteksi — modul `detection/` kini berisi implementasi YOLO26n (§2).

---

## 1. Stack & struktur monorepo

**Stack v0.1 (dikunci):**

| Lapisan | Pilihan | Alasan singkat |
|---|---|---|
| UI framework | React 18 + TypeScript | Sama dengan Ventra — Rama & Gunet sudah familiar, tooling sama |
| Build | Vite | Dev cepat, output statis, `base: './'` |
| Stream | hls.js | Stream CCTV Bekasi adalah HLS murni (`.m3u8`, 1920×1080, CORS `*`) — hls.js memainkannya di browser tanpa backend |
| Styling | Tailwind CSS (sesuai mockup Prapto) | — |
| State stream | React hooks + hls.js events | Tanpa state manager eksternal — scope v0.1 tidak butuh |
| Backend | **TIDAK ADA** | Keputusan D2: frontend-only. Tidak ada server, tidak ada database, tidak ada API |

**Struktur monorepo:**

```
gods-eye/
├── dashboard/                  # App utama (React + Vite + TS + hls.js)
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── StreamPlayer.tsx      # Video + overlay status
│   │   │   ├── StreamHealthBadge.tsx # Indikator LIVE/BUFFERING/dll
│   │   │   └── CameraSelector.tsx    # Siap multi-kamera (v0.1: 1 item, disabled)
│   │   ├── detection/              # ★ Implementasi YOLO26n (#60) — lihat §2
│   │   │   ├── types.ts            # Kontrak data (Detection, Detector, DetectionPort)
│   │   │   ├── vehicleConfig.ts    # Semua angka ajaib + URL model
│   │   │   ├── yolo26n.ts          # Parse output [1,300,6], letterbox, preprocess
│   │   │   ├── tracker.ts          # CentroidTracker: trackId + arah
│   │   │   ├── onnxDetector.ts     # Detector via ONNX Runtime (di worker)
│   │   │   ├── detection.worker.ts # Worker inferensi ~10fps (non-blocking)
│   │   │   ├── workerDetector.ts   # Pembungkus worker → Detector
│   │   │   └── index.ts            # Satu-satunya pintu masuk dashboard
│   │   ├── config/
│   │   │   └── cameras.ts          # Daftar kamera — URL HLS di sini (§3)
│   │   ├── lib/
│   │   │   └── streamHealth.ts     # Mesin status + auto-reconnect (§4)
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── vite.config.ts
│   └── package.json
├── experiments/                # Paket benchmark i5 (Magna, .bat + .py) — bukan bagian build
│   └── paket-eksperimen-i5/      # Dipindah dari workspace/riset-object-detection/
├── docs/
│   ├── arsitektur.md             # ← dokumen ini
│   └── dod-v01.md                # DoD v0.1 (ditulis dulu sebelum build)
└── README.md                     # Cara jalanin di localhost (Epthal)
```

**Konsekuensi pilihan (dibanding alternatif yang ditolak):**

- *Frontend-only vs tambah backend tipis (proxy HLS):* stream Bekasi CORS `*`, jadi browser bisa pull langsung — backend tidak menambah nilai di v0.1, hanya menambah biaya deploy & maintenance. Kalau suatu saat kamera butuh auth/proxy, tambah `server/` terpisah — kontrak `DetectionPort` tidak berubah.
- *Monorepo vs repo terpisah:* satu repo = satu clone, satu push; `experiments/` jelas terpisah dari `dashboard/` sehingga file benchmark tidak mengotori build.

---

## 2. Modul `detection/` — implementasi YOLO26n (#60)

**Status 15 Okt 2026 (#60):** Rama MENCABUT larangan deteksi ("langsung bikin
object detectionnya"). Modul ini sekarang berisi implementasi nyata —
bukan lagi kontrak saja. Benchmark i5 BELUM dijalankan (tetap catatan).

**Aturan keras yang TETAP berlaku:** dashboard tidak pernah import model
langsung — selalu lewat `DetectionPort` (factory + interface di
`detection/index.ts`). Bobot `.onnx` tidak di-commit (diunduh via
`dashboard/scripts/unduh-model.*`).

**Peta modul:**

| File | Peran |
|---|---|
| `types.ts` | Kontrak data: `Detection`, `DetectionFrame`, `Detector`, `DetectionPort` (+ ekstensi UI `direction`) |
| `vehicleConfig.ts` | SEMUA angka ajaib: URL model, threshold, warna box, thread WASM |
| `yolo26n.ts` | Helper murni: letterbox, parse output `[1,300,6]` NMS-free, preprocess NCHW |
| `tracker.ts` | `CentroidTracker`: trackId + arah dari delta y centroid |
| `onnxDetector.ts` | `Detector` via ONNX Runtime WASM (jalan di worker) |
| `detection.worker.ts` | Worker: inferensi + tracking ~10fps, non-blocking |
| `workerDetector.ts` | Pembungkus worker → `Detector` untuk main thread |
| `workerProtocol.ts` | Bentuk pesan main ⇄ worker |

**Fakta model (riset #48, diverifikasi dari file asli 15 Okt 2026):**
YOLO26n resmi Ultralytics — input 640×640, output `[1,300,6]` =
`[x1,y1,x2,y2,skor,kelas]` final NMS-free; kelas COCO: 2=mobil, 3=motor,
7=truk (DIABAIKAN — koreksi Rama #62, 15 Okt 2026: hanya motor & mobil).
URL: `https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx`
(9.941.957 byte). Lisensi model: AGPL-3.0 (Ultralytics) — bobot tidak
di-commit; ONNX Runtime: MIT.

**Keputusan WASM:** onnxruntime-web ≥1.30 hanya menyediakan build *threaded*
→ butuh SharedArrayBuffer → butuh header COOP/COEP (dipasang di
`backend/server.js` + `vite.config.ts`, pola Ventra 2026-10-14). Tanpa
cross-origin isolation, ORT otomatis turun ke 1 thread (deteksi tetap jalan,
lebih lambat).

**Fallback PP-PicoDet-S (#60):** slot `modelFallbackUrl` sudah dikabel di
worker, TAPI string kosong — format output ONNX PicoDet BELUM terverifikasi,
jadi parser fallback tidak dibuat (dilarang mengarang). Diisi setelah export
ONNX PicoDet terverifikasi.

**Skema JSON Broto (beku, acuan serialisasi):**

```json
{
  "camera_id": "Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi",
  "frame_pts": 123456.78,
  "wall_time": 1728950400000,
  "detections": [
    { "class_id": 2, "label": "mobil", "conf": 0.91, "bbox_xywh": [120, 300, 220, 140] }
  ]
}
```

Pemetaan: `camera_id→cameraId`, `frame_pts→framePts`, `wall_time→wallTime/timestamp`, `conf→confidence`, `bbox_xywh→bbox`. Field `direction` & `trackId` adalah ekstensi UI — TIDAK diserialisasi ke JSON Broto.

---

## 3. Konfigurasi kamera

**URL stream JANGAN hardcode di komponen.** Semua URL hidup di satu file config:

```ts
// dashboard/src/config/cameras.ts
export interface CameraConfig {
  id: string;          // slug stabil, dipakai sebagai camera_id
  name: string;        // nama tampil di UI
  streamUrl: string;   // URL HLS .m3u8
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

export const DEFAULT_CAMERA_ID = CAMERAS[0].id;
```

Aturan:
- v0.1 = **1 kamera** (scope dikunci). `CameraSelector` dirender disabled dengan 1 item — struktur datanya sudah list agar multi-kamera tinggal tambah entri.
- Ganti/tambah kamera = edit file ini saja, tanpa sentuh komponen.
- Deploy default: **localhost** dulu (keputusan berjalan). `base: './'` di Vite agar bisa disajikan dari subfolder (`http://localhost/gods-eye/`).

---

## 4. Stream health & penanganan buffering

Fakta lapangan (temuan Rama, terverifikasi): stream Bekasi 60fps @1080p, tetapi **jaringan sering buffering → stream delay**. Dashboard harus jujur menampilkan kondisi, bukan pura-pura live.

**Indikator status (satu badge, satu sumber kebenaran):**

| Status | Arti | Pemicu (hls.js events) |
|---|---|---|
| `LIVE` | Frame ≤ 3 dtk dari ujung playlist | `FRAG_CHANGED` reguler, `liveSyncPosition` wajar |
| `DELAY` | Tertinggal > 3 dtk dari live edge | Selisih `liveSyncPosition − currentTime` > 3 dtk |
| `BUFFERING` | Player nunggu data | `BUFFER_STALLED` / `BUFFER_APPENDING` macet |
| `RECONNECTING` | Mencoba sambung ulang (backoff) | `ERROR` fatal → `hls.recoverMediaError()` / `hls.startLoad()` |
| `OFFLINE` | Menyerah sementara / stream mati | Backoff habis atau `ERROR` network fatal berulang |

**Mesin di `lib/streamHealth.ts`:**

1. **Hitung delay tiap detik:** `delay = hls.liveSyncPosition - video.currentTime`. Ambang: ≤3 dtk = LIVE, >3 dtk = DELAY (tampilkan "terlambat ±N dtk").

   **#60 — Anti-buffering via intentional delay** (temuan Rama 15 Okt 2026: web resmi Bekasi tidak kelihatan buffering karena stream DI-DELAY beberapa detik di belakang live edge). Player SENGAJA dijaga ~5 dtk di belakang live edge: saat start/reconnect, posisi diset ke `liveSyncPosition − 5`; tiap detik offset diperiksa, bila hanyut < 2 dtk dari edge → dorong balik (cooldown 10 dtk). `maxLiveSyncPlaybackRate: 1` mencegah hls.js mempercepat playback mengejar edge. Reconnect logic existing tidak berubah. UI JUJUR: strip bawah "Anti-buffering aktif — tertinggal ±5 dtk (sengaja, agar gambar tidak tersendat)".
2. **Auto-reconnect dengan backoff:** 1 dtk → 2 → 5 → 15 → 30 (maks), reset saat `MANIFEST_PARSED` sukses. Selama backoff tampilkan `RECONNECTING (percobaan ke-N)`.
3. **Jangan spam reload:** satu siklus reconnect hanya satu `hls.destroy()` + instance baru; guard boolean cegah tumpuk.
4. **Fallback kualitas:** bila `BUFFER_STALLED` > 10 dtk dan playlist punya multi-bitrate, turunkan level manual (`hls.nextLevel`) sebelum reconnect penuh.
5. **Metrik yang dicatat (console + badge tooltip):** bitrate aktif, resolusi, fps estimasi, jumlah stall, jumlah reconnect, uptime sesi. Tanpa backend = metrik hanya sesi-berjalan, tidak disimpan.

**Catatan untuk Prapto:** badge status harus selalu terlihat di atas video (pojok), dengan warna berbeda per status + teks delay saat `DELAY`. Buffering adalah kondisi *normal* di stream ini — desainnya menenangkan, bukan alarm merah panik.

---

## 5. Batasan & pagar (tidak bisa dinego di v0.1)

1. **Face recognition = OUT OF SCOPE PERMANEN** (UU PDP). Label kelas deteksi tidak boleh berisi identitas orang. Kontrak `Detection.label` hanya untuk kelas objek (kendaraan, orang sebagai kategori umum).
2. **Tanpa rekaman default.** Tidak ada tombol record, tidak ada penyimpanan frame di v0.1. (Snapshot/rekaman = pertanyaan keputusan Rama untuk fase berikut — bukan v0.1.)
3. **Bobot model tidak di-commit.** Nanti saat fase deteksi: model diunduh terpisah (URL di config), `.gitignore` wajib mencakup `*.onnx`, `*.pt`, `*.bin`.
4. **Object detection DIBUKA 15 Okt 2026 (#60)** — Rama mencabut larangan eksplisit ("langsung bikin object detectionnya"). Implementasi: YOLO26n via kontrak `Detector` (§2). Benchmark i5 BELUM dijalankan — tetap catatan verifikasi.
5. **Model tidak diputuskan di v0.1** — arsitektur agnostik-model (§2) adalah caranya menunda keputusan tanpa rework.
6. **URL stream di config** (§3), bukan di kode komponen; kredensial (bila suatu saat perlu) via env, bukan commit.

---

## 6. Alur data v0.1 (ringkas)

```
[CCTV Bekasi .m3u8] ──HLS──▶ hls.js ──▶ <video> ──▶ StreamPlayer
                                         │
                              streamHealth.ts ──▶ StreamHealthBadge
                              (LIVE/DELAY/BUFFERING/RECONNECTING/OFFLINE)
                                         │
                              [FASE DEPAN] video ──▶ Detector (kontrak §2)
                                                   ──▶ DetectionFrame (skema Broto)
                                                   ──▶ overlay bbox
```

Tidak ada panah ke server — memang tidak ada server.

---

## 7. Handoff

- **Prapto (mockup):** 1 layar utama = video 16:9 + badge status (§4) + nama kamera + jam. CameraSelector tampil disabled (1 item). Tanpa panel deteksi, tanpa tombol record.
- **Gunet (build):** mulai dari `dashboard/`; `detection/` hanya types; `config/cameras.ts` satu-satunya tempat URL; `lib/streamHealth.ts` implementasi §4. Update README + docs tiap milestone, push per aturan repo.
- **Cipher (nanti):** audit saat fase deteksi dibuka — fokus: sumber model, integritas bobot, dan kepatuhan pagar §5 butir 1.
- **Testarossa (QA Fase 1):** skenario wajib = cabut jaringan 30 dtk → pastikan RECONNECTING → LIVE kembali; throttling bandwidth → pastikan DELAY tampil jujur.

*— Sentot, Software Architect · Assignment #49 · 15 Okt 2026*

---

## 8. Addendum — backend fullstack (#59, Gunet, 15 Okt 2026)

**Perintah langsung Rama (15 Okt 2026 14:07 WIB):** *"kenapa ga fullstack, suruh gunet
bikin backendnya."* Keputusan frontend-only Meeting #4 (D2) **dibatalkan** oleh perintah ini —
v0.1 kini fullstack. Pagar §5 (tanpa rekaman, tanpa detection, tanpa face recognition)
tetap berlaku penuh.

**Yang ditambahkan (scope minimal, tanpa over-engineering):**

| Lapisan | Pilihan | Alasan singkat |
|---|---|---|
| Backend | Node.js + Express + `http-proxy-middleware` | Paling simpel & stabil untuk kebutuhan ini: reverse proxy + static server |
| `GET /cctv/*` | Reverse proxy → `https://eofficev2.bekasikota.go.id/*` (prefix `/cctv` dibuang, `changeOrigin: true`) | Menyelesaikan bug CORS **permanen** di semua environment — browser hanya request same-origin |
| `GET /` | `express.static(../dashboard/dist)` + SPA fallback → `index.html` | Satu server melayani app + proksi = satu origin |
| `GET /api/health` | `{ ok, upstream, frontendBuilt }` | Health check untuk runbook/troubleshooting |
| `config/cameras.ts` | `getStreamUrl()` **selalu** path relatif `/cctv/…` — logika DEV-vs-PROD dihapus | Satu kode untuk semua mode: dev → proksi Vite, production → proksi Express |

**Struktur baru:** `backend/` (root repo) berisi `server.js` + `package.json` sendiri + `README.md`.
Env opsional: `PORT` (default 3000), `CCTV_UPSTREAM` (default server CCTV Bekasi).

**Batasan jujur:** stream tidak bisa dites dari VM (WAF blokir IP data center) — "video tampil"
wajib verifikasi Rama di laptop (runbook §7). Backend sengaja **tidak** me-rewrite isi playlist;
bila segmen `.m3u8` ternyata URL absolut (→ CORS lagi), solusinya rewrite playlist di proksi —
dilaporkan dulu ke manager bila terbukti.
