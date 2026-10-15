# GODS EYE v0.1 — Dashboard CCTV Kota Bekasi

Viewer web **1 kamera** CCTV Bekasi (HLS, 1080p) — 100% frontend, **tanpa backend**.
Dibangun oleh Gunet (Software Engineer), Assignment #52, 15 Okt 2026.

> Scope v0.1 **DIKUNCI** (Meeting #4 D1–D6): stream viewer 1 kamera saja.
> Object detection **DILARANG** dibangun sampai Rama mencabut larangan +
> hasil benchmark i5 keluar. Tanpa rekaman. Face recognition OUT OF SCOPE permanen.

## Cara menjalankan di localhost

```bash
cd dashboard
npm install
npm run dev        # → http://localhost:5173
```

Build produksi (output statis, `base: './'` sehingga bisa ditaruh di subfolder):

```bash
cd dashboard
npm run build      # → dashboard/dist/
```

Lalu salin isi `dashboard/dist/` ke `C:\xampp\htdocs\gods-eye\` dan buka
**http://localhost/gods-eye/**. (Deploy default = localhost, rujukan
`docs/arsitektur.md` §3.)

## Struktur

```
gods-eye/
├── dashboard/                  # App utama (React 18 + Vite + TS + hls.js)
│   ├── src/
│   │   ├── components/
│   │   │   ├── StreamPlayer.tsx      # <video> + overlay status + OSD + fullscreen
│   │   │   ├── StreamHealthBadge.tsx # Badge LIVE/DELAY/BUFFERING/… + popover metrik
│   │   │   ├── CameraSelector.tsx    # Disabled, 1 item (siap multi-kamera)
│   │   │   └── ConnectionLog.tsx     # ★ Panel "Log koneksi" (instruksi Rama)
│   │   ├── detection/              # ★ KONTRAK SAJA (types.ts + index.ts re-export)
│   │   ├── config/cameras.ts       # SATU-SATUNYA tempat URL stream
│   │   ├── lib/streamHealth.ts     # Mesin status + auto-reconnect + pencatat log
│   │   ├── lib/useStreamSession.ts # Jembatan engine → React
│   │   ├── lib/log.ts              # Tipe entri log + format WIB
│   │   ├── App.tsx                 # Header + player + log + bar kamera
│   │   └── styles.css              # Token visual 1:1 dari mockup
│   ├── vite.config.ts              # base './'
│   └── package.json
├── experiments/                # Paket benchmark i5 (Magna) — bukan bagian build
├── docs/                       # arsitektur.md (Sentot #49) + mockup (Prapto #50/#51)
└── README.md                   # ← file ini
```

## Jejak keputusan (tiap pilihan bisa dirunut)

| Keputusan | Rujukan |
|---|---|
| React 18 + Vite + TS + hls.js, frontend-only | arsitektur.md §1 |
| `detection/` hanya kontrak (tanpa stub `detect()`) | arsitektur.md §2 |
| URL stream hanya di `config/cameras.ts` | arsitektur.md §3 |
| Status LIVE/DELAY/BUFFERING/RECONNECTING/OFFLINE + backoff 1→2→5→15→30 | arsitektur.md §4 |
| Stall > 10 dtk + multi-bitrate → turunkan kualitas dulu | arsitektur.md §4 butir 4 |
| Metrik sesi: bitrate, resolusi, fps estimasi, stall, reconnect, uptime | arsitektur.md §4 butir 5 |
| Visual: token warna, badge, overlay, OSD, delay strip | mockup-dashboard.html (varian 1, pilihan Rama) |
| Panel **"Log koneksi" di BAWAH video** (full-width, bukan samping), isi event nyata hls.js + timestamp WIB | instruksi eksplisit Rama 15 Okt 2026 |
| Styling plain CSS (bukan utility framework) | mockup tidak memakai utility framework — visual 1:1 lebih terjaga |
| Sinyal buffering = event `waiting` milik `<video>` | hls.js v1.6 tidak mengekspos `BUFFER_STALLED`; perilaku §4 tetap terpenuhi |
| `base: './'` | arsitektur.md §3 (http://localhost/gods-eye/) |

## Status verifikasi (jujur, 15 Okt 2026)

- `npm run build` (`tsc -b` + `vite build`): **BERSIH, tanpa error.**
- `dist/` disajikan lokal: `index.html`, CSS, JS semua HTTP 200, path aset
  relatif (`./assets/…`) — siap ditaruh di subfolder XAMPP.
- **Stream `.m3u8` TIDAK terjangkau dari VM ini** (timeout — pola sama dengan
  temuan riset CCTV Jakarta: server memblokir IP data center). Rama sudah
  memverifikasi `200 OK` dari IP rumahnya. **Cek "stream tampil" wajib
  diulang di laptop Rama** (checklist di `docs/runbook.md` §7).
- QA Testarossa #54: **LULUS DENGAN CATATAN** — laporan: `docs/qa-report-v0.1.md`.
  Audit keamanan Cipher #53: lulus tanpa temuan kritis.
- Runbook operasional (Epthal #55): **`docs/runbook.md`** — clone, dev, build,
  deploy XAMPP, `.htaccess` yang disarankan, troubleshooting, backup/rollback.

## Berikutnya (sesuai urutan Meeting #4)

1. **Rama (laptop, jaringan rumah):** jalankan checklist verifikasi `docs/runbook.md` §7
   (`git pull` → `npm install` → `npm run dev` → badge LIVE, log koneksi, uji cabut WiFi).
2. **Rama:** jalankan paket benchmark model i5 (Magna, #48) → putuskan model deteksi.
3. Setelah larangan detection dicabut: arsitektur ulang fase deteksi → audit Cipher
   (fokus: sumber model, UU PDP) → QA ulang.
