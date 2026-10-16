# GODS EYE v0.1 — Dashboard CCTV Kota Bekasi

Viewer web **1 kamera** CCTV Bekasi (HLS, 1080p) — **fullstack**: backend Node.js
(reverse proxy anti-CORS + static server) + frontend React **+ deteksi kendaraan (YOLO26n)**.
Dibangun oleh Gunet (Software Engineer), Assignment #52 (dashboard) + #59 (backend)
+ **#60 (anti-buffering delay + object detection)**, 15 Okt 2026.

> Scope v0.1 **DIKUNCI** (Meeting #4 D1–D6): stream viewer 1 kamera saja.
> **Perintah langsung Rama 15 Okt 2026 14:37 WIB** ("langsung bikin object
> detectionnya") **MENCABUT larangan deteksi** — #60 membangun deteksi
> kendaraan (YOLO26n, ONNX). Tanpa rekaman. Face recognition OUT OF SCOPE permanen.
> Perintah Rama 15 Okt 2026 14:07 WIB ("kenapa ga fullstack, suruh gunet bikin backendnya")
> membatalkan keputusan frontend-only — v0.1 kini fullstack (#59).

## Cara menjalankan di localhost (direkomendasikan)

```bash
cd dashboard
npm install
scripts\unduh-model.bat        # Windows SEKALI saja → public/models/yolo26n.onnx
                               # (Linux/Mac: bash scripts/unduh-model.sh)
npm run build        # sekali per ada perubahan frontend → dashboard/dist/
cd ../backend
npm install
npm start            # → http://localhost:3000
```

Buka **http://localhost:3000** — satu server melayani app + proksi stream
(satu origin → **CORS hilang permanen**, dev maupun production).
Detail: `backend/README.md`, `docs/runbook.md` §4.

Mode dev UI (hot reload): `cd dashboard && npm run dev` → http://localhost:5173
(proksi `/cctv` tetap tersedia via Vite).

## Struktur

```
gods-eye/
├── backend/                    # ★ BACKEND (#59) — Node.js + Express
│   ├── server.js               # Reverse proxy /cctv/* → server CCTV + serve dashboard/dist
│   ├── package.json            # express + http-proxy-middleware
│   └── README.md               # Cara jalan backend + env var + batasan
├── dashboard/                  # App utama (React 18 + Vite + TS + hls.js)
│   ├── src/
│   │   ├── components/
│   │   │   ├── StreamPlayer.tsx      # <video> + overlay status + OSD + fullscreen
│   │   │   ├── StreamHealthBadge.tsx # Badge LIVE/DELAY/BUFFERING/… + popover metrik
│   │   │   ├── CameraSelector.tsx    # Disabled, 1 item (siap multi-kamera)
│   │   │   └── ConnectionLog.tsx     # ★ Panel "Log koneksi" (instruksi Rama)
│   │   ├── detection/              # ★ IMPLEMENTASI YOLO26n (#60, via kontrak DetectionPort)
│   │   │   ├── types.ts            # Kontrak data (Detection, Detector, + direction)
│   │   │   ├── vehicleConfig.ts    # Semua angka ajaib + URL model
│   │   │   ├── yolo26n.ts          # Parse output [1,300,6] NMS-free, letterbox
│   │   │   ├── tracker.ts          # CentroidTracker: trackId + arah dari delta y
│   │   │   ├── onnxDetector.ts     # Detector via ONNX Runtime WASM (di worker)
│   │   │   ├── detection.worker.ts # Worker inferensi ~10fps, video 60fps tak block
│   │   │   └── workerDetector.ts   # Pembungkus worker → Detector (main thread)
│   │   ├── components/DetectionOverlay.tsx # Canvas box: BIRU=ke atas, HIJAU=ke bawah
│   │   ├── lib/useDetection.ts     # Hook: worker lifecycle + loop tangkap frame
│   │   ├── scripts/unduh-model.bat # ★ Unduh yolo26n.onnx (sekali, tidak di-commit)
│   │   ├── scripts/copy-ort-wasm.mjs# Salin .wasm ORT → public/ort (prebuild)
│   │   ├── config/cameras.ts       # SATU-SATUNYA tempat URL stream (selalu /cctv/… sejak #59)
│   │   ├── lib/streamHealth.ts     # Mesin status + auto-reconnect + pencatat log
│   │   ├── lib/useStreamSession.ts # Jembatan engine → React
│   │   ├── lib/log.ts              # Tipe entri log + format WIB
│   │   ├── App.tsx                 # Header + player + log + bar kamera
│   │   └── styles.css              # Token visual 1:1 dari mockup
│   ├── vite.config.ts              # base './' + server.proxy /cctv (mode dev)
│   └── package.json
├── experiments/                # Paket benchmark i5 (Magna) — bukan bagian build
├── docs/                       # arsitektur.md (Sentot #49, + Addendum #59) + mockup (Prapto #50/#51)
│                              # + akurasi-realistis.md (evaluasi jujur demo YOLO vs CCTV malam, #68)
└── README.md                   # ← file ini
```

## Jejak keputusan (tiap pilihan bisa dirunut)

| Keputusan | Rujukan |
|---|---|
| React 18 + Vite + TS + hls.js | arsitektur.md §1 |
| **Backend Node.js + Express (#59): reverse proxy `/cctv/*` → server CCTV + serve `dashboard/dist` + `GET /api/health`** — satu origin, CORS hilang permanen di semua environment | Perintah langsung Rama 15 Okt 2026 14:07 WIB; backend/README.md; runbook.md §1 |
| `detection/` = implementasi YOLO26n via kontrak `Detector`/`DetectionPort`; dashboard tak pernah import model langsung | arsitektur.md §2; perintah Rama 15 Okt 2026 14:37 WIB |
| **Anti-buffering: player sengaja dijaga ±45 dtk di belakang live edge** (trik web resmi Bekasi — #71 naikkan dari ±5 dtk karena cushion 5 dtk < ekor fetch 1 segmen lambat); info delay JUJUR tampil di panel Log koneksi + badge "● DELAY · ±N dtk" (strip kuning bawah video DIHAPUS #71) | temuan Rama 15 Okt 2026; arsitektur.md §4 |
| Box deteksi: **BIRU = kendaraan ke atas, HIJAU = ke bawah** (arah dari delta y centroid); kelas: **motor, mobil** (#62: truk dihapus total per koreksi Rama 15 Okt 2026); box dirender dari tracker + persistensi ±0,7 dtk + smoothing EMA | assignment #60, #62 |
| **#65 (bugfix 15 Okt 2026 ~19:00 WIB):** `useDetection.ts` memanggil `detector.setThreshold()` tapi method tidak ada di `WorkerVehicleDetector` → `npm run build` gagal (TS2339 ×2). Perbaikan: `setThreshold(threshold)` diimplementasi penuh — `WorkerVehicleDetector` forward pesan `set-threshold` ke worker → `OnnxVehicleDetector` menyimpan ambang → `parseYolo26nOutput` memfilter dengan `confidenceThreshold` live. Slider UI 0,10–0,90 kini benar-benar mengubah hasil deteksi (terverifikasi: tsc + vite build bersih, uji logika parser lolos) | laporan Rama 18:57 WIB; assignment #65 |
| **#66 (bugfix 15 Okt 2026 ~19:22 WIB):** Rama lapor (1) buffering 80% padahal URL asli lancar, (2) player kurang lebar, (3) card menyusut saat DevTools dibuka. Diagnosis & perbaikan: (1) DUA akar — (a) seek manual `applyIntentionalDelay` (#60) tiap detik berkelahi dengan buffer internal hls.js → siklus seek/rebuffer (seek darurat `emergencyResync` hanya untuk drift > 60 dtk); offset ±5 dtk dialihkan ke NATIF hls.js (`liveSyncDuration: 5`, `liveMaxLatencyDuration: 30`, `maxLiveSyncPlaybackRate: 1` — diverifikasi di source hls.js 1.7.3); (b) proksi tanpa `agent` → http-proxy memaksa `Connection: close` + agent:false → TIAP .ts membayar handshake TLS + slow-start baru (akar ".ts 841KB makan 2–3 dtk"); diperbaiki via `https.Agent({keepAlive:true})` eksplisit. (2) Formula lebar `#62` (`min(100%,(100vh−200px)×16/9)`) diganti: `width:100%` (ikut kontainer) + `aspect-ratio:16/9` + `max-height:calc(100vh−120px)` (cadangan 200px terbukti over-konservatif; 120px = header ±58 + padding 20 + napas ±42) + `main` max-width 1120→1440px. (3) Lebar tidak lagi digantungkan ke tinggi viewport → DevTools tidak bisa menyusutkan card; `:fullscreen` dikecualikan dari max-height. Terverifikasi: tsc + vite build bersih, `node --check` backend | laporan Rama 19:22 WIB; assignment #66 |
| **#67 (bugfix 15 Okt 2026 ~20:10 WIB):** Rama lapor (1) card lebar tapi video pillarbox (bar hitam kiri-kanan), (2) box kedip-kedip + jarang muncul (deteksi ±4,3 fps). Diagnosis berbasis bukti: (1) `max-height` memaksa card LEBIH LEBAR dari 16:9 saat viewport pendek → video `contain` tidak mengisi. Perbaikan: `width:min(100%, calc((100lvh−140px)×16/9))` + `aspect-ratio:16/9` — card SELALU tepat 16:9 → video mengisi sempurna tanpa bar/crop, overlay tetap akurat; `100lvh` stabil thd DevTools. (2) DUA akar: (a) `maxDistPx:90` berasumsi 10fps, padahal inferensi aktual ±4,3fps → kendaraan bergerak ±2,3× lebih jauh antar-frame → track tidak pernah cocok → `seen` tak pernah capai 2 → box tidak dirender ("jarang muncul") — TERBUKTI via uji logika (track pecah dengan 90px, utuh dengan 200px); diperbaiki ke 200px. (b) `minSeenToRender:2` menunda box 2 frame — permintaan eksplisit Rama "box langsung muncul" → diturunkan ke 1. Terverifikasi: tsc + vite build bersih, uji logika tracker lolos (muncul frame-1, track utuh, grace stale) | laporan Rama 20:10 WIB; assignment #67 |
| **#68 (bugfix 15 Okt 2026 ~20:40 WIB):** Rama lapor (1) buffering jangka panjang (situs Bekasi lancar), (2) box tertinggal dari kecepatan mobil, (3) minta akurasi sedekat demo YOLO + izin pakai library tracker eksternal. Diagnosis & perbaikan: (1) OBSERVASI RAMA di situs Bekasi: player mulai beberapa detik DI BELAKANG ujung buffer dan TIDAK PERNAH mengejar live edge — selisih dibiarkan membesar (1 mnt+), tetap lancar. Pola #66 (`liveMaxLatencyDuration: 30` + `emergencyResync` drift >60 dtk) TERNYATA masih "mengejar edge": tiap drift >30 dtk hls.js MELOMPAT ke liveSyncPosition = seek = invalidasi buffer = SIKLUS REBUFFER. Perbaikan: `liveMaxLatencyDuration: Infinity` (catch-up natif MATI TOTAL), `emergencyResync` DIHAPUS → diganti PENJAGA JENDELA DVR (seek HANYA bila posisi play hampir kedaluwarsa dari playlist, data-driven dari `level.details.fragments`, target tetap edge−25 dtk, bukan ke tepi). Telemetri playback: ring buffer 2000 sampel @2 dtk (pos/bufEnd/edge/delay/gap/stalls) + tombol "Unduh log playback (JSON)" — bukti uji 10+ menit: kolom `gap` harus tumbuh/stabil. (2) DUA akar box tertinggal: (a) BUG TIMEOUT — worker membuang frame diam-diam saat sibuk → promise main thread menggantung sampai timeout 8 dtk → tiap timeout DIHITUNG sebagai "hasil" → fps palsu 0,1 + overlay dibersihkan tiap 8 dtk (persis screenshot Rama!). Perbaikan: worker membalas `dropped` eksplisit; timeout 8→30 dtk + flag `lastTimedOut` (tidak dihitung fps, tidak membersihkan overlay); inferensi dipercepat via rantai provider `webgl→wasm` (fallback otomatis) + capture 960×540 (transfer 8MB→2MB); `inferMs` + provider tampil live di chip UI (pengukuran, bukan tebakan). (b) PREDIKSI VELOCITY — tiap track menyimpan vx/vy (px/detik-waktu-video, EMA α=0,4, dijepit 800px/s); pencocokan ke POSISI PREDIKSI (ala langkah predict ByteTrack, tanpa library); overlay jalan di rAF 60fps mengekstrapolasi `bbox + v·(video.currentTime − framePts)` — box meluncur mulus walau deteksi 1 fps; dt dijepit 3 dtk; basis waktu-video (freeze saat buffering = benar). ByteTrack/DeepSORT TIDAK dipakai: diagnosis menunjukkan asosiasi bukan masalahnya; predict-step 30 baris cukup, tanpa dependensi, tetap offline. (3) AKURASI JUJUR: demo YOLO = siang, dekat, jernih; CCTV = malam, jauh, motion blur — tidak apple-to-apple. Yang diperbaiki: box basi (prediksi), threshold 0,5→0,4 (kendaraan jelas malam skor 51–54%, nyaris gugur di 0,5), slider tetap ada. Yang TIDAK: fine-tuning 1 gambar (overfit, dilarang tegas). Terverifikasi: tsc + vite build bersih, uji logika tracker lolos | laporan Rama 20:40 WIB; assignment #68 |
| **#68 (bugfix 15 Okt 2026 ~20:40 WIB):** Rama lapor (1) buffering berulang, (2) box tertinggal jauh dari kendaraan, (3) akurasi di bawah ekspektasi demo YOLO. Diagnosis & perbaikan: (1) `liveMaxLatencyDuration: 30` (#66) TERBUKTI masih "mengejar edge" — diverifikasi dari source hls.js 1.7.3: bila `currentTime < end − maxLatency`, hls.js SEEK KE liveSyncPosition (tepi!) → tiap drift > 30 dtk player "ditarik" ke tepi = buffer tipis = siklus rebuffer. Perbaikan: `liveMaxLatencyDuration: Infinity` (catch-up natif MATI TOTAL — player tidak pernah mengejar live edge, gap dibiarkan membesar ala situs Bekasi); `emergencyResync()` DIHAPUS → diganti **penjaga jendela DVR** (`dvrWindowGuard()`): seek HANYA bila posisi hampir kedaluwarsa dari playlist (data `level.details.fragments`), target tetap edge − 25 dtk. **Telemetri playback** (ring buffer 2000 sampel @2 dtk: pos/bufEnd/edge/delay/gap/stalls) + tombol "Unduh log playback (JSON)" di popover metrik = bukti uji 10+ menit. (2a) **Akar 0,1 fps DITEMUKAN:** worker membuang frame DIAM-DIAM saat sibuk → promise menggantung sampai timeout 8 dtk → tiap timeout dihitung "hasil" → fps palsu 0,1. Perbaikan: pesan `"dropped"` eksplisit, timeout 8→30 dtk, rantai provider **`webgl → wasm`**, capture 960×540, `inferMs` tampil di chip UI. (2b) **Prediksi gerakan:** velocity (vx, vy) per track + overlay jalan di frame-rate video (rAF) via `predictBbox()` — box meluncur mulus mengikuti kendaraan; TANPA library eksternal (diagnosis: asosiasi bukan masalah). (3) Evaluasi jujur: `docs/akurasi-realistis.md` — batas realistis CCTV malam vs demo siang; LARANGAN TEGAS: tidak ada fine-tuning 1 gambar (overfit). Terverifikasi: `npm run build` bersih | laporan Rama 20:40 WIB; assignment #68; arsitektur.md §2, §4 |
| Bobot `.onnx` tidak di-commit (`.gitignore`); unduh via `scripts/unduh-model.*`; fallback PicoDet = slot kosong (format belum terverifikasi) | arsitektur.md §2, §5 |
| **#69 (fitur 15 Okt 2026 ~20:55 WIB):** Rama minta kontrol playback: tombol stop/play + tampilan durasi/waktu. Digabung di atas #68 (belum di-push), push sekali nanti. Implementasi: (1) tombol **#playBtn** (▶/❚❚) di kiri tombol deteksi — toggle `video.play()/pause()`, ikon mengikuti event video play/pause (langsung, bukan tebakan); klik video kini juga toggle (standar pemutar). (2) **Chip waktu** kiri bawah: LIVE HLS tidak punya durasi (Infinity) → yang ditampilkan = offset dari live edge (`−N dtk dari live`, atau `LIVE` bila ≤3 dtk) + indikator `DIJEDA` saat pause; data dari snapshot `playback` {pos, bufStart, bufEnd, edge, windowStart} (refresh tiap 1 dtk via tickDelay; delay = edge − pos dihitung di UI). (3) **Progress bar jendela DVR**: strip tipis 200px di atas chip waktu — bar = jendela DVR [windowStart..liveEdge], penanda putih = posisi play; indikator saja (live, bukan scrubber). (4) Saat pause: overlay & tracker ikut freeze OTOMATIS karena basis waktu-video `video.currentTime` (#68); worker dilewati saat `video.paused` (hemat CPU, box tetap beku konsisten). (5) Resume dari pause lama: `dvrWindowGuard()` #68 sudah menanganinya — posisi yang hampir kedaluwarsa dilompat ke edge−25 dtk TANPA seek brutal/rebuffer. Styling dark theme konsisten (mono, chip, blur). Terverifikasi: tsc + vite build bersih | permintaan Rama 20:55 WIB; assignment #69 |
| Header COOP/COEP di backend + Vite dev (syarat SharedArrayBuffer untuk ORT WASM multi-thread) | pola Ventra 2026-10-14 |
| **#70 (bugfix 15 Okt 2026 ~21:22 WIB):** Rama lapor 5 bug setelah tes #68+#69: (1) DVR bar tidak bisa di-scrub — kebijakan display-only #69 DIBATALKAN atas permintaan eksplisit; bar kini interaktif: klik/drag/arrow-keys/Home/End → `seekTo()` dijepit ke [windowStart+1 .. fragEnd−0,5], `hls.startLoad()` pasca-seek; masa tenggang 30 dtk agar guard DVR tidak langsung menarik maju posisi scrub. (2) Bar "mentok" tidak update — AKAR: `tickDelay()` hanya `emit()` saat status berubah; saat delay stabil (mis. "DELAY ±16 dtk" terus) UI tidak pernah dapat data playback baru → bar & chip beku. Perbaikan: `emit()` TIAP DETIK setelah `updatePlaybackInfo()`. (3) Resume RUSAK (kritis): jeda di ujung → play → stuck buffering. Perbaikan: `resumePlayback()` — guard DVR + `clampToDvrWindow()` (paksa ke edge−25 dtk bila posisi sudah DI LUAR jendela) + `hls.startLoad()` + watchdog 4 dtk (`recoverMediaError()` bila masih macet); guard DVR tidak lagi jalan saat paused (menarik frame yang dilihat = salah). (4) Tombol unduh log playback tidak ketemu — kini ada DUA tempat jelas: header panel Log koneksi (di samping "Bersihkan") + popover metrik; helper terpusat `lib/telemetry.ts`. (5) Slider confidence hilang — dikembalikan (0,10–0,90, step 0,05, live ke `setThreshold` #65); CSS `.det-threshold` sudah ada sejak #62. Tambahan Rama 21:24: angka durasi tepat di bawah bar (`dvr-time`, monospace 10px): "posisi / panjang jendela" (mm:ss). Terverifikasi: tsc + vite build bersih | laporan Rama 21:22 WIB; assignment #70 |
| **#71 (7 perbaikan 16 Okt 2026 ~09:33 WIB):** Rama kirim 8 screenshot + 7 permintaan setelah tes #70. (1) **Layout:** slider confidence + indikator deteksi PINDAH dari dalam video ke card BARU "Deteksi kendaraan" di kanan video (responsif: menumpuk di layar ≤1100px); card video bersih (hanya video + DVR bar + kontrol play); `useDetection` diangkat ke App. (2) **Tooltip delay di DVR bar DIHAPUS TOTAL** (`title` pada bar/chip/angka waktu). (3) **DVR bar DIPERPANJANG** — lebar penuh area video (dulu 280px). (4) **Dataset seed:** 2 crop kiriman Rama → `dashboard/public/dataset/` (`motor-1.png` 64×117, `mobil-1.png` 126×92) + `dataset.json` + `docs/dataset.md` (JUJUR: 1 sampel/kelas = seed referensi/QA, bukan training set; konvensi `motor-2.png`, `mobil-2.png` dst); folder dataset dikecualikan dari ignore (disetujui manajer). (5) **Strip kuning delay DIHAPUS** — info "tertinggal ±N dtk dari live" pindah ke panel Log koneksi sebagai baris ringkasan. (6) **Buffering — AKAR DITEMUKAN (berbasis bukti kode):** `liveSyncDuration: 5` → hls.js menargetkan posisi TEPAT 5 dtk di belakang live edge; cushion 5 dtk < ekor fetch satu segmen lambat (`fragLoadingMaxRetry: 4` × `fragLoadingRetryDelay: 2000` = 8 dtk+) → tiap jitter = event `waiting` = overlay "Buffering…" = "dashboard ngelag padahal situs Bekasi lancar" (situs Bekasi pakai cushion puluhan detik). Perbaikan: `liveSyncDuration: 45`, `maxBufferLength: 120`, `maxMaxBufferLength: 600`, `backBufferLength: 90`, `DVR_SAFE_BEHIND_SEC` 25→45 (selaras cushion); **penjaga prebuffer internal**: bila gap (bufEnd−pos) < 8 dtk → `video.pause()` agar hls.js mengisi buffer sampai ≥30 dtk lalu play — tanpa overlay spinner (flag `prebuffering` di snapshot agar chip tidak tampil "DIJEDA"); timeout 25 dtk → kembali ke jalur buffering normal. (7) **Angka durasi:** denominator = LIFETIME sejak tab dibuka (reset hanya saat tab di-close/restart) — "00:46 / 12:03"; posisi tetap posisi playback dalam jendela DVR. Terverifikasi: tsc 0 error + vite build sukses | laporan Rama 16 Okt 2026 09:33 WIB; assignment #71 |
| **#72 (fitur 16 Okt 2026 ~10:17 WIB; FINAL ~10:18 WIB — DATABASE):** Panel **"Kelola Dataset"** di kolom kanan (di bawah card "Deteksi kendaraan") — tambah sampel kendaraan sendiri: (1) **Upload file** (multiple, `accept="image/*"`), (2) **Paste gambar** (klik area paste → `Ctrl+V`, tangkap `clipboardData`; bonus: drag-and-drop). Setiap gambar wajib berlabel **mobil/motor** (segmented control, default mobil). Validasi: hanya png/jpg/webp, maks 5 MB/file, tolak duplikat (SHA-256). **Keputusan final Rama: gambar disimpan di SQLite** (`backend/data/dataset.db` via `node:sqlite` bawaan Node ≥22.5 — #73, di-gitignore) — BUKAN file; pendekatan file-based awal dibatalkan & dihapus. **Backend** (`backend/lib/dataset-db.js` + endpoint di `server.js`): `POST /api/dataset` `{label, source, dataUrl}` → `201 {id}`; `GET /api/dataset` (metadata, tanpa blob); `GET /api/dataset/:id/image` (biner); `DELETE /api/dataset/:id` (seed dilindungi → 403). Seed-on-first-run mengimpor `motor-1.png`/`mobil-1.png`. **Frontend** (`dashboard/src/lib/dataset.ts` — satu-satunya jalur akses): `listDataset()`, `getDatasetImageUrl(id)` (objectURL cache+revoke), `uploadDatasetImage()`, `deleteDatasetImage()`. UI: grid thumbnail (badge label, hapus per item, konfirmasi), ringkasan `mobil: N · motor: M`, seed tampil tapi tak bisa dihapus. PNG seed tetap file di `dashboard/public/dataset/` — commit manual dari laptop (pelajaran #71: konektor text-only). Terverifikasi #72: `npx tsc -b --force` 0 error + `npm run build` sukses + `node --check` + uji live curl 9 kasus (seed 2 → POST 201 → duplikat 409 → label salah 400 → GET image 200 byte-identik → DELETE seed 403 → DELETE 200 → GET hapus 404 → id non-angka 400 → dataUrl bukan gambar 400) | permintaan Rama 16 Okt 2026 10:17–10:18 WIB; assignment #72 |
| URL stream hanya di `config/cameras.ts`; `getStreamUrl()` selalu path relatif `/cctv/…` (logika DEV/PROD dihapus #59) | arsitektur.md §3 + Addendum #59 |
| Status LIVE/DELAY/BUFFERING/RECONNECTING/OFFLINE + backoff 1→2→5→15→30 | arsitektur.md §4 |
| Stall > 10 dtk + multi-bitrate → turunkan kualitas dulu | arsitektur.md §4 butir 4 |
| Metrik sesi: bitrate, resolusi, fps estimasi, stall, reconnect, uptime | arsitektur.md §4 butir 5 |
| Visual: token warna, badge, overlay, OSD (strip delay kuning DIHAPUS #71) | mockup-dashboard.html (varian 1, pilihan Rama) |
| Panel **"Log koneksi" di BAWAH video** (full-width, bukan samping), isi event nyata hls.js + timestamp WIB + ringkasan delay dari live edge (#71) | instruksi eksplisit Rama 15 Okt 2026 |
| Styling plain CSS (bukan utility framework) | mockup tidak memakai utility framework — visual 1:1 lebih terjaga |
| Sinyal buffering = event `waiting` milik `<video>` | hls.js v1.6 tidak mengekspos `BUFFER_STALLED`; perilaku §4 tetap terpenuhi |
| `base: './'` | arsitektur.md §3 |

## Status verifikasi (jujur, 15 Okt 2026; #71: 16 Okt 2026)

- `npm run build` (`tsc -b` + `vite build`): **BERSIH, tanpa error** (hanya warning
  chunk > 500 kB yang sudah dinyatakan harmless di QA #54). Berlaku juga
  setelah #68 (Gunet, 15 Okt 2026 ~21:00 WIB) dan **#71 (Gunet, 16 Okt 2026:
  `npx tsc -b --force` 0 error + `npm run build` sukses** — stream runtime
  TIDAK bisa diuji di VM: upstream CCTV memblokir IP data center; checklist
  uji laptop ada di bawah).
- **Backend teruji lokal di VM:** `npm start` jalan tanpa error; `GET /` → `200`,
  `GET /api/health` → `{"ok":true,…}`, path acak → `200` (SPA fallback),
  `GET /cctv/…` → diteruskan ke proksi (hasil `500` dari VM = upstream memblokir
  IP data center — **routing terbukti benar**, bukan 404).
- **Stream `.m3u8` TIDAK terjangkau dari VM ini** (pola sama dengan temuan riset
  CCTV Jakarta: server memblokir IP data center). **"Video tampil" WAJIB
  diverifikasi Rama di laptop (jaringan rumah)** — checklist `docs/runbook.md` §7.
- QA Testarossa #54: **LULUS DENGAN CATATAN** — laporan: `docs/qa-report-v0.1.md`.
  Audit keamanan Cipher #53: lulus tanpa temuan kritis.
- Runbook operasional (Epthal #55, direvisi Gunet #59): **`docs/runbook.md`**.

## Berikutnya (sesuai urutan Meeting #4 + perintah #60)

> **WORKFLOW BARU (perintah Rama 15 Okt 2026):** build → lapor ke Rama dulu →
> push → lapor lagi. **#60 BELUM di-push** — menunggu review Rama.

1. **Rama (laptop, jaringan rumah):** `scripts\unduh-model.bat` (sekali) →
   `git pull` → `npm install` (dashboard + backend) → `npm run build` →
   `npm start` di `backend/` → buka http://localhost:3000. Checklist:
   - badge DELAY ±45 dtk (BUKAN buffering) + ringkasan delay di panel
     "Log koneksi",
   - card "Deteksi kendaraan" di KANAN video berisi indikator
     `Deteksi: N fps · Mms · webgl|wasm` + slider confidence + tombol toggle
     (card video bersih: hanya video + DVR bar + kontrol play),
   - DVR bar hampir selebar video (bisa di-scrub); angka di bawah bar
     "posisi / lifetime tab" (mis. "00:46 / 12:03"),
   - box kendaraan muncul: BIRU = ke atas, HIJAU = ke bawah,
   - TIDAK ADA tooltip saat hover DVR bar; TIDAK ADA strip kuning di bawah
     video,
   - uji cabut WiFi → BUFFERING → RECONNECTING → kembali DELAY ±45 dtk.
2. **#68 — verifikasi 10+ menit (WAJIB sebelum push, di laptop Rama):**
   putar stream 10+ menit, lalu klik badge → "Unduh log playback (JSON)".
   Kriteria lolos: (a) TIDAK ADA siklus buffering berulang (stall sesekali
   karena jaringan = wajar; pola "buffer tiap X menit" = regresi, laporkan);
   (b) kolom `gap` (bufEnd − pos) TUMBUH/STABIL — bukan menyusut ke nol
   (bukti player tidak mengejar live edge). Kirim file JSON ke Muse bila
   ragu — bisa dibaca langsung.
3. **#68 — verifikasi deteksi (di laptop Rama):** indikator di card kanan
   menampilkan `Deteksi: N fps · Mms · webgl|wasm` — catat ketiganya (N = fps riil,
   M = ms/putaran, provider = bukti GPU dipakai). Box harus menempel mulus
   di kendaraan (tidak tertinggal jauh); box prediksi tampil sedikit redup.
   Baca `docs/akurasi-realistis.md` untuk ekspektasi yang sehat.
4. **Rama (opsional tapi disarankan):** jalankan paket benchmark model i5
   (Magna, #48) → angka fps/latensi final YOLO26n di CPU i5 miliknya.
5. Setelah review Rama: push → lapor → (fase berikut) counting in/out + DB.
