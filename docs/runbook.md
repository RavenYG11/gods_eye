# RUNBOOK — GODS EYE v0.1 (Dashboard CCTV Kota Bekasi)

**Pemilik runbook:** Epthal (DevOps Engineer), Assignment #55 · **Tanggal:** 15 Okt 2026
**Scope:** operasional v0.1 — dashboard web stream viewer **1 kamera** CCTV Bekasi (HLS 1080p).
100% frontend, **tanpa backend**. Build QA: Testarossa #54 — **LULUS DENGAN CATATAN** (`docs/qa-report-v0.1.md`).

> Scope v0.1 **DIKUNCI** (Meeting #4 D1–D6): object detection DILARANG dibangun sampai Rama mencabut
> larangan + hasil benchmark i5 keluar. Tanpa rekaman. Face recognition OUT OF SCOPE permanen (UU PDP).

---

## 1. Arsitektur singkat

```
MODE DEV (npm run dev — cara jalan yang disarankan v0.1):
Browser (laptop Rama)
 └─ index.html + assets JS/CSS (dari Vite dev-server :5173)
      └─ hls.js → GET /cctv/backupcctv/m3/<kamera>.m3u8 (same-origin)
           └─ Vite proxy → HTTPS → https://eofficev2.bekasikota.go.id/backupcctv/m3/<kamera>.m3u8
               (rewrite: hapus prefix /cctv; changeOrigin: true)
           → BEBAS CORS (bug #58, fix Gunet 2026-10-15)

MODE PROD (npm run build + XAMPP — lihat batasan §6):
Browser
 └─ index.html + assets JS/CSS (statis)
      └─ hls.js → HTTPS GET langsung → https://eofficev2.bekasikota.go.id/…
           → KENA CORS (lihat §6)
```

- Tidak ada server aplikasi, tidak ada database, tidak ada API key/secret.
- Satu-satunya dependensi runtime eksternal = URL stream CCTV di `dashboard/src/config/cameras.ts`
  (tidak ada URL hardcode di komponen lain). URL EFEKTIF yang dipakai player dihitung
  fungsi `getStreamUrl()` di file itu: **DEV** → path proksi `/cctv/*`,
  **PROD** → URL absolut upstream.
- `vite.config.ts` memakai `base: './'` → hasil build bisa disajikan dari subfolder mana pun,
  dan `server.proxy["/cctv"]` → `https://eofficev2.bekasikota.go.id` (hanya aktif saat `npm run dev`).

---

## 2. Prasyarat

| Kebutuhan | Minimal |
|---|---|
| Node.js + npm | Node 18+ (cek: `node -v`, `npm -v`) |
| Browser | Chrome / Edge terbaru (mendukung MSE + hls.js) |
| Git | untuk clone repo |
| XAMPP (opsional) | Apache untuk opsi serve `http://localhost/gods-eye/` |
| Jaringan rumah | **wajib dari IP rumah** — server CCTV memblokir IP data center/VM (terbukti di riset) |

---

## 3. Clone & install

```bash
git clone https://github.com/RavenYG11/gods_eye.git
cd gods_eye/dashboard
npm install
```

> `package-lock.json` ikut di-commit → versi dependensi deterministik
> (React 18, Vite 6, TypeScript 5.6, hls.js 1.6.2).

---

## 4. Mode pengembangan (localhost)

```bash
cd dashboard
npm run dev
# → http://localhost:5173
```

**Proksi dev anti-CORS (fix bug #58, Gunet 2026-10-15).** Verifikasi Rama 2026-10-15 13:56 WIB:
URL `.m3u8` dibuka langsung di tab baru → video LIVE, tetapi request yang sama via hls.js
dari origin `http://localhost:5173` GAGAL (Network tab: red X, 0 byte, tanpa status code).
Pola klasik **CORS-block**: navigasi langsung tidak kena CORS, XHR browser diblokir karena
server tidak mengirim `Access-Control-Allow-Origin`.

Maka saat DEV, app TIDAK request langsung ke server CCTV. `getStreamUrl()`
(`src/config/cameras.ts`) memakai `import.meta.env.DEV` dan menghasilkan path proksi:

```
/cctv/backupcctv/m3/Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi.m3u8
```

Vite dev-server meneruskannya ke `https://eofficev2.bekasikota.go.id` (lihat
`server.proxy` di `vite.config.ts`, `changeOrigin: true`, rewrite hapus prefix `/cctv`).
Request dari browser = same-origin → tidak kena CORS. Dev-server jalan di laptop Rama
(jaringan rumah, IP tidak diblokir WAF) → proksi meneruskan dengan lancar.

**Batasan yang belum bisa dicek dari VM (IP diblokir WAF) — waspada segmen:**
jika isi `.m3u8` mencantumkan URL segmen **absolut** (bukan relatif), hls.js akan request
segmen langsung ke server CCTV → kena CORS lagi meskipun playlist lewat proksi.
Bila badge LIVE muncul lalu stream macet/gagal dengan error CORS di console, ini
penyebabnya — laporkan ke manager, JANGAN mengarang solusi sendiri.
Verifikasi URL segmen = buka hasil proksi di laptop Rama dan periksa isi playlist.

Ganti kamera / URL stream: edit **hanya** `src/config/cameras.ts`, simpan — Vite hot-reload otomatis.

---

## 5. Build produksi

```bash
cd dashboard
npm run build        # = tsc -b && vite build
```

Hasil: `dashboard/dist/` berisi `index.html` + `assets/*.js` + `assets/*.css` (statis, path relatif `./assets/…`).

**Catatan build (QA #54, temuan O1):** Vite memberi warning `chunk > 500 kB`
(`index-CffyLipj.js` ±759 KB — mayoritas hls.js). Ini **bukan bug**; untuk app localhost
tidak berdampak. Optimasi (code-split hls.js via dynamic `import()`) dicatat sebagai backlog.

**Jangan commit `dist/` dan `node_modules/`** — `.gitignore` di root repo sudah menutup:
`node_modules/`, `dashboard/dist/`, `*.onnx`, `*.pt`, `*.bin`, `*.pkl`, `.DS_Store`.

---

## 6. Serve via XAMPP — `http://localhost/gods-eye/`

> ⚠️ **BATASAN PRODUKSI v0.1 (bug CORS #58).** Hasil `npm run build` memakai URL stream
> **absolut** langsung ke `https://eofficev2.bekasikota.go.id` (proksi `/cctv` hanya ada di
> dev-server Vite, tidak ikut terbawa ke `dist/`). Karena server tidak mengirim
> `Access-Control-Allow-Origin`, request hls.js dari `http://localhost/gods-eye/` akan
> diblokir browser (CORS) — gejala sama seperti sebelum fix: overlay "Memuat stream…" /
> "Gagal memuat stream", Network tab red X 0 byte. Tanpa `mod_proxy` Apache (di luar scope
> v0.1), XAMPP tidak bisa meniru proksi dev. **Untuk v0.1, cara jalan yang didukung =
> `npm run dev`** (§4). Opsi XAMPP di bawah ini didokumentasikan apa adanya untuk kelak
> setelah strategi CORS produksi diputuskan.

1. Jalankan `npm run build` (lihat §5).
2. Salin **isi** `dashboard/dist/` ke `C:\xampp\htdocs\gods-eye\`
   (folder `gods-eye` dibuat bila belum ada; yang disalin isinya: `index.html` + folder `assets/`).
3. Pastikan Apache XAMPP berjalan (XAMPP Control Panel → Start Apache).
4. Buka **http://localhost/gods-eye/** di Chrome/Edge.

Alternatif tanpa XAMPP: `npm run preview` (serve `dist/` di port 4173 —
catatan: `preview` juga memakai URL absolut, sehingga kena batasan CORS yang sama).

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

Catatan: `media-src`/`connect-src` mencakup `eofficev2.bekasikota.go.id` karena segmen HLS
diambil langsung dari sana oleh browser (server sudah mengirim `CORS: *`).

---

## 7. Checklist verifikasi di laptop Rama (WAJIB)

Stream **tidak terjangkau dari VM/server** (WAF memblokir IP data center) — QA #54
hanya bisa memverifikasi lewat bundle nyata tanpa stream. Verifikasi berikut
**wajib dijalankan dari laptop Rama (jaringan rumah)**:

- [ ] `npm run dev` → buka `http://localhost:5173` — halaman tampil tanpa error console.
- [ ] Badge status berubah menjadi **● LIVE** dalam ±10 detik.
- [ ] Panel **"Log koneksi"** (di bawah player, full-width) terisi event nyata, mis.
      `OK Terhubung — manifest dimuat (N level kualitas tersedia).`
- [ ] Klik badge → popover "Metrik sesi berjalan": bitrate, resolusi, FPS **terisi angka** (bukan `–`).
- [ ] Matikan WiFi ±10 detik → badge **◌ BUFFERING** lalu **↻ MENYAMBUNG ULANG**,
      log mencatat urutan backoff (1s → 2s → 5s → 15s → 30s); nyalakan WiFi → kembali **LIVE**.
- [ ] Pagar scope tetap: **tanpa tombol record**, tanpa panel deteksi, tanpa face recognition.
- [ ] Ulangi poin di atas untuk `http://localhost/gods-eye/` (XAMPP) bila memakai opsi §6.

**Preflight cepat (opsional, dari laptop):** pastikan playlist terjangkau sebelum buka app:

```powershell
curl -s -o NUL -w "%{http_code}`n" https://eofficev2.bekasikota.go.id/backupcctv/m3/Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi.m3u8
# Harus keluar: 200
```

---

## 8. Troubleshooting

| Gejala | Penyebab umum | Tindakan |
|---|---|---|
| `npm run dev` gagal: `EADDRINUSE` / port 5173 dipakai | Port bentrok | Matikan proses Vite lain, atau `npm run dev -- --port 5174` |
| Overlay `Memuat stream…` / request `.m3u8` red X, 0 byte, tanpa status | **CORS-block (bug #58)** — server tidak mengirim `Access-Control-Allow-Origin`; XHR hls.js dari origin app diblokir browser, padahal URL dibuka langsung di tab → LIVE | Cara jalan v0.1 = `npm run dev` (§4, proksi `/cctv`). Jangan paksakan via XAMPP/build tanpa strategi CORS produksi |
| Playlist termuat (badge LIVE sebentar) lalu gagal / error CORS di console saat segmen diminta | URL segmen di `.m3u8` **absolut** (bukan relatif) → hls.js request segmen langsung ke server → kena CORS lagi | Belum terverifikasi dari VM (WAF blokir IP). Periksa isi playlist dari laptop Rama; laporkan ke manager, jangan mengarang solusi |
| Halaman putih / `Failed to fetch` ke `.m3u8` | WAF server memblokir IP jaringan ini | Uji dari jaringan lain (tethering HP); jalankan preflight §7 |
| Overlay `Gagal memuat stream` + log `GALAT` | Manifest tidak terjangkau / playlist tidak valid | Cek preflight §7 → harus `200` + isi diawali `#EXTM3U` |
| `HLS tidak didukung browser ini.` | Browser tanpa MSE (atau sangat lawas) | Pakai Chrome/Edge terbaru |
| Badge `◌ BUFFERING` terus-menerus | Bandwidth tidak cukup untuk level 1080p | App otomatis turunkan kualitas (stall > 10 dtk); bila tetap, cek kecepatan internet |
| `CORS` error di console pada mode PROD (XAMPP/preview) | Diharapkan — proksi `/cctv` hanya ada di `npm run dev`; build memakai URL absolut (§6) | Jalankan via `npm run dev` untuk v0.1; strategi CORS produksi diputuskan terpisah |
| `npm install` gagal | Node terlalu lama / cache korup | `node -v` (butuh 18+); `npm cache clean --force` lalu ulangi |
| Aset 404 saat dibuka dari XAMPP subfolder | `base` bukan relatif | Pastikan build dari repo ini (`base: './'` di `vite.config.ts`) — jangan edit manual hasil `dist/` |
| Log koneksi kosong | JS error / bundle gagal load | Buka DevTools → Console; pastikan `dist/` tersalin lengkap (`index.html` + `assets/`) |

**Aturan diagnosis (gaya kerja Epthal): periksa log sebelum menyimpulkan.**
Urutan: panel "Log koneksi" di app → DevTools Console → Network tab (lihat request `.m3u8`/`.ts`) → baru simpulkan.

---

## 9. Backup & rollback

- **Backup kode:** setiap perubahan di-commit & push ke `main` repo `gods_eye`.
- **Backup deploy (XAMPP):** sebelum menimpa `C:\xampp\htdocs\gods-eye\`, salin folder lama ke
  `C:\xampp\htdocs\gods-eye.bak-YYYYMMDD\`.
- **Rollback:** hapus isi `gods-eye\`, salin kembali isi folder `.bak-` terakhir → refresh browser.
- Tidak ada database → tidak ada prosedur backup/restore data.

---

## 10. Monitoring (v0.1)

- **Panel "Log koneksi"** di dashboard = monitor bawaan: event INFO/OK/PERINGATAN/GALAT
  + timestamp WIB + counter event + tombol Bersihkan (hanya menyembunyikan tampilan).
- **Popover badge status** = metrik sesi: bitrate aktif, resolusi, estimasi FPS, stall, reconnect, uptime.
- Belum ada monitoring server (tanpa backend — by design). Bila kelak ada backend,
  runbook ini direvisi.

---

## 11. Struktur repo

```
gods_eye/
├── README.md                 # Ringkasan + cara jalan cepat
├── .gitignore                # node_modules/, dist/, bobot model (*.onnx/*.pt/…)
├── dashboard/                # App (React 18 + Vite + TS + hls.js) — TANPA node_modules/ & dist/
│   ├── src/
│   │   ├── components/       # StreamPlayer, StreamHealthBadge, CameraSelector, ConnectionLog
│   │   ├── config/cameras.ts # SATU-SATUNYA tempat URL stream
│   │   ├── detection/        # KONTRAK SAJA (types) — detection-ready, tanpa model
│   │   └── lib/              # streamHealth (mesin status+backoff), log, useStreamSession
│   ├── index.html
│   ├── package.json / package-lock.json
│   ├── vite.config.ts        # base './'
│   └── tsconfig*.json
└── docs/
    ├── arsitektur.md         # Sentot #49 — arsitektur Opsi C Hybrid
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

Berikutnya (sesuai urutan Meeting #4): Rama pilih hasil benchmark model i5 →
pencabutan larangan detection → fase deteksi (arsitektur ulang + audit Cipher fokus model & UU PDP).
