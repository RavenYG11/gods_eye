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

## Rencana tindak lanjut (terbuka)

Rama menanyakan (15 Okt 2026, riset #48): "apakah 1 screenshot crop per
kelas kendaraan dari CCTV bisa membantu akurasi?" — jawaban jujur: crop
tersebut kini tersimpan sebagai seed di sini. Untuk benar-benar menaikkan
akurasi, opsi yang realistis: (a) kumpulkan 50–200 crop per kelas dari
rekaman stream; (b) evaluasi model kandidat terhadap crop tersebut sebagai
benchmark mini; (c) bila perlu, fine-tune dengan anotasi. Belum ada
keputusan Rama untuk langkah (a)–(c).
