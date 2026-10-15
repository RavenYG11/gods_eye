# GODS EYE v0.1 — Dashboard CCTV Kota Bekasi

Viewer web **1 kamera** CCTV Bekasi (HLS, 1080p) — **fullstack**: backend Node.js
(reverse proxy anti-CORS + static server) + frontend React.
Dibangun oleh Gunet (Software Engineer), Assignment #52 (dashboard) + #59 (backend), 15 Okt 2026.

> Scope v0.1 **DIKUNCI** (Meeting #4 D1–D6): stream viewer 1 kamera saja.
> Object detection **DILARANG** dibangun sampai Rama mencabut larangan +
> hasil benchmark i5 keluar. Tanpa rekaman. Face recognition OUT OF SCOPE permanen.
> Perintah Rama 15 Okt 2026 14:07 WIB ("kenapa ga fullstack, suruh gunet bikin backendnya")
> membatalkan keputusan frontend-only — v0.1 kini fullstack (#59).

## Cara menjalankan di localhost (direkomendasikan)

```bash
cd dashboard
npm install
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
│   │   ├── detection/              # ★ KONTRAK SAJA (types.ts + index.ts re-export)
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
| `detection/` hanya kontrak (tanpa stub `detect()`) | arsitektur.md §2 |
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

## Berikutnya (sesuai urutan Meeting #4)

1. **Rama (laptop, jaringan rumah):** jalankan checklist verifikasi `docs/runbook.md` §7
   (`git pull` → `npm install` (dashboard + backend) → `npm run build` → `npm start`
   di `backend/` → badge LIVE, log koneksi, uji cabut WiFi).
2. **Rama:** jalankan paket benchmark model i5 (Magna, #48) → putuskan model deteksi.
3. Setelah larangan detection dicabut: arsitektur ulang fase deteksi → audit Cipher
   (fokus: sumber model, UU PDP) → QA ulang.
