# Riset deteksi pertama dan motor — 27 Oktober 2026

Tujuan: mempercepat deteksi sejak kendaraan masuk sebagian dari bawah/kanan,
mempertahankan mobil jauh yang sudah bekerja, dan menyelidiki motor yang terlewat.

## Sumber primer dan implikasi

- [SAHI: Slice, Detect, Merge](https://obss.github.io/sahi/guides/sliced-inference/)
  menjelaskan hilangnya detail objek kecil akibat downscale dan keuntungan crop
  tumpang tindih. Menambah tile juga menambah pekerjaan inferensi. Crop dan
  overview yang sudah bekerja dipertahankan, tanpa inferensi serial tambahan.
- [Zone Evaluation, TPAMI](https://arxiv.org/abs/2310.13215) mengukur perbedaan
  performa objek di pusat dan tepi gambar. Ini mendukung evaluasi deteksi tepi
  secara terpisah, tetapi bukan sumber angka threshold aplikasi.
- [ByteTrack](https://arxiv.org/abs/2110.06864) mengasosiasikan observasi lemah
  terhadap track yang sudah ada. Perubahan ini mempertahankan asosiasi itu dan
  menambahkan konfirmasi temporal khusus kandidat motor yang belum punya track.
  Konfirmasi temporal tersebut adalah heuristik aplikasi, bukan klaim algoritme
  ByteTrack asli atau jaminan peningkatan akurasi.
- [ONNX Runtime Web performance diagnosis](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
  menyarankan pengukuran runtime dan perpindahan data. [Node.js binding](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
  juga diuji sebagai eksperimen. Hasil compute terpisah tidak menggantikan
  pengukuran playback lengkap. Graph capture yang ditolak model tidak dipaksakan.

## Penyebab yang ditemukan

1. Inferensi live WebGPU sekitar 300–420 ms, atau 2,2–3,1 hasil/detik. Target
   capture 10 FPS tidak mengubah biaya inferensi. Tracking 16–22 FPS membantu
   kendaraan yang sudah ditemukan, tetapi tidak menemukan kendaraan baru.
2. View bergantian berarti objek baru dapat menunggu view yang mencakupnya,
   lalu menunggu inferensi selesai. Tidak ada antrean frame tambahan, tetapi
   latensi pertama tetap mencakup penantian view dan biaya inferensi.
3. Motor kadang memang mendapat skor terlalu rendah dari model. Pada satu
   frame aktual, motor bergerak memperoleh 0,105 di overview, 0,117 di crop kiri,
   dan 0,127 di crop kanan. Hipotesis orang pada lokasi sama mendapat 0,309.
   Skor motor bisa gugur di parse floor 0,12 atau birth gate 0,25.
4. Kendaraan yang baru tampak sebagian sebelumnya memakai gate interior.
   Pertumbuhan bbox dari potongan badan ke badan penuh juga bisa melampaui
   batas perubahan luas asosiasi dan memutus ID.

## Perubahan akhir

1. Gate observasi pertama di pita 2% batas bawah/kanan asli ruas tujuan:
   mobil 0,24 dan motor 0,18. Interior dan mobil jauh tetap 0,35/0,25.
   Sambungan crop buatan tidak mendapat pelonggaran. Skor tetap asli.
2. Gate kelahiran dibawa ke worker gerak sehingga observasi pertama yang sudah
   sah tidak ditolak lagi oleh ambang interior saat menjadi anchor.
3. Track yang masih terpotong di tepi boleh bertambah hingga 12 kali luas,
   bila bbox baru mencakup >=50% kotak prediksi lama. Gate kelas, jarak dan
   asosiasi biasa tetap berlaku. Interior tetap memiliki batas empat kali luas.
4. Parse khusus motor diturunkan ke 0,10. Satu observasi lemah tidak langsung
   melahirkan kendaraan. Dua observasi kelas motor harus konsisten, bergerak
   ke atas minimal max(2 px, 8% tinggi bbox), berada di ruas tujuan, berselisih
   waktu <=1,2 detik dan memiliki rasio luas 0,5–2. Jarak/lompatan lateral juga
   dibatasi. Kandidat yang sudah cocok ke track tidak dipakai untuk birth lagi.
   Kandidat diam, turun, seberang, orang, satu frame dan kedaluwarsa ditolak.
5. Skor motor >=0,10 dapat menyambung track motor yang sudah terbentuk.
   Mobil tetap memakai floor 0,12. Arah dan hitungan sesi tetap membutuhkan
   pengukuran gerak piksel; konfirmasi model saja tidak mengubah total.
6. Pesan worker `ready` menyertakan waktu dan kegagalan benchmark provider
   browser untuk diagnosis. Tidak ada provider baru yang dipaksakan.

## Eksperimen yang tidak diterapkan

Mengecilkan crop kiri ke 55% tidak membantu sampel: motor parkir turun dari
0,254 ke 0,099 dan motor bergerak tidak membaik. Crop tersebut tidak dipakai.
Tidak ada konversi semua orang menjadi motor atau penggelembungan skor.

Native ONNX CPU dua thread mengukur 146 ms pada benchmark sintetis terpisah,
tetapi jalur HTTP dengan input lossless uint8 NCHW (1,23 MB/frame) justru lebih
lambat saat playback: sekitar 889 ms total, 1,1 FPS pada uji diagnostik paksa.
WebGPU sekitar 355 ms/2,7 FPS pada uji berikutnya. Beban berubah antar-sesi;
ini bukan perbandingan recall pada klip yang sama. Kandidat native beserta
endpoint, dependency dan transport produksinya dibuang dari perubahan akhir.

## Verifikasi dan batasnya

Tes memeriksa gate tepi, penolakan interior/seberang, ID dari badan parsial ke
penuh, dua prediksi motor lemah, serta penolakan kandidat statis/turun/orang/
kedaluwarsa/berubah ukuran ekstrem. Tes pipeline yang lain tetap dijalankan.
`npm test`: 66 tes lulus. `npm run build`: TypeScript dan Vite berhasil.

Uji live pertama 15 detik menghasilkan 374 frame video tanpa dropped frame dan
WebGPU 2,7 FPS. Build akhir diuji lagi 15 detik: 375 frame, nol dropped frame,
WebGPU NHWC 2,23 FPS dengan rata-rata worker 420 ms. Tidak ada birth temporal
lemah baru dalam jendela singkat itu,
jadi uji tersebut membuktikan integrasi/playback, belum peningkatan recall
motor di lapangan. Angka FPS dan inferensi juga belum menunjukkan peningkatan
throughput; perbaikan kode berfokus pada observasi yang sebelumnya ditolak.

Artefak eksperimen lokal ada di `output/playwright/`: `motor-view-research.json`,
`motor-research-*.png`, `native-speed-report.json`, `native-input-report.json`,
`entry-native-check.json`, `entry-auto-check.json` dan screenshot pasangannya.
Artefak ini diabaikan Git. Sampel tersebut bukan dataset beranotasi lengkap.

Belum ada jaminan semua kendaraan setengah badan atau motor blur akan terbaca.
Kasus tanpa prediksi motor yang memadai tetap memerlukan evaluasi model lain
atau fine-tuning pada anotasi CCTV. Threshold/heuristik saja tidak membuktikan
persentase akurasi atau menghilangkan biaya inferensi pada perangkat ini.
