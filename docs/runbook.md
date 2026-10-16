# RUNBOOK — GODS EYE v0.1 (Dashboard CCTV Kota Bekasi)

**Pemilik runbook:** Epthal (DevOps Engineer), Assignment #55 · **Tanggal:** 15 Okt 2026
**Revisi backend fullstack:** Gunet, Assignment #59 · **Tanggal:** 15 Okt 2026
**Scope:** operasional v0.1 — dashboard web stream viewer **1 kamera** CCTV Bekasi (HLS 1080p).
Fullstack: backend Node.js (reverse proxy anti-CORS + static server) + frontend React.
Build QA: Testarossa #54 — **LULUS DENGAN CATATAN** (`docs/qa-report-v0.1.md`).

> Scope v0.1 **DIKUNCI** (Meeting #4 D1–D6): object detection DILARANG dibangun sampai Rama mencabut
> larangan + hasil benchmark i5 keluar. Tanpa rekaman. Face recognition OUT OF SCOPE permanen (UU PDP).
> Perintah Rama 15 Okt 2026 14:07 WIB ("kenapa ga fullstack, suruh gunet bikin backendnya")
> **membatalkan** keputusan frontend-only — v0.1 kini fullstack (#59).

---

## 1. Arsitektur singkat

```
Browser (laptop Rama, jaringan rumah)
  │  satu origin → CORS HILANG TOTAL (dev maupun production)
  ▼
┌── backend/ ── Node.js + Express ── http://localhost:3000 ──────────┐
│  GET /            → file statis dashboard/dist (hasil npm run build)│
│  GET /cctv/*      → REVERSE PROXY ──HTTPS──▶                       │
│  GET /api/health  → { ok, upstream, frontendBuilt } (health check)  │
│  /api/dataset     → Kelola Dataset (#72 FINAL: SQLite backend/data/     │
│    dataset.db — POST/GET/DELETE/GET /:id/image; gambar = BLOB di DB)     │
└────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                              https://eofficev2.bekasikota.go.id
                              (server CCTV Bekasi — .m3u8, segmen .ts)
```

- Tidak ada server aplikasi logika bisnis, tidak ada database, tidak ada API key/secret.
- Satu-satunya dependensi runtime eksternal = URL stream CCTV di `dashboard/src/config/cameras.ts`
  (tidak ada URL hardcode di komponen lain). `getStreamUrl()` di file itu **selalu**
  menghasilkan path relatif `/cctv/…` (same-origin) — tidak ada lagi logika DEV-vs-PROD.
- Yang melayani `/cctv/*` tergantung mode jalan:
  - **Dev** (`npm run dev` di `dashboard/`): proksi Vite (`server.proxy` di `vite.config.ts`).
  - **Production** (`npm start` di `backend/`): reverse proxy Express (`backend/server.js`).
  - Keduanya meneruskan ke `https://eofficev2.bekasikota.go.id` (`changeOrigin: true`,
    prefix `/cctv` dibuang). Frontend tidak peduli mode apa — selalu request `/cctv/…`.

---

## 2. Prasyarat

| Kebutuhan | Minimal |
|---|---|
| Node.js + npm | Node **22.5+** (cek: `node -v`, `npm -v`) — syarat `node:sqlite` bawaan sejak #73 |
| Browser | Chrome / Edge terbaru (mendukung MSE + hls.js) |
| Git | untuk clone repo |
| Jaringan rumah | **wajib dari IP rumah** — server CCTV memblokir IP data center/VM (terbukti di riset) |

---

## 3. Clone & install

```bash
git clone https://github.com/RavenYG11/gods_eye.git
cd gods_eye/dashboard
npm install
cd ../backend
npm install
```

> `package-lock.json` ikut di-commit → versi dependensi deterministik.

---

## 4. Cara jalan

### 4a. Fullstack — DIREKOMENDASIKAN (satu origin, bebas CORS permanen)

Ritual baku sejak #74 (16 Okt 2026) — dari ROOT repo:

```bash
git pull
npm run setup    # dashboard: npm install + build · backend: npm install
npm start        # → http://localhost:3000
```

Sekali saja (pertama kali / bila model hilang): unduh bobot deteksi
`scripts\unduh-model.bat` (Windows) atau `bash dashboard/scripts/unduh-model.sh`
(Linux/Mac) → `dashboard/public/models/yolo26n.onnx`, lalu ulangi `npm run setup`.
`npm run setup` otomatis mengingatkan (`scripts/check-model.mjs`) bila model
belum ada. Aman di bash Windows (Rama): hanya memakai `npm --prefix`.

Buka **http://localhost:3000**. Backend melayani app + proksi stream dari satu
origin → browser tidak kena CORS di environment apa pun.

> **Model deteksi (#60):** file `yolo26n.onnx` (~10 MB) TIDAK ikut repo
> (`.gitignore`) — wajib unduh sekali via script di atas SEBELUM `npm run setup`
> (agar ikut ke `dist/models/`). Tanpa file ini, chip deteksi menampilkan
> "Model deteksi gagal dimuat — klik untuk coba lagi" (stream tetap jalan).

Buka **http://localhost:3000**. Backend melayani app + proksi stream dari satu
origin → browser tidak kena CORS di environment apa pun.

> Port default `3000`. Ganti bila bentrok: `PORT=8080 npm start`.
> Upstream proksi default `https://eofficev2.bekasikota.go.id`;
> ganti via `CCTV_UPSTREAM=https://… npm start` (lihat `backend/README.md`).

### 4b. Dev UI — iterasi cepat (hot reload)

```bash
cd dashboard
npm run dev          # → http://localhost:5173
```

Untuk ngoding dashboard (Vite hot-reload otomatis tiap simpan file).
Proksi `/cctv` tetap tersedia via `server.proxy` di `vite.config.ts`,
jadi stream jalan juga di mode ini.

**Preflight cepat (opsional, dari laptop):** pastikan playlist terjangkau sebelum buka app:

```powershell
curl -s -o NUL -w "%{http_code}`n" https://eofficev2.bekasikota.go.id/backupcctv/m3/Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi.m3u8
# Harus keluar: 200
```

Ganti kamera / URL stream: edit **hanya** `dashboard/src/config/cameras.ts`.

---

## 5. Build produksi

Sejak #74, build produksi = bagian dari ritual root (tidak perlu manual):

```bash
npm run setup    # = dashboard: npm install + build · backend: npm install
```

Manual (bila perlu saja):

```bash
cd dashboard
npm run build        # = tsc -b && vite build
```

Hasil: `dashboard/dist/` berisi `index.html` + `assets/*.js` + `assets/*.css` (statis).
Folder inilah yang disajikan backend (`express.static`). Tidak perlu copy manual
ke mana-mana — cukup `npm start` (root).

**Catatan build (QA #54, temuan O1):** Vite memberi warning `chunk > 500 kB`
(`index-*.js` ±759 KB — mayoritas hls.js). Ini **bukan bug**; untuk app localhost
tidak berdampak. Optimasi (code-split hls.js via dynamic `import()`) dicatat sebagai backlog.

**Jangan commit `dist/` dan `node_modules/`** — `.gitignore` di root repo sudah menutup:
`node_modules/`, `dashboard/dist/`, `*.onnx`, `*.pt`, `*.bin`, `*.pkl`, `.DS_Store`.

---

## 6. Opsi lama: serve via XAMPP — `http://localhost/gods-eye/` (tidak disarankan)

> Sejak #59, cara produksi yang didukung = **backend** (§4a). Opsi XAMPP ini
> didokumentasikan apa adanya untuk arsip. **Batasan:** Apache XAMPP tidak punya
> proksi `/cctv` → request hls.js dari `http://localhost/gods-eye/` tetap kena
> CORS-block (server CCTV tidak mengirim `Access-Control-Allow-Origin`).
> Tanpa `mod_proxy` Apache, batasan ini tidak bisa diatasi di XAMPP.

1. Jalankan `npm run build` (lihat §5).
2. Salin **isi** `dashboard/dist/` ke `C:\xampp\htdocs\gods-eye\`
   (folder `gods-eye` dibuat bila belum ada; yang disalin isinya: `index.html` + folder `assets/`).
3. Pastikan Apache XAMPP berjalan (XAMPP Control Panel → Start Apache).
4. Buka **http://localhost/gods-eye/** di Chrome/Edge — ⚠️ stream akan kena CORS (§8).

### 6.1 `.htaccess` yang disarankan (XAMPP)

Simpan sebagai `C:\xampp\htdocs\gods-eye\.htaccess`. **Disarankan, bukan wajib**
(rekomendasi QA #54 — mengeraskan header saat disajikan dari Apache):

```apache
# GODS EYE v0.1 — hardening ringan untuk hosting statis di XAMPP
Options -Indexes
<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "no-referrer"
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob: https://eofficev2.bekasikota.go.id; connect-src 'self' https://eofficev2.bekasikota.go.id; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:"
</IfModule>
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType application/javascript "access plus 7 days"
  ExpiresByType text/css "access plus 7 days"
  ExpiresByType text/html "access plus 0 seconds"
</IfModule>
```

---

## 7. Checklist verifikasi di laptop Rama (WAJIB)

Stream **tidak terjangkau dari VM/server** (WAF memblokir IP data center) — QA #54
hanya bisa memverifikasi lewat bundle nyata tanpa stream. Verifikasi berikut
**wajib dijalankan dari laptop Rama (jaringan rumah)**:

**Mode fullstack (backend, §4a) — jalur utama:**
- [ ] `cd backend && npm start` → buka `http://localhost:3000` — halaman tampil tanpa error console.
- [ ] `curl http://localhost:3000/api/health` → `{"ok":true,…,"frontendBuilt":true}`.
- [ ] **Kelola Dataset (#72 FINAL — database):** card "Kelola Dataset" tampil di kolom
      kanan (bawah "Deteksi kendaraan"); paste 1 screenshot (`Ctrl+V` di area paste,
      label `motor`) → thumbnail muncul + ringkasan `motor: N` bertambah; `curl
      http://localhost:3000/api/dataset` memuat metadata baru; hapus via tombol ×
      → baris DB hilang. Gambar tersimpan sebagai BLOB di `backend/data/dataset.db`
      (dibuat otomatis, di-gitignore). Seed PNG (`motor-1.png`, `mobil-1.png`) tetap
      file di `dashboard/public/dataset/` — commit manual dari laptop
      (`docs/dataset.md` — JANGAN via konektor).
- [ ] Badge status berubah menjadi **● LIVE** dalam ±10 detik.
- [ ] Panel **"Log koneksi"** (di bawah player, full-width) terisi event nyata, mis.
      `OK Terhubung — manifest dimuat (N level kualitas tersedia).`
- [ ] Klik badge → popover "Metrik sesi berjalan": bitrate, resolusi, FPS **terisi angka** (bukan `–`).
- [ ] Matikan WiFi ±10 detik → badge **◌ BUFFERING** lalu **↻ MENYAMBUNG ULANG**,
      log mencatat urutan backoff (1s → 2s → 5s → 15s → 30s); nyalakan WiFi → kembali **LIVE**.
- [ ] **#60/#66/#68/#71 — Anti-buffering:** setelah stream stabil, badge menunjukkan
      **● DELAY · ±45 dtk** (BUKAN LIVE — ini disengaja). Info delay tampil
      JUJUR sebagai ringkasan di panel **"Log koneksi"** (#71: strip kuning
      bawah video DIHAPUS).
      (#66: offset dijaga NATIF oleh hls.js `liveSyncDuration` — TIDAK ADA
      lagi seek manual per detik; log "Anti-buffering: posisi diset…" pola #60
      sudah dihapus. Buffering berulang + log "stall teratasi" terus-menerus =
      regresi pola #60, laporkan.)
      (#68: `liveMaxLatencyDuration: Infinity` — player TIDAK PERNAH ditarik
      mengejar live edge; `emergencyResync` DIHAPUS → penjaga jendela DVR
      (seek hanya bila posisi hampir kedaluwarsa, target edge−45 dtk).
      BUKTI UJI: klik badge → popover metrik → "Unduh log playback (JSON)"
      → biarkan 10+ menit → kolom `gap` (bufEnd−pos) harus TUMBUH/STABIL
      di sekitar 45 dtk, bukan menyusut ke nol; TIDAK BOLEH ada siklus
      buffering berulang.)
      (#71 — ANGKA KONFIG, `dashboard/src/lib/streamHealth.ts` → `new Hls()`:
      `liveSyncDuration: 45` (target ±45 dtk di belakang live edge —
      AKAR LAG: nilai lama 5 dtk < ekor fetch 1 segmen lambat
      `fragLoadingMaxRetry: 4` × `fragLoadingRetryDelay: 2000` = 8 dtk+,
      sehingga tiap jitter = event `waiting` = overlay "Buffering…"),
      `maxBufferLength: 120`, `maxMaxBufferLength: 600`,
      `backBufferLength: 90` (scrub DVR mundur tidak langsung fetch ulang),
      `liveMaxLatencyDuration: Infinity` (tetap), `maxLiveSyncPlaybackRate: 1`
      (tetap), `DVR_SAFE_BEHIND_SEC = 45` (selaras cushion).
      LOGIKA TAMBAHAN: **penjaga prebuffer internal** — bila gap < 8 dtk
      selagi diputar → `video.pause()` agar hls.js mengisi buffer sampai
      ≥30 dtk lalu `play()` — TANPA overlay spinner (flag `prebuffering`
      di snapshot; chip tidak tampil "DIJEDA"); timeout 25 dtk → kembali
      ke jalur buffering normal. Log mencatat "Prebuffer: cushion menipis…"
      bila aktif — kemunculannya = sinyal jaringan sedang berat, bukan bug.)
- [ ] **#60 — Deteksi kendaraan:** box muncul di atas kendaraan —
      **BIRU = ke atas, HIJAU = ke bawah**, label "mobil/motor + % + #id"
      (#62: kelas truk DIHAPUS — hanya motor & mobil). **#71:** indikator
      pindah dari dalam video ke card **"Deteksi kendaraan" di KANAN video**
      (responsif: menumpuk di bawah pada layar ≤1100px): "Deteksi: N fps ·
      Mms · webgl|wasm" (N = fps RIIL hasil inferensi, M = biaya/putaran
      worker, provider = bukti GPU dipakai/tidak) + slider confidence +
      tombol Nyalakan/Matikan deteksi. Card video bersih: hanya video +
      DVR bar + kontrol play.
- [ ] **#62/#68 — Anti-kedip + prediksi gerak:** box TIDAK boleh muncul-hilang
      sepersekian detik. Uji: amati 1 kendaraan lewat — box MENGIKUTI MULUS
      pada frame-rate video (prediksi velocity #68), tidak tertinggal jauh;
      box sedikit redup = posisi prediksi (bukan deteksi segar), lalu hilang
      bila kendaraan benar-benar pergi. (#67: box langsung muncul sejak
      deteksi pertama — syarat "2 frame" #62 sudah dicabut atas permintaan Rama.)
- [ ] **#62/#66 — Layout:** di 1366×768 dan 1920×1080, seluruh player terlihat
      TANPA scroll/maximize. (#66: lebar player mengikuti LEBAR kontainer
      (`width:100%` + `main` max-width 1440px), TINGGI dibatasi
      `max-height:calc(100vh−120px)` — bukan lagi `min(100%,(100vh−200px)×16/9)`.
      Buka DevTools (docked): card TIDAK boleh menyusut melebar-menyempit;
      yang boleh berubah hanya tinggi maksimal (video letterbox tipis bila
      viewport sangat pendek — dapat diterima). Fullscreen: player mengisi
      penuh viewport tanpa terpotong.)
      (#71: card deteksi di kanan video; di layar ≤1100px card turun ke
      bawah. TIDAK ADA tooltip saat hover DVR bar/chip waktu/angka durasi —
      `title` dihapus total.)
- [ ] **#62/#68 — Slider threshold:** card "Deteksi kendaraan" di kanan video
      (#71: pindah dari pojok kanan bawah player) berisi kontrol
      "Confidence 0.40" + slider 0,10–0,90. Geser → nilai berubah, box
      bertambah/berkurang mulai frame berikutnya TANPA reload. (#68: default
      0,5→0,4 — kendaraan jelas di CCTV malam skor 51–54%, nyaris gugur di
      0,5.) Naikkan bila box palsu; turunkan bila kendaraan jauh tak terdeteksi.
- [ ] **#69/#70/#71 — Kontrol playback:** tombol ▶/❚❚ di kanan bawah video
      (sebelah tombol fullscreen) — klik → video jeda (ikon jadi ▶ + aksen
      hijau), klik lagi → lanjut. Klik video juga toggle. Chip kiri bawah
      menampilkan "−N dtk dari live" (atau "LIVE" bila ≤3 dtk) + "DIJEDA"
      saat pause (#71: jeda internal prebuffer TIDAK tampil "DIJEDA").
      **Bar DVR BISA DI-SCRUB** (#70.1): klik/drag/←→/Home/End → posisi play
      pindah dalam jendela DVR (dijepit otomatis); **#71: bar DIPERPANJANG
      hampir selebar video** (dulu 280px).
      **Angka di bawah bar** (#71, revisi #70): "00:46 / 12:03" = posisi
      playback dalam jendela DVR / LIFETIME sejak tab dibuka (reset hanya
      saat tab di-close/restart).
      Bar & chip update TIAP DETIK (#70.2 — dulu "mentok" saat delay stabil).
      Saat dijeda: box deteksi BEKU di posisi terakhir (tidak jalan sendiri);
      guard DVR tidak menarik frame yang dijeda. **Resume kritis** (#70.3):
      jeda 3+ menit (posisi kedaluwarsa) → klik play → HARUS jalan <3 dtk
      (clamp ke edge−45 dtk + startLoad + watchdog recoverMediaError);
      bila masih stuck >4 dtk, log mencatat "Resume macet".
- [ ] **#70.4 — Tombol unduh log:** header panel "Log koneksi" kini punya
      tombol **"Unduh log playback"** di samping "Bersihkan" (selain yang di
      popover metrik) — klik → file JSON terunduh.
- [ ] Pagar scope tetap: **tanpa tombol record**, tanpa face recognition.
      (Panel deteksi kini ADA — larangan dicabut Rama 15 Okt 2026 14:37 WIB.)

**Mode dev (§4b):**
- [ ] `npm run dev` → buka `http://localhost:5173` — badge **● LIVE** juga muncul
      (proksi Vite, bukan backend).

**Preflight backend tanpa stream (bisa dari VM):**
- [ ] `GET /` → `200 text/html`; `GET /api/health` → `ok:true`; path acak → `200` (SPA fallback).
- [ ] `GET /api/dataset` → `{"ok":true,"items":[…],"counts":{…}}`;
      `GET /api/dataset/1/image` → `200 image/png` (biner = isi DB).

---

## 8. Troubleshooting

| Gejala | Penyebab umum | Tindakan |
|---|---|---|
| `npm start` (backend) → peringatan `dashboard/dist belum ada` | Frontend belum di-build | `cd dashboard && npm run build`, lalu `npm start` lagi di `backend/` |
| `npm start` gagal: `EADDRINUSE` / port 3000 dipakai | Port bentrok | Matikan proses lain, atau `PORT=8080 npm start` |
| `GET /cctv/…` → `500` | Upstream tidak terjangkau dari jaringan ini (WAF blokir IP / internet mati) — **bukan** bug routing bila `/` dan `/api/health` normal | Jalankan preflight §4 (harus `200`); uji dari jaringan rumah / tethering HP |
| Badge LIVE di dev (`:5173`) tapi tidak via backend (`:3000`) | Backend belum jalan / `dist/` basi | Pastikan `npm start` jalan; `npm run build` ulang di `dashboard/` bila frontend diubah |
| Overlay `Memuat stream…` / request `.m3u8` red X, 0 byte, tanpa status | **CORS-block** — terjadi bila app dibuka BUKAN via backend/dev-server (mis. XAMPP §6 atau file langsung) | Cara jalan yang didukung = §4a (backend) atau §4b (dev). Jangan serve `dist/` mentah tanpa proksi |
| Playlist termuat (badge LIVE sebentar) lalu gagal / error CORS di console saat segmen diminta | URL segmen di `.m3u8` **absolut** (bukan relatif) → hls.js request segmen langsung ke server → kena CORS lagi | Belum terverifikasi dari VM (WAF blokir IP). Periksa isi playlist dari laptop Rama; laporkan ke manager, jangan mengarang solusi. Solusi cadangan: rewrite playlist di proksi backend |
| Halaman putih / `Failed to fetch` ke `.m3u8` | WAF server memblokir IP jaringan ini | Uji dari jaringan lain (tethering HP); jalankan preflight §4 |
| Overlay `Gagal memuat stream` + log `GALAT` | Manifest tidak terjangkau / playlist tidak valid | Cek preflight §4 → harus `200` + isi diawali `#EXTM3U` |
| `HLS tidak didukung browser ini.` | Browser tanpa MSE (atau sangat lawas) | Pakai Chrome/Edge terbaru |
| Chip "Model deteksi gagal dimuat" | `yolo26n.onnx` belum diunduh / build sebelum unduh | `scripts\unduh-model.bat` → `npm run build` ulang; klik chip untuk coba lagi |
| Deteksi lambat (< 5 fps) di laptop | CPU lemah / tab lain berat | Tutup tab berat; ORT otomatis 1 thread bila tanpa COOP/COEP — pastikan via backend/:3000 |
| Box deteksi berkedip (muncul-hilang) | (Pra-#62) render dari raw detection | **Sudah diperbaiki #62** (render dari tracker + grace ±0,7 dtk + EMA). Bila masih kedip setelah pull terbaru: catat pola (kendaraan jauh/dekat?) lalu lapor — jangan edit ambang dulu |
| Box palsu bermunculan (bayangan, marka jalan) | Ambang confidence terlalu rendah | **Naikkan slider "Confidence"** (card "Deteksi kendaraan" di kanan video) — mis. 0,60–0,70; berlaku instan |
| Kendaraan jauh tidak terdeteksi | Ambang confidence terlalu tinggi | **Turunkan slider "Confidence"** — mis. 0,30–0,40; bila tetap hilang, itu batas resolusi model, bukan bug |
| Badge `◌ BUFFERING` terus-menerus | Bandwidth tidak cukup untuk level 1080p | App otomatis turunkan kualitas (stall > 10 dtk); bila tetap, cek kecepatan internet |
| `npm install` gagal | Node terlalu lama / cache korup | `node -v` (butuh **22.5+** sejak #73 — `node:sqlite` modul bawaan); `npm cache clean --force` lalu ulangi |
| `npm install` gagal: `node-gyp` / butuh Visual Studio | (Pra-#73) `better-sqlite3` tanpa prebuilt untuk Node 24 | **Sudah diperbaiki #73** — backend kini pakai `node:sqlite` bawaan, nol native dependency. Bila masih muncul: pastikan pull sudah mencakup commit #73 |
| Log koneksi kosong | JS error / bundle gagal load | Buka DevTools → Console; pastikan `npm run build` sukses & `dist/` lengkap |

**Aturan diagnosis (gaya kerja Epthal): periksa log sebelum menyimpulkan.**
Urutan: panel "Log koneksi" di app → `GET /api/health` → DevTools Console → Network tab (lihat request `.m3u8`/`.ts`) → baru simpulkan.

### 8.1 Threshold deteksi (#62) — dokumentasi singkat

- **Default 0,5** (seimbang). Dasar: riset #48 §4.1 — default conf Ultralytics
  0,25 dioptimalkan untuk skor mAP benchmark, bukan tampilan live; model
  NMS-free YOLO26n memancarkan 300 proposal/frame sehingga ambang rendah
  membanjiri overlay dengan kotak borderline yang ikut berkedip.
- **Slider live** di pojok kanan bawah player: range 0,10–0,90 (langkah 0,05),
  nilai tampil di samping label. Berlaku mulai frame berikutnya — tanpa reload
  model/worker/halaman.
- **Aturan praktis:** box palsu → naikkan; kendaraan jauh hilang → turunkan.
  Perubahan tidak disimpan permanen (kembali ke 0,5 saat halaman di-reload) —
  bila Rama menemukan nilai favoritnya, catat angkanya lalu minta diubah jadi
  default di `dashboard/src/detection/vehicleConfig.ts` (`CONFIDENCE_THRESHOLD`).
- **Kelas yang dideteksi:** hanya **motor** (COCO 3) & **mobil** (COCO 2).
  Kelas truk dihapus total per koreksi Rama 15 Okt 2026 (#62).

---

## 9. Backup & rollback

- **Backup kode:** setiap perubahan di-commit & push ke `main` repo `gods_eye`.
- **Backup deploy:** tidak ada folder deploy manual lagi (backend serve `dist/` langsung
  dari repo). Untuk kembali ke versi lama: `git checkout <commit-lama>` → `npm run build`
  → `npm start`.
- Tidak ada database → tidak ada prosedur backup/restore data.

---

## 10. Monitoring (v0.1)

- **Panel "Log koneksi"** di dashboard = monitor bawaan: event INFO/OK/PERINGATAN/GALAT
  + timestamp WIB + counter event + tombol Bersihkan (hanya menyembunyikan tampilan).
- **Popover badge status** = metrik sesi: bitrate aktif, resolusi, estimasi FPS, stall, reconnect, uptime.
- **Backend:** log console (`[gods-eye] …`) saat start; `GET /api/health` untuk cek hidup
  (`frontendBuilt:false` = lupa `npm run build`).

---

## 11. Struktur repo

```
gods_eye/
├── README.md                 # Ringkasan + cara jalan cepat
├── .gitignore                # node_modules/, dist/, bobot model (*.onnx/*.pt/…)
├── backend/                  # ★ BACKEND (#59) — Node.js + Express
│   ├── server.js             # Reverse proxy /cctv/* + serve dashboard/dist + /api/health + /api/dataset (#72 DB)
│   ├── lib/dataset-db.js     # #72 FINAL + #73: modul SQLite dataset (node:sqlite bawaan Node ≥22.5) — skema, seed, CRUD
│   ├── data/dataset.db       # (dibuat otomatis, DI-GITIGNORE — jangan di-commit)
│   ├── package.json          # express + http-proxy-middleware (nol native dep sejak #73)
│   └── README.md             # Cara jalan backend + env var + batasan
├── dashboard/                # App (React 18 + Vite + TS + hls.js) — TANPA node_modules/ & dist/
│   ├── src/
│   │   ├── components/       # StreamPlayer, StreamHealthBadge, CameraSelector, ConnectionLog
│   │   ├── config/cameras.ts # SATU-SATUNYA tempat URL stream (selalu path /cctv/… sejak #59)
│   │   ├── detection/        # KONTRAK SAJA (types) — detection-ready, tanpa model
│   │   └── lib/              # streamHealth (mesin status+backoff), log, useStreamSession
│   ├── index.html
│   ├── package.json / package-lock.json
│   ├── vite.config.ts        # base './' + server.proxy /cctv (mode dev)
│   └── tsconfig*.json
└── docs/
    ├── arsitektur.md         # Sentot #49 — arsitektur Opsi C Hybrid (+ Addendum #59)
    ├── mockup-dashboard.html # Prapto #50 — varian 1 (PILIHAN Rama)
    ├── mockup-varian-2.html  # Prapto #51 — varian 2
    ├── mockup-varian-3.html  # Prapto #51 — varian 3
    ├── qa-report-v0.1.md     # Testarossa #54 — LULUS DENGAN CATATAN
    └── runbook.md            # ← file ini
```

## 12. Jejak rantai kerja

| # | Staff | Hasil |
|---|---|---|
| 49 | Sentot | `docs/arsitektur.md` |
| 50 | Prapto | `docs/mockup-dashboard.html` (varian 1 — pilihan Rama) |
| 51 | Prapto | `docs/mockup-varian-2.html`, `docs/mockup-varian-3.html` |
| 52 | Gunet | Build `dashboard/` (dari arsitektur + mockup varian 1 + panel Log koneksi) |
| 53 | Cipher | Audit keamanan — LULUS tanpa temuan kritis |
| 54 | Testarossa | QA — **LULUS DENGAN CATATAN** (verifikasi stream wajib di laptop Rama) |
| 55 | Epthal | Runbook ini + push ke `RavenYG11/gods_eye` |
| 58 | Gunet | **Bugfix CORS**: Vite dev-proxy `/cctv/*` → server CCTV; `getStreamUrl()`
  (DEV = proksi, PROD = absolut); runbook §1/§4/§6/§8 diperbarui + batasan segmen absolut.
  ⚠️ "Stream tampil" WAJIB verifikasi Rama di laptop (VM diblokir WAF — tidak bisa diuji). |
| 59 | Gunet | **Backend fullstack** (perintah langsung Rama 15 Okt 2026 14:07 WIB):
  `backend/` (Express: reverse proxy `/cctv/*` → server CCTV + serve `dashboard/dist`
  + `GET /api/health`); `cameras.ts` selalu path relatif `/cctv/…` (logika DEV/PROD dihapus);
  runbook + README direvisi. Teruji lokal: `/` → 200, `/api/health` → ok, `/cctv/*` teruskan
  (500 dari VM = upstream diblokir WAF, routing benar).
  ⚠️ "Video tampil" WAJIB verifikasi Rama di laptop (jaringan rumah). |
| 60 | Gunet | **BUILD ONLY — JANGAN PUSH** (review Rama dulu). Dua fitur: (1) **Anti-buffering**:
  player dijaga ±5 dtk di belakang live edge (trik web Bekasi), strip jujur "±5 dtk",
  `maxLiveSyncPlaybackRate: 1`, reconnect existing utuh. (2) **Deteksi kendaraan YOLO26n**
  (larangan dicabut Rama 14:37 WIB): ONNX Runtime WASM di Web Worker (~10fps, video 60fps
  tak block), kelas motor/mobil/truk kecil/truk besar, CentroidTracker (arah dari delta y),
  box BIRU=ke atas / HIJAU=ke bawah, canvas overlay + toggle + chip fps.
  Header COOP/COEP (backend + Vite dev) untuk WASM multi-thread. Model via
  `scripts/unduh-model.*` (tidak di-commit). Fallback PicoDet = slot kosong
  (format belum terverifikasi — tidak dikarang). Terverifikasi VM: `npm run build` bersih;
  17 unit test logika lolos; model asli [1,300,6] terkonfirmasi via ORT;
  headless Chromium: render tanpa JS error, worker+model+wasm termuat, chip "Deteksi" tampil,
  toggle on/off OK. ⚠️ **Stream + akurasi deteksi WAJIB verifikasi Rama di laptop.** |
| 66 | Gunet | **BUGFIX — JANGAN PUSH** (workflow mengikat: build → lapor Rama → push bila setuju).
  Laporan Rama 19:22 WIB: (1) buffering 80% padahal URL asli lancar, (2) player kurang
  lebar, (3) card menyusut saat DevTools dibuka. Diagnosis: (1) DUA akar — (a) seek manual
  `applyIntentionalDelay` (#60) tiap detik berkelahi dengan buffer hls.js → siklus
  seek/rebuffer; offset ±5 dtk dialihkan ke NATIF hls.js (`liveSyncDuration: 5`,
  `liveMaxLatencyDuration: 30`, `maxLiveSyncPlaybackRate: 1`; `tickDelay()` kini murni
  mengukur; seek darurat hanya `emergencyResync()` bila drift > 60 dtk); (b) proksi
  `/cctv/*` tanpa `agent` → http-proxy memaksa `Connection: close` → tiap .ts membayar
  handshake TLS + slow-start baru (akar ".ts 841KB makan 2–3 dtk"); diperbaiki via
  `https.Agent({keepAlive:true})` eksplisit. (2) Formula `#62`
  (`min(100%,(100vh−200px)×16/9)`) diganti `width:100%` + `aspect-ratio:16/9` +
  `max-height:calc(100vh−120px)` (cadangan 200px over-konservatif; 120px = header ±58 +
  padding 20 + napas ±42) + `main` max-width 1120→1440px. (3) Lebar tak lagi digantungkan
  ke tinggi viewport → DevTools tak bisa menyusutkan card; `:fullscreen` dikecualikan
  dari max-height. Terverifikasi VM: `npm run build` (tsc + vite) bersih,
  `node --check` backend OK. ⚠️ **Verifikasi kelancaran stream + layout WAJIB di laptop Rama.** |
| 71 | Gunet | **7 PERBAIKAN — JANGAN PUSH** (workflow mengikat: build → lapor Rama → push bila setuju).
  Laporan Rama 16 Okt 2026 09:33 WIB (8 screenshot): (1) **Layout:** slider confidence +
  indikator deteksi PINDAH ke card baru "Deteksi kendaraan" di KANAN video
  (`DetectionPanel.tsx`; `useDetection` diangkat ke App; responsif ≤1100px menumpuk);
  card video bersih (hanya video + DVR bar + kontrol play). (2) **Tooltip delay DVR bar
  DIHAPUS TOTAL** (`title` pada bar/chip/angka — bukan disembunyikan).
  (3) **DVR bar DIPERPANJANG** hampir selebar video (dulu 280px).
  (4) **Dataset seed:** 2 crop kiriman Rama → `dashboard/public/dataset/`
  (`motor-1.png` 64×117, `mobil-1.png` 126×92) + `dataset.json` + `docs/dataset.md`
  (JUJUR: 1 sampel/kelas = seed referensi visual/QA, BUKAN training set;
  konvensi `motor-2.png`, `mobil-2.png`, dst; folder dataset dikecualikan dari
  ignore — disetujui manajer). (5) **Strip kuning delay DIHAPUS** — info
  "tertinggal ±N dtk" pindah ke panel Log koneksi (baris ringkasan `.log-delay`).
  (6) **Buffering — AKAR DITEMUKAN (bukti kode):** `liveSyncDuration: 5` →
  hls.js menargetkan posisi TEPAT 5 dtk di belakang live edge (latency-controller:
  targetLatency = liveSyncDuration); cushion 5 dtk < ekor fetch 1 segmen lambat
  (`fragLoadingMaxRetry: 4` × `fragLoadingRetryDelay: 2000` = 8 dtk+) → tiap
  jitter = event `waiting` = overlay "Buffering…" = "dashboard ngelag padahal situs
  Bekasi lancar" (situs Bekasi pakai cushion puluhan detik). Perbaikan:
  `liveSyncDuration: 45`, `maxBufferLength: 120`, `maxMaxBufferLength: 600`,
  `backBufferLength: 90`, `DVR_SAFE_BEHIND_SEC` 25→45 (selaras cushion),
  `liveMaxLatencyDuration: Infinity` + `maxLiveSyncPlaybackRate: 1` tetap;
  **penjaga prebuffer internal**: gap (bufEnd−pos) < 8 dtk → `video.pause()`
  agar hls.js mengisi buffer sampai ≥30 dtk lalu `play()` — TANPA overlay
  spinner (flag `prebuffering` di snapshot; chip tak tampil "DIJEDA");
  timeout 25 dtk → jalur buffering normal. (7) **Angka durasi:**
  denominator = LIFETIME sejak tab dibuka ("00:46 / 12:03"); posisi tetap
  posisi playback dalam jendela DVR. Terverifikasi VM: `npx tsc -b --force`
  0 error + `npm run build` sukses. ⚠️ **Stream runtime + 7 poin WAJIB
  verifikasi Rama di laptop (checklist §7).** |

Berikutnya (sesuai urutan Meeting #4): Rama pilih hasil benchmark model i5 →
pencabutan larangan detection → fase deteksi (arsitektur ulang + audit Cipher fokus model & UU PDP).
