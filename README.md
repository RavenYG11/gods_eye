# GODS EYE

Dashboard CCTV Bekasi dengan stream HLS serta deteksi dan tracking mobil/motor.
Backend Node.js + Express; frontend React + TypeScript.

## Menjalankan

Gunakan Node.js 24 LTS. Dari root proyek:

```powershell
npm run setup
npm start
```

Buka http://127.0.0.1:3000. Model default harus tersedia di
`dashboard/public/models/yolo26n.onnx`. Jika belum ada:

```powershell
dashboard\scripts\unduh-model.bat
npm run build
npm start
```

Sesudah mengubah kode frontend, jalankan `npm run build` dan muat ulang browser.
Sesudah mengubah backend, restart `npm start`. Data pengguna tetap berada di
`backend/data/dataset.db`; setup/build tidak menghapusnya.

## Playback

Saat awal, player mengisi buffer video dan menunggu warmup deteksi selesai.
Target delay 24 detik; buffer awal 16 detik. Target buffer menyesuaikan jendela
playlist yang pendek atau posisi seek dekat live. Setelah itu video diputar
pada 1×, tanpa jeda proaktif dan tanpa mengejar live edge secara berkala.

Jika data benar-benar habis, player mengisi buffer ulang dengan status yang
terlihat. Gangguan jaringan/upstream tetap bisa menyebabkan buffering.
Menambah delay tidak dapat menggantikan bandwidth yang kurang secara terus-menerus.
Pengaturan ada di `dashboard/src/lib/bufferPolicy.ts`.

Pause/resume, scrub DVR, fullscreen, dan toggle deteksi tersedia.
Tombol **Unduh log playback** menyimpan posisi, buffer yang dapat diputar,
delay sebenarnya, stall, dan dropped frames untuk pemeriksaan sesi.

## Deteksi

- Inferensi dan tracking berjalan di Web Worker. Satu frame diproses pada satu
  waktu, tanpa antrean yang menambah keterlambatan.
- WebGPU NHWC, WebGPU bawaan, dan WASM diukur saat awal; yang lebih cepat dipilih. Warmup
  lebih lama merupakan bagian dari loading awal. Kegagalan satu provider
  otomatis mencoba provider lain.
- FPS yang tampil adalah laju hasil nyata, bukan FPS video. Target 10 FPS
  merupakan batas capture, bukan jaminan kecepatan inferensi.
- Timestamp dibekukan saat frame ditangkap. Hasil sebelum seek diabaikan;
  tracker direset ketika waktu/resolusi berubah.
- ByteTrack menghubungkan observasi YOLO. Worker gerak terpisah memakai
  optical flow Lucas-Kanade bertingkat untuk mengukur posisi dan skala kendaraan
  di antara hasil YOLO. Target pelacakan 25 fps, terpisah dari laju inferensi.
  Mobil/motor pada ruas menuju Bekasi ditampilkan sejak observasi pertama,
  termasuk diam, arah belum pasti, dan kendaraan sebagian di tepi frame.
  Ruas seberang median dibuang sebelum asosiasi dan pada tracking; arah turun
  yang telah terukur juga disembunyikan. Kalibrasi khusus kamera ada di
  `dashboard/src/detection/targetRoad.ts`.
- Riwayat grayscale dibatasi 2,8 detik/80 frame. Kotak YOLO yang terlambat
  diselaraskan ke posisi kini. Track yang sudah terkunci memakai riwayat bbox
  pada waktu capture, sehingga tidak mengulang seluruh optical flow.
  Kotak yang lahir terpotong tepi frame langsung mengikuti ukuran observasi
  berikutnya saat badan kendaraan masuk seluruhnya; smoothing normal kembali
  dipakai setelah kendaraan lepas dari tepi.
  Kendaraan baru diprioritaskan; replay aktif diselesaikan meskipun hasil YOLO
  baru tiba, dengan satu hasil terbaru menunggu. Replay mengerjakan maksimal
  delapan langkah/anggaran 4 ms sebelum memberi giliran pada frame gerak.
- Acuan memakai kotak observasi asli, bukan posisi Kalman yang tertinggal.
  Track yang hanya diprediksi tidak dipakai sebagai pengukuran baru.
- Ambang kelahiran track tetap: mobil 0,35, motor 0,25. Observasi lemah
  >=0,12 dapat menyambung track terkonfirmasi. Tidak ada slider confidence.
- Kehilangan bukti piksel menghentikan pelacakan; kotak kedaluwarsa setelah
  220-400 ms tanpa bukti piksel. Track naik yang konsisten dapat melewati
  model miss sampai empat detik selama titik gambarnya masih terlacak.
  Overlay menghaluskan koreksi dan menjembatani maksimal 80-240 ms sesuai cadence.
- Biru = ke atas/masuk Bekasi, abu = diam/arah belum pasti pada ruas tujuan.
- Panel memisahkan jumlah yang terlihat dan total masuk Bekasi pada sesi ini.
  Hitungan bertambah sekali per identitas visual setelah minimal tiga pengukuran
  gerak piksel selama 0,3 detik dan perpindahan naik >maks(4 px, 12% tinggi bbox)
  pada gambar tracking. Seek, perubahan resolusi, diskontinuitas video >1 detik,
  muat ulang atau menyalakan ulang deteksi mereset sesi; total belum disimpan.
- Area masuk kanan bawah mendapat inferensi pertama dan setiap dua inferensi
  (sebelumnya sekali dalam enam). Crop kiri dan kanan mencakup tinggi frame
  penuh, ditambah satu overview dalam enam giliran. Ruang padding vertikal
  dipakai untuk memulihkan cakupan motor tanpa mengecilkan skala crop mobil.
  Satu inferensi per giliran. Kendaraan terpotong pada
  batas asli frame dipertahankan; potongan di sambungan crop memakai view lain.
- Objek minim fitur piksel tetap boleh tampil dari kotak model terbaru selama
  300–800 ms mengikuti cadence. Kotak ini belum menjadi bukti arah/hitungan.
- Badge Delay di kiri atas dihapus; kebijakan cadangan video tetap aktif.

Model bawaan tetap YOLO26n COCO. Akurasi motor jauh, oklusi, malam, dan blur
memerlukan pengukuran dengan anotasi frame CCTV. Confidence model tidak sama dengan persentase akurasi sistem.

Model custom dengan urutan kelas `[mobil, motor]`:

```powershell
$env:VITE_DETECTOR_MODEL = 'models/gods-eye-custom.onnx'
$env:VITE_DETECTOR_CLASSES = 'mobil,motor'
npm run build
```

Output model harus `[1,300,6]` berupa `[x1,y1,x2,y2,confidence,classId]`.
Pemetaan kelas wajib dinyatakan agar ID 0/1 model custom tidak salah dibaca
sebagai ID 2/3 COCO.

## Backend

| Endpoint | Fungsi |
|---|---|
| `/cctv/*` | Proxy HLS dengan keep-alive, timeout, rewrite playlist ke same-origin, cache segmen berbatas 64 MB |
| `/api/health` | Status backend dan statistik proxy |

Playlist tidak disimpan di cache. Segmen yang sama memakai satu fetch bersama;
cache hanya membantu request ulang atau beberapa viewer. Satu viewer yang
mengunduh segmen baru tidak otomatis menjadi lebih cepat karena cache.

Fitur dataset (card, upload, paste, daftar, hapus, export, SQLite runtime,
serta skrip trainer terkait) sudah dihapus. Endpoint lamanya mengembalikan 404.
Database lama tetap tersimpan sebagai arsip dan tidak dibuka oleh backend.

Environment backend: `PORT` (3000), `HOST` (127.0.0.1), `CCTV_UPSTREAM`
(https://eofficev2.bekasikota.go.id).

## Development dan verifikasi

Terminal pertama: `npm start`. Terminal kedua:

```powershell
npm --prefix dashboard run dev
```

Vite meneruskan `/cctv` dan `/api` ke backend port 3000, sehingga development
memakai kebijakan proxy yang sama dengan produksi.

```powershell
npm test
npm run build
```

Tes regresi memakai Node test runner dan TypeScript yang sudah terpasang di
dashboard, tanpa framework tes tambahan. Cakupan: locking worker, korelasi
respons, timestamp, seek, tracker, optical flow dengan ukuran error posisi,
buffer, lifecycle player, proxy dan penghapusan API dataset.

Analisis perombakan dan hasil uji: [docs/optimisasi-2026-10-24.md](docs/optimisasi-2026-10-24.md).
Dokumen historis bertanggal 15–16 Oktober menjelaskan versi sebelum perombakan;
gunakan README ini dan analisis 24 Oktober sebagai acuan perilaku saat ini.

Tracking piksel dan hasil verifikasi terbaru: [docs/tracking-piksel.md](docs/tracking-piksel.md).

Deteksi sejak observasi pertama dan hitungan sesi: [docs/deteksi-awal-frame.md](docs/deteksi-awal-frame.md).

Prioritas area masuk dan filter ruas tujuan: [docs/prioritas-area-masuk.md](docs/prioritas-area-masuk.md).

Diagnosis regresi motor dan koreksi cakupan crop: [docs/diagnosis-motor.md](docs/diagnosis-motor.md).

Catatan versi sebelumnya: [docs/tracking-atas.md](docs/tracking-atas.md).
Filter arah pada dokumen tersebut kini hanya menjadi bukti hitungan; deteksi
tetap menampilkan semua arah.
