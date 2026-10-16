# Dataset Kendaraan GODS EYE — Seed Awal

**Keputusan Rama (final):** 2026-10-16 — Rama mengirim 2 crop screenshot CCTV
sebagai dataset awal untuk memperkuat akurasi deteksi. Gunet melaksanakan
via Assignment #71.

## Isi saat ini (seed v1)

| File | Kelas | Ukuran | Sumber |
|---|---|---|---|
| `dashboard/public/dataset/motor-1.png` | motor | 64×117 px, 12 KB | kirim Rama 2026-10-16 |
| `dashboard/public/dataset/mobil-1.png` | mobil | 126×92 px, 22 KB | kirim Rama 2026-10-16 |

Manifest mesin: `dashboard/public/dataset/dataset.json`
(kelas, dimensi, sumber, tanggal, catatan, konvensi penamaan).

## Batasan yang JUJUR (jangan dilebih-lebihkan)

- **1 sampel per kelas = SEED, bukan training set.** Satu gambar per kelas
  TIDAK cukup untuk training/fine-tuning model deteksi apa pun (YOLO26n
  maupun alternatifnya). Klaim "dataset untuk melatih model" dengan 2
  gambar adalah salah dan menyesatkan.
- **Kegunaan nyata saat ini:**
  1. *Anchor referensi visual* — contoh ground-truth "seperti inilah motor/
     mobil di kamera ini" untuk kalibrasi mata saat QA manual;
  2. *Bahan uji QA* — uji threshold confidence & sanity check detektor
     terhadap crop yang diketahui isinya (uji: apakah model mendeteksi
     "motor" pada `motor-1.png` di ambang confidence sekian?).
- **Syarat sebelum dipakai untuk training beneran:** puluhan–ratusan sampel
  per kelas, variasi sudut/pencahayaan/malam-hari, anotasi bounding box
  (format YOLO txt/COCO), split train/val, dan evaluasi metrik (mAP).
  Itu pekerjaan terpisah — belum dimulai.

## Konvensi penambahan sampel (berlaku ke depan)

- Nama file: `<kelas>-<nomor-urut>.png` — contoh: `motor-2.png`,
  `mobil-2.png`, `mobil-3.png`. Nomor urut mulai dari 1, tanpa nol di depan.
- Kelas baru (mis. `truk`, `bus`): tambah entri di `dataset.json` bagian
  `classes`, lalu ikuti pola nama yang sama.
- Setiap penambahan: update `dataset.json` (entri `samples` + `version`
  naik) dan tabel di file ini.
- Bobot model hasil training (`.onnx`/`.pt`/`.bin`) **TIDAK BOLEH**
  di-commit — rujukan: `.gitignore` + `docs/arsitektur.md` §5 butir 3.
  File PNG seed ini boleh di-commit (kecil, bukan bobot model) —
  `dashboard/public/dataset/` sudah diverifikasi tidak ter-ignore
  (persetujuan manajer, #71).

## Kelola Dataset via dashboard (#72, 16 Okt 2026 — FINAL: DATABASE)

**Keputusan Rama (final, 16 Okt 2026 ~10:18 WIB):** gambar dataset disimpan
di **database SQLite** (`backend/data/dataset.db`, via `node:sqlite` bawaan
Node — #73), BUKAN file. Pendekatan file-based awal (`backend/dataset.js` +
`dashboard/public/dataset/uploads/`) DIBATALKAN dan dihapus dari repo.

**Syarat versi Node (#73):** backend WAJIB jalan di **Node ≥ 22.5**
(`node:sqlite` adalah modul bawaan — tidak ada di Node 18/20).
`backend/package.json` → `"engines": {"node": ">=22.5"}`.
Laptop Rama: Node v24.15.0 ✓ (memenuhi syarat; `npm install` tanpa compile).

Panel **"Kelola Dataset"** di dashboard (kolom kanan, bawah card
"Deteksi kendaraan") — cara resmi menambah sampel tanpa edit file manual:

1. **Upload:** tombol "Upload gambar" → pilih banyak file (`accept="image/*"`).
2. **Paste:** klik area paste lalu `Ctrl+V` (screenshot langsung dari clipboard;
   juga mendukung drag-and-drop file ke area yang sama).
3. **Label:** pilih `mobil`/`motor` dulu (default `mobil`) — berlaku untuk
   gambar berikutnya yang diupload/dipaste.
4. **Hapus:** tombol "Hapus" di tiap baris daftar collapsible (konfirmasi dulu) —
   menghapus baris dari database. Sampel **seed** tampil tapi TIDAK bisa dihapus
   dari panel maupun API (backend menolak dengan `403`).
5. **Daftar (#74):** thumbnail DIHAPUS — daftar item = collapsible default-tertutup
   (baris kompak: id, label, ukuran, tanggal, tombol Hapus); upload/paste hanya
   memunculkan toast singkat, tidak me-render daftar.

**Validasi (frontend + backend):** hanya png/jpg/webp, maks 5 MB per file,
duplikat ditolak (cek hash SHA-256 isi file → `409`).

**Arsitektur:**

| Lapisan | File | Peran |
|---|---|---|
| DB engine | `node:sqlite` (bawaan Node ≥22.5, #73) | NOL native dependency, NOL compile — `npm install` selalu sukses. Menggantikan `better-sqlite3` (#72) yang TERBUKTI GAGAL di laptop Rama: v13.0.3 tidak punya prebuilt binary untuk ABI Node 24 → fallback node-gyp rebuild → gagal (tidak ada Visual Studio). API sinkron → kode sederhana. |
| Modul DB | `backend/lib/dataset-db.js` | Skema `dataset_images(id, label, mime, data, sha256 UNIQUE, source, created_at)`; `openDatasetDb`, `seedIfEmpty`, `addImage` (lempar `DUPLICATE`), `listImages` (metadata TANPA blob), `getImage`, `deleteImage`. |
| Endpoint | `backend/server.js` | Lihat tabel API di bawah. DB dibuat otomatis di `backend/data/dataset.db` (**di-gitignore** — jangan di-commit). |
| Modul frontend | `dashboard/src/lib/dataset.ts` | **Satu-satunya** jalur akses dataset: `listDataset()`, `getDatasetImageUrl(id)` (fetch blob → objectURL, cache + revoke), `uploadDatasetImage(file\|{dataUrl}, label, source)`, `deleteDatasetImage(id)`. |
| UI | `dashboard/src/components/DatasetPanel.tsx` | Card kolom kanan (#74: tanpa thumbnail — ringkasan kompak + toast + daftar collapsible). |

**API backend:**

| Method | Path | Body | Hasil |
|---|---|---|---|
| `GET` | `/api/dataset` | — | `{ok, items, counts}` — metadata TANPA blob |
| `POST` | `/api/dataset` | `{label, source, dataUrl}` (`source`: `upload`/`paste`) | `201 {ok, id}` |
| `GET` | `/api/dataset/:id/image` | — | biner gambar (`Content-Type` asli) |
| `DELETE` | `/api/dataset/:id` | — | `{ok, removed}` (`403` untuk seed, `404` bila tak ada) |
| `GET` | `/api/dataset/export` | — | File `.zip` format YOLO (`images/train\|val/`, `labels/train\|val/`, `dataset.yaml`) — untuk training (#74). Label = pseudo-box full-frame (bootstrap; batas jujur di `docs/training.md`). Split train/val 80/20 deterministik. |

**Seed-on-first-run:** saat backend pertama kali jalan dan tabel kosong,
`motor-1.png` & `mobil-1.png` diimpor otomatis dari `dashboard/public/dataset/`
(dicari juga di `dist/dataset/` untuk production build) sebagai
`source='seed'`. Gagal baca = lewati diam-diam (seed bisa ditambah manual).

**PENTING — file biner seed (pelajaran #71):** 2 PNG seed tetap berupa file
di `dashboard/public/dataset/` dan di-track git, TETAPI konektor GitHub
`push_files` TEXT-ONLY — file PNG yang dipush via konektor TERBUKTI KORUP.
Prosedur commit seed dari laptop Rama:

1. `git pull` → pastikan `dashboard/public/dataset/motor-1.png` &
   `mobil-1.png` ada.
2. `git add dashboard/public/dataset/motor-1.png dashboard/public/dataset/mobil-1.png`
3. `git commit -m "dataset: seed motor-1 + mobil-1"` → `git push`
   dari terminal laptop (bukan via konektor).

Jangan pernah push file biner via konektor — selalu dari laptop.
(Isi database `dataset.db` TIDAK di-commit — dibuat ulang otomatis + seed
saat backend pertama jalan.)

## Training dari dataset (#74, 16 Okt 2026 — pipeline v1 ADA)

Rama menanyakan (15 Okt 2026, riset #48): "apakah 1 screenshot crop per
kelas kendaraan dari CCTV bisa membantu akurasi?" — jawaban jujur: crop
tersebut kini tersimpan sebagai seed di sini, DAN pipeline training v1
sudah dibangun (#74):

1. **Export:** `GET /api/dataset/export` → ZIP format YOLO
   (`images/train|val/`, `labels/train|val/`, `dataset.yaml`; writer
   pure-Node `backend/lib/zip.js`, tanpa dependency baru).
2. **Train:** `tools/train_yolo.py --data dataset.zip --epochs 50`
   (Ultralytics; `--help`/`--dry-run` jalan tanpa torch).
3. **Pasang:** salin `best.onnx` ke `dashboard/public/models/` →
   `VITE_DETECTOR_MODEL=models/<nama>.onnx npm run build`.

**Batas bootstrap (jujur):** label export = pseudo-box full-frame
(`<classId> 0.5 0.5 1.0 1.0`) karena sampel hanya berlabel image-level.
Untuk akurasi serius: anotasi bbox manual + 50–200+ sampel/kelas.
Rincian lengkap: `docs/training.md`.

## Rencana tindak lanjut (terbuka)

- Kumpulkan 50–200 crop per kelas dari rekaman stream (via panel) —
  syarat training beneran (lihat atas).
- Evaluasi model kandidat terhadap crop sebagai benchmark mini (opsi
  riset #48 (b) — belum diputuskan Rama).
