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
| `tracker.ts` | `CentroidTracker`: trackId + arah dari delta y centroid + **velocity (vx, vy) + `predictBbox()` ekstrapolasi (#68)** |
| `onnxDetector.ts` | `Detector` via ONNX Runtime (rantai provider **`webgl → wasm`** #68; jalan di worker) |
| `detection.worker.ts` | Worker: inferensi + tracking, non-blocking; ukur `inferMs`/putaran; balas `"dropped"` eksplisit saat sibuk (#68) |
| `workerDetector.ts` | Pembungkus worker → `Detector` untuk main thread; capture 960×540; `lastInferMs`/`lastProvider`/`lastTimedOut` (#68) |
| `workerProtocol.ts` | Bentuk pesan main ⇄ worker (+ `"dropped"`, `provider` di `"ready"` — #68) |

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

**#68 — optimasi fps deteksi (15 Okt 2026, perintah Rama ~20:40):**
observasi Rama: box tertinggal jauh dari kendaraan; deteksi hanya 0,1–4,3 fps
sementara video 25–30 fps → box basi 1–10 dtk. Diagnosis & perbaikan:
1. **Akar 0,1 fps DITEMUKAN:** worker membuang frame DIAM-DIAM saat sibuk
   (`frame.close()` tanpa respons, MAX_INFLIGHT=1) → promise main thread
   menggantung sampai timeout 8 dtk → tiap timeout dihitung "hasil" → fps
   palsu 0,1 + overlay dibersihkan. Perbaikan: worker membalas `"dropped"`
   eksplisit (`workerProtocol.ts`); `lastSkipped`/`lastTimedOut` diabaikan
   hook (fps jujur); timeout 8 dtk → 30 dtk (kini hanya jaring pengaman).
2. **Rantai execution provider `webgl → wasm`** (`ORT_EXECUTION_PROVIDERS`,
   `vehicleConfig.ts`): dicoba berurutan di `initWithWasm`; WebGL (termasuk
   iGPU Intel) umumnya 2–5× lebih cepat dari WASM untuk YOLO 640×640;
   gagal → jatuh ke wasm. Provider terpilih tampil di chip UI (pengukuran).
3. **Capture 960×540** (`CAPTURE_RESIZE_*`): `createImageBitmap` dengan
   resize (fallback: capture penuh) — transfer antar-thread 8MB → ±2MB/frame;
   tidak mengurangi detail input model (letterbox tetap ke 640×640).
4. **`inferMs`/putaran** diukur di worker (`DetectionFrame.inferMs`) → chip
   UI `Deteksi: N fps · Mms · webgl|wasm` — bottleneck terbaca dari screenshot.
5. **Prediksi gerakan (#68b):** tiap track menyimpan velocity (vx, vy;
   piksel/detik-waktu-video, EMA `velocityAlpha: 0,4`, dijepit
   `maxSpeedPxS: 800`) + `framePts` terakhir terlihat. Overlay berjalan di
   **frame-rate video (rAF)**, bukan frame-rate deteksi: posisi box =
   `predictBbox(bbox, vx, vy, dt)` tiap frame — box meluncur mulus 60fps
   mengikuti kendaraan walau deteksi jarang. Basis waktu =
   `video.currentTime` (box ikut freeze saat buffering — benar). dt dijepit
   `PREDICT_CAP_S = 3 dtk`; track stale digambar redup (jujur: prediksi).
   Matching tracker pun memakai POSISI PREDIKSI (ala langkah predict
   ByteTrack/Kalman yang disederhanakan).
6. **Keputusan: TANPA library tracker eksternal.** Izin Rama ada (ByteTrack/
   DeepSORT JS), tapi diagnosis menunjukkan asosiasi centroid sudah bekerja —
   masalahnya fps rendah + tanpa ekstrapolasi. Library eksternal tidak
   menaikkan fps inferensi; ±30 baris di `tracker.ts` menyasar akar masalah
   langsung, tanpa dependensi baru, tetap offline.
7. Evaluasi akurasi jujur (demo YOLO siang vs CCTV malam): `docs/akurasi-realistis.md`.
   Larangan tegas: TIDAK ada fine-tuning 1 gambar (overfit).

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

   **#60 — Anti-buffering via intentional delay** (temuan Rama 15 Okt 2026: web resmi Bekasi tidak kelihatan buffering karena stream DI-DELAY beberapa detik di belakang live edge). Player SENGAJA dijaga ±5 dtk di belakang live edge. UI JUJUR: strip bawah "Anti-buffering aktif — tertinggal ±5 dtk (sengaja, agar gambar tidak tersendat)".
   **#66 (koreksi implementasi, 15 Okt 2026):** pola #60 (seek manual `video.currentTime = liveEdge − 5` tiap detik) TERBUKTI menjadi akar buffering 80% — tiap seek menginvalidasi buffer internal hls.js → siklus rebuffer tanpa henti. Mulai #66 offset dijaga NATIF oleh hls.js: `liveSyncDuration: 5` (target tepat 5 dtk di belakang edge), `liveMaxLatencyDuration: 30` (hls.js hanya menarik maju bila tertinggal > 30 dtk — default 3× segmen terlalu agresif dan mengalahkan trik delay), `maxLiveSyncPlaybackRate: 1` (tetap: jangan kejar edge dengan mempercepat playback). TIDAK ADA seek manual per detik; `tickDelay()` murni mengukur untuk strip/badge. Satu-satunya seek tersisa: darurat `emergencyResync()` bila tertinggal > 60 dtk. Akar kedua: proksi `/cctv/*` tanpa `agent` → http-proxy memaksa `Connection: close` + agent:false → tiap segmen .ts membayar handshake TLS + slow-start baru; diperbaiki dengan `https.Agent({ keepAlive: true })` eksplisit di `backend/server.js`.
   **#68 (koreksi kedua, 15 Okt 2026 — observasi langsung Rama di situs Bekasi):** player situs Bekasi mulai beberapa detik DI BELAKANG ujung buffer dan TIDAK PERNAH mengejar live edge — selisih buffer-vs-play DIBIARKAN MEMBESAR (1 menit+), tetap lancar. `liveMaxLatencyDuration: 30` (#66) TERNYATA masih "mengejar edge": bila `currentTime < end − maxLatency`, hls.js MELAKUKAN SEEK KE liveSyncPosition (diverifikasi dari source hls.js 1.7.3) — tiap drift > 30 dtk (mis. setelah stall) player "ditarik" ke tepi = buffer tipis = SIKLUS REBUFFER yang dikeluhkan Rama. Perbaikan: `liveMaxLatencyDuration: Infinity` (catch-up natif MATI TOTAL); `emergencyResync()` DIHAPUS → diganti PENJAGA JENDELA DVR (`dvrWindowGuard()`): seek HANYA bila posisi play hampir kedaluwarsa dari playlist — data NYATA dari `level.details.fragments` (bukan timer), target tetap edge − 25 dtk (jauh dari tepi, cushion tebal). Telemetri playback: ring buffer 2000 sampel @2 dtk (`pos`, `bufEnd`, `edge`, `delay`, `gap = bufEnd − pos`, `stalls`) + tombol "Unduh log playback (JSON)" di popover metrik — bukti uji 10+ menit: `gap` harus tumbuh/stabil, bukan menyusut ke nol.
   **#69 (fitur kontrol playback, 15 Okt 2026 — permintaan Rama):** tombol stop/play + tampilan durasi/waktu. (a) Snapshot bertambah `paused: boolean` (dari event play/pause NYATA di `<video>`, emit langsung — ikon tombol sinkron instan, bukan tebakan UI) + `playback: PlaybackInfo` {pos, bufStart, bufEnd, edge, windowStart} yang di-refresh tiap 1 dtk oleh `tickDelay()` — UI tidak membaca `<video>` langsung (konsisten: logika stream hanya di engine). (b) Tombol `#playBtn` (▶/❚❚) di barisan tombol kanan-bawah + klik video = toggle; SEBELUM `play()` saat resume, UI memanggil `guardDvrWindow()` (publik, logika inti tetap `dvrWindowGuard()` #68) — pause lama tidak pernah resume ke posisi kedaluwarsa. (c) Chip waktu kiri-bawah: LIVE HLS ber-duration Infinity → yang ditampilkan = offset dari live edge (`LIVE` bila ≤3 dtk, `−N dtk dari live`, `DIJEDA` saat pause). (d) Bar jendela DVR display-only (TANPA scrub — kebijakan #68: seek manual user = rebuffer). (e) Saat pause: overlay #68 freeze otomatis (basis `video.currentTime`); loop inferensi worker dilewati saat pause (hemat CPU).
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
