# Analisis dan perombakan GODS EYE — 24 Oktober 2026

## Temuan yang dapat dibuktikan

1. **Lock inferensi lepas oleh panggilan yang di-skip.** Guard `inflight`
   berada di dalam `try`, tetapi `finally` selalu menyetel `inflight=false`.
   Memindahkan set-lock sebelum `createImageBitmap` saja pada versi lama
   tidak menyelesaikan masalah: panggilan interval berikutnya tetap melepas
   lock milik inferensi pertama. Resolver tunggal tanpa request ID kemudian
   dapat dikonsumsi oleh respons frame lain. Gejalanya freeze, hasil hilang,
   timeout, dan FPS yang menyesatkan.
2. **Waktu frame terlambat dibaca.** `video.currentTime` dibaca setelah
   `await createImageBitmap`, sehingga timestamp dapat berbeda dari gambar
   yang sedang dianalisis. Ukuran video juga perlu dibekukan saat capture.
3. **Kalman memakai satu langkah per hasil, tanpa dt aktual.** Inference
   yang berubah dari 100 ms menjadi 500 ms menghasilkan prediksi yang salah.
   Track hilang sudah diprediksi di Kalman, tetapi output masih membawa
   timestamp terakhir terlihat: overlay memprediksi perpindahan itu lagi.
4. **Gate asosiasi terlalu longgar untuk track matang.** Posisi sudah
   diprediksi, tetapi toleransi masih dibuka sebesar seluruh kemungkinan
   jarak tempuh. Kendaraan berdekatan mudah bertukar identitas. Track hilang
   dan prediksi lama juga terlalu lama dirender sebagai kotak kosong di jalan.
5. **Target delay 45 detik tidak sesuai playlist yang diamati.** Fetch
   langsung pada kamera RS Mitra Keluarga menghasilkan 20 segmen × 2 detik,
   yaitu jendela sekitar 40 detik. Target lebih panjang harus di-clamp oleh
   player. Angka 45 detik bukan konfigurasi yang berhasil dibuktikan dari
   situs resmi.
6. **Player sengaja pause saat buffer masih tersisa.** Guard lama memanggil
   `pause()` pada gap <8 detik, lalu menunggu 30 detik. Menyembunyikan spinner
   tetap meninggalkan video yang berhenti. Mengambil `buffered.end(last)`
   juga salah bila ada lubang antara posisi sekarang dan range terakhir.
7. **Delay dihitung dari target HLS, bukan ujung playlist.**
   `hls.liveSyncPosition` sudah dikurangi target latency. Menguranginya lagi
   di guard DVR atau menganggapnya live edge merusak delay dan posisi resume.
8. **Lifecycle React dan worker tidak sepenuhnya bersih.** Koneksi dibuat
   lewat ref, tetapi dihancurkan lewat effect; replay effect StrictMode bisa
   menghancurkan stream tanpa memasangnya kembali. Dispose worker membuang
   resolver tanpa menyelesaikan promise. Respons timeout lama tidak memiliki
   identitas untuk membedakannya dari frame baru.
9. **Pemilihan provider tidak dibuktikan lewat waktu inferensi.** Provider
   yang berhasil dibuat belum tentu berhasil menjalankan model, atau lebih
   cepat. Input/output tensor juga tidak dibebaskan secara konsisten.
10. **Model custom memiliki urutan kelas berbeda.** Export training memakai
    mobil=0/motor=1, sedangkan parser bawaan menganggap car=2/motorcycle=3 COCO.
    Tanpa pemetaan eksplisit, hasil model custom dapat hilang/salah kelas.
11. **Backend memiliki operasi yang bersaing dengan stream.** Proxy tidak
    mempunyai deadline total, batas respons, dan cache request ulang.
    Pembuatan ZIP dan pembacaan seluruh BLOB dilakukan sinkron pada event
    loop HTTP yang sama. Mode Vite memakai implementasi proxy berbeda dan
    tidak meneruskan API dataset ke backend.

## Implementasi baru

### Playback

- Target delay 24 detik, buffer awal 16 detik, recovery buffer 10 detik.
  Buffer minimum menyesuaikan panjang playlist dan jarak ke live edge.
- Video mulai setelah buffer kontinu dan warmup model siap. Kegagalan model
  tidak menutup akses video: status error deteksi melepaskan gate playback.
- Setelah mulai, video tetap 1×. Tidak ada pause proaktif ketika buffer
  menipis, seek berkala, atau catch-up playback rate.
- Rebuffer hanya saat event menunggu data dan buffer kontinu benar-benar
  tipis/habis. Event waiting dari decoder yang masih memiliki buffer sehat
  tidak memicu pause.
- Intent jeda pengguna dimiliki `pausePlayback()`, bukan ditebak dari event
  pause yang datang kemudian. Ini menutup race pause/play yang ditemukan
  dalam uji browser.
- Guard DVR mempertahankan segmen lama yang masih buffered. Posisi dipindah
  hanya bila sudah tidak playable dan di luar playlist.
- Warmup panjang memilih ulang posisi awal yang masih valid. `play()` yang
  dibatalkan seek dicoba lagi saat user masih menginginkan playback berjalan.
- Telemetri memakai edge playlist sebenarnya, range buffer saat ini,
  prebuffer status dan dropped frames. FPS/resolusi UI berasal dari video.

### Inferensi dan tracking

- Capture mengikuti `requestVideoFrameCallback`; fallback timer untuk
  browser tanpa API tersebut. Frame yang sama tidak diinferensi berulang.
- Satu capture/inference aktif. Guard skip berada di luar `try/finally`;
  hasil `null` berarti tidak ada inferensi baru, bukan deteksi kosong.
- Semua request memiliki ID. Seek/dispose menaikkan generation agar hasil
  lama diabaikan. Crash, init timeout, infer timeout, dan dispose menyelesaikan
  promise dan memberikan status error yang terlihat.
- Capture mempertahankan rasio sumber; timestamp dan ukuran dibekukan sebelum
  await. Koordinat/velocity dipetakan kembali ke ukuran video asli.
- Import ORT WebGPU eksplisit; warmup memvalidasi `[1,300,6]`. Dua inferensi
  setelah warmup mengukur provider. Kandidat yang lebih lambat dilepas;
  provider gagal tidak menggugurkan kandidat lain yang berhasil.
- Dua thread WASM paling banyak, menyisakan CPU bagi decoding/UI. Buffer
  NCHW dan input tensor dipakai ulang; output dibebaskan setiap putaran.
- Letterbox memakai padding abu-abu 114. Parser menolak koordinat nonfinite;
  kelas custom wajib dideklarasikan lewat `VITE_DETECTOR_CLASSES`.
- Kalman memakai dt video. Track matang menggunakan toleransi terhadap
  residual prediksi, dengan gate ukuran untuk mengurangi pertukaran ID.
  Grace render 0,35 detik; prediksi overlay maksimal 0,75 detik.
- Track ditampilkan setelah dua observasi agar frame pertama yang belum
  memiliki kecepatan tidak menggambar kotak diam di belakang kendaraan.
- Overlay mempertimbangkan letterbox tampilan video, termasuk fullscreen,
  dan menghapus hasil basi alih-alih membekukannya di jalan.

### Backend dan dataset

- Proxy terpisah, pool koneksi keep-alive terbatas, deadline 20 detik,
  respons maksimal 16 MB, LRU segmen maksimal 64 MB/TTL 60 detik.
- Fetch segmen yang sama dibagi ke request bersamaan. Playlist/error tidak
  di-cache. Range diteruskan tanpa cache; status upstream dipertahankan.
- URI segmen, varian, key dan init map di playlist dipetakan ke `/cctv`.
  Playlist ke host lain ditolak, bukan dijadikan proxy terbuka.
- Health endpoint menyediakan request count, hit/shared cache, error, waktu
  fetch terakhir, ukuran cache dan request aktif.
- Validasi signature PNG/JPEG/WebP sebelum penyimpanan; dedup dan perlindungan
  seed dipertahankan. Database asli tidak dimigrasi/dihapus.
- Export ZIP berjalan di worker dengan koneksi SQLite read-only dan snapshot
  transaksi. Satu export bersamaan, batas input 128 MB, timeout dan pembatalan
  saat klien terputus. HTTP stream tidak menunggu kompresi/pengemasan ZIP.
- Error API tetap JSON; file model/WASM yang hilang menjadi 404, bukan HTML
  fallback yang kemudian gagal diparse runtime.
- Vite meneruskan `/cctv` dan `/api` ke backend yang sama. Script copy ORT
  melewati file identik agar build berulang tidak menulis ulang WASM besar.

## Verifikasi

- `npm test`: 26 tes lolos, mencakup API backend lewat proses terpisah dengan
  database sementara, ZIP worker, validasi/dedup, proxy upstream tiruan,
  locking/correlation worker, timestamp, tracking, buffer dan lifecycle player.
- `npm run build`: TypeScript dan Vite produksi berhasil. Peringatan ukuran
  chunk HLS/ORT masih ada; ini bukan bukti ukuran runtime tanpa batas.
- Uji Chrome headless pada stream asli: 252 sampel selama **9,48 menit**;
  247 sampel playback berstatus delay, **0 stall**, buffer minimum **20,11**,
  median **23,62**, maksimum **37,36 detik**, dan **7 dropped frames**.
  Warmup/loading tercatat terpisah. Ini observasi satu sesi/jaringan.
- Sampel WebGPU sebelum benchmark provider: sekitar 3–4 hasil/detik;
  inferensi berubah mengikuti beban mesin, terutama ketika build/test ikut
  berjalan. Angka itu bukan klaim FPS konstan atau hasil evaluasi akurasi.
- Sesi dengan benchmark provider: **5,27 menit, 0 stall**, buffer playback
  **22,45–28,65 detik**. Pause/resume, seek DVR dan confidence lolos uji browser.
  Sampel akhir: 7.289 frame video, 36 dropped frames, deteksi 2,5 fps; sampel
  sebelumnya 3,3 fps. Sesi ini mencakup seek manual serta build/test bersamaan.
- Artefak lokal: `output/playwright/playback-before-provider-benchmark.json`
  dan `output/playwright/live.png`; sesi berikutnya di
  `output/playwright/final-playback.json` dan `output/playwright/final-running.png`.
  Folder pengujian diabaikan Git.

## Batas akurasi

Belum ada evaluasi precision/recall/mAP dengan frame beranotasi. Model tetap
YOLO26n bawaan; perubahan ini memperbaiki eksekusi, koordinat, waktu dan
tracking, bukan mengubah bobot model. Motor jauh, motion blur dan oklusi tetap
dapat luput. Prediksi gerak pendek membantu kontinuitas tetapi tidak sama
dengan pengamatan baru pada setiap frame video.

Dataset upload tetap image-level. Full-frame pseudo-box hanya cocok sebagai
bootstrap crop referensi; tidak merupakan label presisi screenshot CCTV.
Meningkatkan akurasi memerlukan anotasi box nyata, pembagian train/validation
yang terpisah, dan evaluasi di kamera target sebelum model diganti.

## Pembanding

HTML [CCTV resmi Bekasi](https://bekasikota.go.id/cctv) yang diambil pada sesi
ini membuat `CBPlayer` dengan autoplay dan memuat HLS/P2P. HTML tersebut tidak
menyatakan delay 45 detik. Strategi buffer awal di atas merupakan implementasi
GODS EYE untuk mendapatkan pola playback yang diminta, bukan klaim menyalin
konfigurasi internal CBPlayer persis. Source ORT/hls.js yang terpasang di
`dashboard/node_modules` dipakai untuk memeriksa API dan semantik runtime.
