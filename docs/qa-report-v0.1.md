# QA Report — GODS EYE v0.1 Dashboard Web

**QA Engineer:** Testarossa · **Assignment:** #54 · **Tanggal:** 2026-10-15 ~11:05 WIB
**Target:** `~/workspace/gods-eye/dashboard/` (React 18 + Vite 6 + TS + hls.js 1.6.2, frontend-only)
**Acuan:** `docs/arsitektur.md` (Sentot, #49), `docs/mockup-dashboard.html` varian 1 (Prapto, #50 — pilihan Rama), instruksi panel "Log koneksi" (Rama, 15 Okt 2026)
**Audit keamanan:** Cipher #53 — LULUS tanpa temuan kritis (prasyarat QA terpenuhi)

## Verdict: LULUS DENGAN CATATAN

Catatan: **"stream tampil (status LIVE)" WAJIB diverifikasi ulang di laptop Rama** — bukan fail.
Alasan jujur: (1) server CCTV `eofficev2.bekasikota.go.id` memblokir IP data center/VM sehingga `.m3u8` tidak terjangkau dari VM ini; (2) Chromium di VM ini (v152) memblokir SEMUA navigasi localhost via Local Network Access checks, dan IP LAN VM (198.19.0.2) tidak connectable bahkan dari lokal — sehingga uji browser live tidak dimungkinkan dari VM. Sebagai gantinya runtime diuji via eksekusi bundle produksi nyata di jsdom (0 JS error) + review kode menyeluruh.

## 1. Build — LULUS

- `npm install` + `npm run build` (= `tsc -b && vite build`) → **BERSIH, 0 error**, selesai 5,36 dtk.
- Output: `dist/index.html` (0,59 kB) + `dist/assets/index-DlzrtL3P.css` (9,06 kB) + `dist/assets/index-CffyLipj.js` (759,76 kB).
- Satu warning vite: chunk JS > 500 kB (mayoritas hls.js) — lihat temuan O1 (observasi, bukan bug).

## 2. Fungsional — LULUS (dengan batas uji jujur di bawah)

Diuji dengan mengeksekusi **bundle produksi hasil build** di jsdom + inspeksi DOM. Hasil: **0 JS error**.

| # | Item | Hasil | Bukti |
|---|------|-------|-------|
| F1 | Player load & render | ✅ | `#root` terisi 2 children; `#player`, `.log-panel`, `.cam-bar`, `footer` semua ada, urutan DOM: player → log → cam-bar → footer |
| F2 | Badge status | ✅ | Mesin status tervalidasi end-to-end pada jalur error (satu-satunya jalur yang bisa dieksekusi tanpa MSE/stream): badge `✕ GALAT` (class `st-error`), overlay `Gagal memuat stream`, err-code `HLS tidak didukung browser ini.` Semua 7 label status terdefinisi di `StreamHealthBadge.tsx:26-47` |
| F3 | CameraSelector | ✅ | `disabled=true`, tepat 1 option: `Jl. Jend. A. Yani — RS Mitra Keluarga, Kota Bekasi` (`CameraSelector.tsx:14-24`) |
| F4 | Panel "Log koneksi" | ✅ | Ada, **di bawah player full-width** (bukan samping). Terisi **event nyata engine** (bukan simulasi): `15/10 11:00:39 INFO Memuat manifest HLS kamera "Jl_Jend_A_Yani_RS_Mitra_Keluarga_Kota_Bekasi"…` dan `15/10 11:00:39 GALAT Gagal memuat stream: HLS tidak didukung browser ini.` Format timestamp `DD/MM HH:MM:SS` WIB ✅, level INFO/OK/PERINGATAN/GALAT ✅, counter `2 event` ✅, tombol `Bersihkan` (hanya sembunyikan tampilan) ✅ |
| F5 | Badge klik → popover metrik | ✅ | Popover `Metrik sesi berjalan` muncul: Bitrate aktif `–`, Resolusi `–`, FPS (estimasi) `–`, Stall `0×`, Reconnect `0×`, Uptime sesi `00:00:12` + catatan "tanpa backend…" |
| F6 | Jam WIB header & OSD | ✅ | Header: `GODS EYE v0.1 localhost Kamis, 15 Okt 2026 WIB 11:00:50`; OSD: `A.YANI–RS MITRA KELUARGA · 11:00:50`. Akurat vs jam sistem VM (UTC 04:01:21 = WIB 11:01:21, Thursday) — aritmetika WIB manual di `log.ts:33-51` benar |
| F7 | Tombol retry | ✅ (kode) | Overlay error/gagal & offline me-render tombol `Muat ulang` / `Coba sambungkan lagi` → `StreamHealth.retry()` (`StreamPlayer.tsx:127-145`) |
| F8 | Auto-reconnect backoff | ✅ (review kode) | `BACKOFF_MS = [1,2,5,15,30] dtk` + watchdog 20 dtk + guard anti-tumpuk `beginReconnect` + pemeriksaan latar 60 dtk saat offline (`streamHealth.ts:330-420`). **Tidak tereksekusi di VM** (butuh stream nyata) — tercakup verifikasi laptop |

**Jalur yang TIDAK bisa diuji di VM (tandai untuk laptop Rama):** status LIVE/BUFFERING/DELAY/RECONNECTING aktual terhadap stream CCTV, perubahan kualitas LEVEL_SWITCHED, stall downgrade, FPS estimasi dari `getVideoPlaybackQuality`.

## 3. Visual vs mockup varian 1 — COCOK

Struktur 1:1 dengan `docs/mockup-dashboard.html`: header (brand + pill v0.1 + pill localhost + jam) → player 16:9 (badge kiri-atas, popover metrik, OSD, overlay per-state, delay strip non-blocking, tombol fullscreen ⛶) → cam-bar (select disabled + chips 1080p/HLS/60fps) → footer. Panel `.sim` (khusus mockup) **benar tidak dibangun** ✅. Perbedaan wajar: mockup memakai `<canvas>` placeholder, app memakai `<video>` (fungsional hls.js); panel Log koneksi adalah tambahan instruksi Rama pasca-mockup dan diposisikan persis sesuai permintaan (di bawah player, full-width). Semua class CSS yang dipakai komponen terdefinisi di `styles.css` (audit: 0 class hilang).

## 4. Pagar scope (§5 arsitektur + keputusan Meeting #4) — LULUS

- ❌ Tombol record: **tidak ada** (grep + inspeksi DOM).
- ❌ Face recognition: **tidak ada** (pagar permanen UU PDP dihormati).
- ❌ Deteksi aktif: **tidak ada** — `src/detection/` hanya `types.ts` (kontrak `Detection`/`DetectionFrame`/`Detector`/`DetectionPort`, selaras skema JSON Broto yang dibekukan); `index.ts` hanya re-export types; **tidak satu pun komponen meng-import modul detection**.
- ✅ URL stream hanya di `src/config/cameras.ts` (tidak hardcode di komponen) — kecuali label OSD, lihat temuan M1.

## Temuan bernomor

- **O1 (Observasi):** `dist/assets/index-CffyLipj.js` 759 KB (mayoritas hls.js) memicu warning vite chunk > 500 kB. Untuk app localhost ini tidak masalah. Bila kelak dioptimasi: code-split hls.js via dynamic `import()`.
- **M1 (Minor):** `src/components/StreamPlayer.tsx:105` — label OSD `A.YANI–RS MITRA KELUARGA` hardcoded, tidak diturunkan dari `config/cameras.ts`. v0.1 terkunci 1 kamera → tidak berdampak; wajib dijadikan dinamis saat multi-kamera.
- **M2 (Kosmetik):** `public/` kosong — tidak ada favicon; tab browser memakai ikon default.

Tidak ada temuan mayor/kritis. Tidak ada regresi (v0.1 awal, belum ada versi sebelumnya).

## Batas pengujian (jujur)

1. Stream `.m3u8` tidak terjangkau dari VM (blokir IP data center) → status LIVE/BUFFERING/DELAY aktual belum terlihat.
2. Browser live di VM memblokir navigasi localhost (Chromium 152, Local Network Access) → uji visual dilakukan via eksekusi bundle di jsdom, bukan screenshot browser nyata.
3. Konsekuensi: **checklist verifikasi laptop Rama** (untuk runbook Epthal): buka `npm run dev` → badge `● LIVE` tampil ≤ ~10 dtk; panel Log koneksi terisi event `Terhubung — manifest dimuat (N level kualitas tersedia).`; klik badge → metrik terisi (bitrate/resolusi/FPS angka, bukan `–`); matikan WiFi sesaat → badge `◌ BUFFERING` lalu `↻ MENYAMBUNG ULANG` + log backoff; pastikan tetap: tanpa tombol record, tanpa panel deteksi.

## Rekomendasi

Teruskan ke **Epthal (#55)**: runbook + push ke repo `gods_eye` (repo sudah dibuat Rama, kosong — BLOKER REPO CLEAR). Sertakan checklist verifikasi laptop di atas di runbook.
