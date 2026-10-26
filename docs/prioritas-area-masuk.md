# Prioritas area masuk — 26 Oktober 2026

Versi ini membatasi deteksi ke ruas menuju atas gambar / masuk Bekasi, sambil
tetap menerima kendaraan baru yang diam atau belum diketahui arahnya.
Ini memperbarui perilaku semua-arah pada `deteksi-awal-frame.md`.

## Perubahan

- Crop dekat kanan menjadi inferensi pertama dan setiap giliran genap, dari
  sebelumnya satu kali dalam enam inferensi. Crop tersebut mencakup batas kanan
  dan bawah asli gambar; kendaraan setengah badan tidak ditolak pada batas itu.
  Giliran ganjil bergantian jalan atas, overview, lalu jalan dekat kiri.
- Area tujuan menggunakan posisi kontak kendaraan dengan jalan, dibandingkan
  terhadap kurva median yang dinormalisasi di `targetRoad.ts`. Filter diterapkan
  sebelum ByteTrack, saat menerima acuan gerak dan saat mempertahankan track.
  Ini menyaring kendaraan seberang median sejak pertama terlihat tanpa harus
  menahan kendaraan baru di ruas tujuan sampai bergerak.
- Kendaraan baru dikerjakan lebih dulu. Replay aktif tidak lagi dibatalkan
  setiap hasil YOLO berikutnya datang: satu replay aktif dan satu hasil terbaru
  yang menunggu. Reset/resolusi berubah membuang keduanya.
- Replay memproses hingga delapan langkah atau anggaran 4 ms per giliran,
  lalu menyerahkan thread untuk frame gerak. Satu langkah optical flow sendiri
  masih bisa melebihi anggaran tersebut. Sebelumnya satu timer per langkah
  menambahkan biaya penjadwalan berkali-kali untuk setiap kendaraan baru.
- Track pada ruas tujuan dengan gerak piksel turun terkonfirmasi disembunyikan.
  Hitungan tetap mensyaratkan gerak piksel ke atas, satu kali per identitas.
- Bbox kendaraan yang lahir terpotong tepi frame mengikuti pertambahan badan
  pada observasi berikutnya. Koreksi ukuran normal yang dibatasi 4,5% tidak
  dipakai selama fase tepi ini, sehingga kotak tidak tetap kecil setelah badan
  mobil terlihat penuh. Koreksi posisi ini tidak menjadi bukti hitungan.
- Warmup membandingkan WebGPU NHWC, WebGPU bawaan/NCHW, dan WASM. Kandidat tercepat
  yang memenuhi kontrak output dipilih. NHWC tidak mengubah bobot atau ukuran
  input model. Graph capture tidak dipakai: model ini memiliki operasi yang
  tidak seluruhnya dijalankan GPU sehingga percobaan ditolak oleh ONNX Runtime.

Kalibrasi ini khusus kamera A. Yani / RS Mitra Keluarga. Perubahan posisi kamera
memerlukan kalibrasi ulang. Frekuensi pemeriksaan area masuk menjadi tiga kali
lebih sering, tetapi laju inferensi YOLO total tetap bergantung perangkat.

## Verifikasi awal

60 tes lolos dan build TypeScript/Vite berhasil. Regresi baru meliputi kendaraan
di posisi mobil putih dekat kanan, objek yang masih terpotong tepi frame,
penolakan ruas seberang sejak observasi pertama, keluaran arah turun, dan
replay yang tetap selesai walaupun hasil YOLO baru terus masuk, serta ukuran bbox
yang membesar dari sebagian badan ke badan penuh dengan identitas tetap sama.

Probe stream aktual: 20,01 detik video, 499 frame decode, 0 dropped frames;
305 pembaruan gerak. Keluaran hanya `atas` dan `unknown`. Empat kelahiran track
model berada di area kanan bawah, termasuk mobil yang bbox-nya masih menyentuh
batas kanan (`x=0,862`, `w=0,138`). Model ke tracking pada pencocokan mobil itu
sekitar 65 ms; itu tidak mencakup menunggu capture dan inferensi model.
Laju inferensi pada probe ini masih 2,23 fps. Angka ini belum menjadi pengukuran
recall atau akurasi hitungan terhadap anotasi, dan bukan jaminan semua kendaraan
blur/terhalang akan dikenali.

Artefak lokal: `output/playwright/entry-priority-report.json`,
`entry-priority-live.png`, dan `entry-priority-probe.js`.

Benchmark terpisah dengan input CCTV dan model yang sama setelah warmup (tiga
pengukuran per kandidat, playback dijeda): WebGPU NHWC rata-rata 277,78 ms,
WebGPU NCHW 357,46 ms, WASM 1512,64 ms. Pada sampel itu NHWC mengurangi waktu
inferensi sekitar 22,3%. Ini benchmark singkat, bukan jaminan FPS saat playback;
suhu perangkat dan beban lain memengaruhi hasil. Lihat
`output/playwright/inference-speed-report.json` dan `inference-capture-report.json`.

Probe build final setelah restart browser: 20,00 detik video, 501 frame decode,
0 dropped frames, 361 pembaruan gerak. Deteksi terukur 2,77 fps (indikator akhir
2,9 fps), rata-rata putaran inferensi 335,25 ms, indikator tracking 21,3 fps.
Keluaran tetap hanya `atas`/`unknown`; enam kelahiran model berada di area masuk
dan 16 identitas visual muncul dengan satu observasi. Pencocokan waktu yang
tidak ambigu mencatat dua mobil area masuk tampil di worker gerak 49/55 ms
setelah hasil model. Waktu ini tidak mencakup capture/inferensi/render layar.
Window ini berbeda dari probe awal, sehingga perbandingan FPS bukan benchmark
terkontrol. Warmup final memilih provider `webgpu` bawaan; pemilihan NHWC tidak
dipaksakan apabila pengukuran startup memilih kandidat lain.

Artefak final: `output/playwright/entry-priority-final-report.json` dan
`entry-priority-final-live.png`. Beberapa kendaraan blur tetap tidak terdeteksi
pada screenshot; optimisasi pipeline ini belum menghapus keterbatasan model.
