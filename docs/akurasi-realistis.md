# Akurasi Deteksi: Evaluasi Jujur (#68)

**15 Okt 2026, Gunet — jawaban atas harapan Rama "seakurat gambar demo YOLO".**

Rama mengirim gambar demo YOLO (bus/car/person, confidence 0,6–0,9) sebagai
referensi. Dokumen ini menjawab JUJUR: apa yang achievable di CCTV malam hari
vs gambar demo, di mana batas realistisnya, dan apa yang benar-benar membantu
(serta apa yang TIDAK akan kami lakukan).

## 1. Gambar demo vs CCTV kita — tidak sebanding

| | Gambar demo YOLO | CCTV Jl. A. Yani (malam) |
|---|---|---|
| Cahaya | Siang, terang merata | Malam, lampu jalan + sorot headlight |
| Resolusi objek | Besar, jelas, dekat | Bervariasi; kendaraan jauh = kecil |
| Noise/blur | Hampir nol | Noise sensor + motion blur + kompresi H.264 |
| Latar | Bersih | Kompleks (pohon, bangunan, kendaraan parkir) |
| Sumber | Foto kurasi (mirip COCO val — data yang dipakai benchmark resmi) | Stream live 1080p terkompresi |

FAKTA (riset #48): klaim resmi YOLO26n **40,9 mAP** diukur di **COCO val —
foto siang hari berkualitas tinggi**. Itu langit-langit model pada data
ideal, BUKAN janji performa di CCTV malam. Tidak ada model object detection
umum yang mempertahankan angka benchmark-nya di kondisi malam + kompresi
streaming. Ini fisika citra, bukan bug implementasi.

## 2. Batas realistis di CCTV malam hari

- **Kendaraan dekat & jelas (≤ 50 m, terlampu):** confidence 0,6–0,9
  SEPERTI DEMO — achievable. Ini mayoritas kendaraan yang melintas.
- **Kendaraan jauh/kecil:** model input 640×640 — mobil pada jarak ±150 m
  hanya ~20–30 piksel di input model. Di bawah ambang wajar model COCO
  mana pun: confidence rendah atau miss. BUKAN kegagalan — keterbatasan
  resolusi input. Solusi legitimate: lihat §4.
- **Headlight glare / hujan / kabut:** degradasi signifikan, semua model
  umum mengalaminya. Tidak ada jalan pintas software.
- **Person:** model COCO bisa deteksi orang (class 0), tapi GODS EYE
  SENGAJA hanya mengaktifkan motor & mobil (keputusan #62, koreksi Rama).
  Deteksi orang TIDAK dinyalakan — pagar scope (UU PDP, face recognition
  out of scope permanen).

## 3. Temuan diagnosis #68: sebagian besar "miss" BUKAN salah model

Analisis akar masalah "box tertinggal / kendaraan tak ter-box":

1. **fps deteksi 0,1–4,3 vs video 25–30 fps** — kendaraan lewat DI ANTARA
   frame deteksi. Ini bukan model "tidak akurat"; ini model "tidak sempat
   melihat". Perbaikan #68 (lihat bawah) menaikkan fps riil DAN
   mengekstrapolasi posisi antar-frame — "akurasi yang dirasakan" naik
   drastis tanpa menyentuh model sama sekali.
2. **Akar 0,1 fps DITEMUKAN & DIPERBAIKI (#68):** worker membuang frame
   DIAM-DIAM saat sibuk (`frame.close()` tanpa respons) → promise main
   thread menggantung sampai timeout 8 dtk → TIAP timeout dihitung sebagai
   "hasil" → fps palsu 0,1 + overlay dibersihkan tiap 8 dtk. Kini worker
   membalas `"dropped"` eksplisit; timeout bukan lagi hasil rutin.
3. **Asosiasi track BUKAN masalah** — centroid tracker #62/#67 bekerja;
   yang hilang adalah langkah "predict" (ekstrapolasi gerak). Maka
   ByteTrack/DeepSORT (izin Rama: boleh pakai) TIDAK dipakai — diagnosis
   menunjukkan library eksternal tidak menyasar akar masalah (mereka
   menyelesaikan re-ID antar-oklusi, bukan fps rendah). Diimplementasikan
   ±30 baris velocity-EMA + `predictBbox` di `tracker.ts`, tanpa dependensi
   baru, tetap 100% offline.

## 4. Yang BENAR-BENAR membantu (urutan dampak)

1. **#68 — fps + prediksi gerak (SELESAI, belum di-push):** rantai execution
   provider `webgl → wasm` (GPU laptop dipakai bila ada), capture 960×540
   (transfer 8MB → 2MB/frame), `inferMs` + provider tampil live di chip UI
   (pengukuran, bukan asumsi), overlay jalan di frame-rate video (rAF 60fps)
   dengan ekstrapolasi velocity. Ekspektasi: fps riil naik dari 0,1–4,3 ke
   kisaran 5–15 (tergantung GPU laptop Rama — TERUKUR di chip UI).
2. **Slider threshold + default 0,4 (#68):** BUKTI dari screenshot Rama —
   kendaraan JELAS di CCTV malam terdeteksi di skor 51–54% (nyaris gugur di
   default lama 0,5!). "Akurasi <10%" yang dikeluhkan sebagian besar adalah
   kendaraan NYATA yang skornya di bawah 0,5 — bukan model gagal total.
   Default kini 0,4; slider 0,1–0,9 tetap live bila perlu.
3. **Fine-tuning LEGITIMATE (fase berikut, bila Rama mau):** latih ulang
   YOLO26n dengan **RATUSAN frame berlabel dari KAMERA INI SENDIRI**
   (malam hari, kondisi nyata) — baru di situ akurasi malam naik signifikan.
   Ini pekerjaan anotasi data, bukan 1 gambar.
4. **Jalur model (slot tersedia):** fallback PP-PicoDet-S di `vehicleConfig`
   (format ONNX belum terverifikasi — tidak dipaksakan), atau varian YOLO
   lebih besar bila GPU tersedia.

## 5. Yang TIDAK akan dilakukan: fine-tuning 1 gambar — LARANGAN TEGAS

Rama sempat bertanya apakah 1 screenshot crop per kelas bisa membantu.
Jawaban manajer (sudah 2× dijelaskan ke Rama) dan pendirian teknis kami:
**TIDAK.** Satu gambar = overfitting total — model menghafal 1 gambar itu
dan performanya di SEMUA kondisi lain justru RUSAK. Ini bukan opini; ini
fakta pembelajaran mesin yang mapan. Tidak ada pengecualian, tidak ada
"versi ringannya". Bila suatu saat fine-tuning dilakukan, syaratnya dataset
ratusan gambar beragam (§4 butir 3) — atau tidak sama sekali.

## 6. Cara Rama menilai sendiri (jujur & terukur)

- Chip kanan-bawah video kini menampilkan
  `Deteksi: N fps · Mms · webgl|wasm` — N = fps riil, M = biaya/putaran,
  provider = bukti GPU dipakai atau tidak.
- Uji visual 2 menit: amati 1 mobil lewat — box harus menempel mulus
  (tidak tertinggal jauh), sedikit redup saat prediksi (jujur: bukan
  deteksi segar), hilang ≤ ~1 dtk setelah kendaraan pergi.
- Ekspektasi yang SEHAT: kendaraan dekat & jelas ter-box 0,6–0,9 seperti
  demo; kendaraan sangat jauh/kecil kadang miss — itu batas resolusi
  input 640, bukan bug untuk diperbaiki dengan tuning buta.

---

*Rujukan: riset #48 (`workspace/riset-object-detection/riset-yolo-vs-kandidat.md`),
arsitektur.md §2, assignment #68 (15 Okt 2026 ~20:40 WIB).*
