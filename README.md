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
└── README.md                   # ← file ini
```

## Jejak keputusan (tiap pilihan bisa dirunut)

| Keputusan | Rujukan |
|---|---|
| React 18 + Vite + TS + hls.js | arsitektur.md §1 |
| **Backend Node.js + Express (#59): reverse proxy `/cctv/*` → server CCTV + serve `dashboard/dist` + `GET /api/health`** — satu origin, CORS hilang permanen di semua environment | Perintah langsung Rama 15 Okt 2026 14:07 WIB; backend/README.md; runbook.md §1 |
| `detection/` = implementasi YOLO26n via kontrak `Detector`/`DetectionPort`; dashboard tak pernah import model langsung | arsitektur.md §2; perintah Rama 15 Okt 2026 14:37 WIB |
| **Anti-buffering: player sengaja dijaga ±5 dtk di belakang live edge** (trik web resmi Bekasi); strip delay tampil JUJUR "±5 dtk (sengaja)" | temuan Rama 15 Okt 2026; arsitektur.md §4 |
| Box deteksi: **BIRU = kendaraan ke atas, HIJAU = ke bawah** (arah dari delta y centroid); kelas: **motor, mobil** (#62: truk dihapus total per koreksi Rama 15 Okt 2026); box dirender dari tracker + persistensi ±0,7 dtk + smoothing EMA | assignment #60, #62 |
| **#65 (bugfix 15 Okt 2026 ~19:00 WIB):** `useDetection.ts` memanggil `detector.setThreshold()` tapi method tidak ada di `WorkerVehicleDetector` → `npm run build` gagal (TS2339 ×2). Perbaikan: `setThreshold(threshold)` diimplementasi penuh — `WorkerVehicleDetector` forward pesan `set-threshold` ke worker → `OnnxVehicleDetector` menyimpan ambang → `parseYolo26nOutput` memfilter dengan `confidenceThreshold` live. Slider UI 0,10–0,90 kini benar-benar mengubah hasil deteksi (terverifikasi: tsc + vite build bersih, uji logika parser lolos) | laporan Rama 18:57 WIB; assignment #65 |
| **#66 (bugfix 15 Okt 2026 ~19:22 WIB):** Rama lapor (1) buffering 80% padahal URL asli lancar, (2) player kurang lebar, (3) card menyusut saat DevTools dibuka. Diagnosis & perbaikan: (1) DUA akar — (a) seek manual `applyIntentionalDelay` (#60) tiap detik berkelahi dengan buffer internal hls.js → siklus seek/rebuffer (seek darurat `emergencyResync` hanya untuk drift > 60 dtk); offset ±5 dtk dialihkan ke NATIF hls.js (`liveSyncDuration: 5`, `liveMaxLatencyDuration: 30`, `maxLiveSyncPlaybackRate: 1` — diverifikasi di source hls.js 1.7.3); (b) proksi tanpa `agent` → http-proxy memaksa `Connection: close` + agent:false → TIAP .ts membayar handshake TLS + slow-start baru (akar ".ts 841KB makan 2–3 dtk"); diperbaiki via `https.Agent({keepAlive:true})` eksplisit. (2) Formula lebar `#62` (`min(100%,(100vh−200px)×16/9)`) diganti: `width:100%` (ikut kontainer) + `aspect-ratio:16/9` + `max-height:calc(100vh−120px)` (cadangan 200px terbukti over-konservatif; 120px = header ±58 + padding 20 + napas ±42) + `main` max-width 1120→1440px. (3) Lebar tidak lagi digantungkan ke tinggi viewport → DevTools tidak bisa menyusutkan card; `:fullscreen` dikecualikan dari max-height. Terverifikasi: tsc + vite build bersih, `node --check` backend | laporan Rama 19:22 WIB; assignment #66 |
| **#67 (bugfix 15 Okt 2026 ~20:10 WIB):** Rama lapor (1) card lebar tapi video pillarbox (bar hitam kiri-kanan), (2) box kedip-kedip + jarang muncul (deteksi ±4,3 fps). Diagnosis berbasis bukti: (1) `max-height` memaksa card LEBIH LEBAR dari 16:9 saat viewport pendek → video `contain` tidak mengisi. Perbaikan: `width:min(100%, calc((100lvh−140px)×16/9))` + `aspect-ratio:16/9` — card SELALU tepat 16:9 → video mengisi sempurna tanpa bar/crop, overlay tetap akurat; `100lvh` stabil thd DevTools. (2) DUA akar: (a) `maxDistPx:90` berasumsi 10fps, padahal inferensi aktual ±4,3fps → kendaraan bergerak ±2,3× lebih jauh antar-frame → track tidak pernah cocok → `seen` tak pernah capai 2 → box tidak dirender ("jarang muncul") — TERBUKTI via uji logika (track pecah dengan 90px, utuh dengan 200px); diperbaiki ke 200px. (b) `minSeenToRender:2` menunda box 2 frame — permintaan eksplisit Rama "box langsung muncul" → diturunkan ke 1. Terverifikasi: tsc + vite build bersih, uji logika tracker lolos (muncul frame-1, track utuh, grace stale) | laporan Rama 20:10 WIB; assignment #67 |
| Bobot `.onnx` tidak di-commit (`.gitignore`); unduh via `scripts/unduh-model.*`; fallback PicoDet = slot kosong (format belum terverifikasi) | arsitektur.md §2, §5 |
| Header COOP/COEP di backend + Vite dev (syarat SharedArrayBuffer untuk ORT WASM multi-thread) | pola Ventra 2026-10-14 |
| URL stream hanya di `config/cameras.ts`; `getStreamUrl()` selalu path relatif `/cctv/…` (logika DEV/PROD dihapus #59) | arsitektur.md §3 + Addendum #59 |
| Status LIVE/DELAY/BUFFERING/RECONNECTING/OFFLINE + backoff 1→2→5→15→30 | arsitektur.md §4 |
| Stall > 10 dtk + multi-bitrate → turunkan kualitas dulu | arsitektur.md §4 butir 4 |
| Metrik sesi: bitrate, resolusi, fps estimasi, stall, reconnect, uptime | arsitektur.md §4 butir 5 |
| Visual: token warna, badge, overlay, OSD, delay strip | mockup-dashboard.html (varian 1, pilihan Rama) |
| Panel **"Log koneksi" di BAWAH video** (full-width, bukan samping), isi event nyata hls.js + timestamp WIB | instruksi eksplisit Rama 15 Okt 2026 |
| Styling plain CSS (bukan utility framework) | mockup tidak memakai utility framework — visual 1:1 lebih terjaga |
| Sinyal buffering = event `waiting` milik `<video>` | hls.js v1.6 tidak mengekspos `BUFFER_STALLED`; perilaku §4 tetap terpenuhi |
| `base: './'` | arsitektur.md §3 |

## Status verifikasi (jujur, 15 Okt 2026)

- `npm run build` (`tsc -b` + `vite build`): **BERSIH, tanpa error** (hanya warning
  chunk > 500 kB yang sudah dinyatakan harmless di QA #54).
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
   - badge DELAY ±5 dtk + strip "Anti-buffering aktif" (BUKAN buffering),
   - box kendaraan muncul: BIRU = ke atas, HIJAU = ke bawah,
   - chip "Deteksi: N fps" di pojok kanan bawah video,
   - uji cabut WiFi → BUFFERING → RECONNECTING → kembali DELAY ±5 dtk.
2. **Rama (opsional tapi disarankan):** jalankan paket benchmark model i5
   (Magna, #48) → angka fps/latensi final YOLO26n di CPU i5 miliknya.
3. Setelah review Rama: push → lapor → (fase berikut) counting in/out + DB.
