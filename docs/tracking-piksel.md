# Tracking piksel dan penghapusan dataset

Keluhan: box masih tertinggal dari mobil/motor, hilang-muncul, dan tidak
terlihat melekat pada kendaraan ketika inferensi hanya sekitar 2 fps.

## Akar masalah

Menggambar canvas pada 60 fps tidak meningkatkan frekuensi pengukuran objek.
Overlay sebelumnya menggeser kotak memakai velocity Kalman selama hasil YOLO
belum datang. Kecepatan, ukuran, arah, dan perspektif kendaraan dapat berubah
dalam interval itu. Memperpanjang masa tampil mengurangi kedip tetapi tidak
memperbaiki posisi yang salah.

Posisi Kalman yang sudah disaring juga tertinggal dari observasi terbaru.
Memakai posisi tersebut sebagai patch gambar membuat pelacak mulai dari
bagian gambar yang bukan lagi kendaraan.

## Implementasi

1. Worker YOLO tetap mengerjakan satu inferensi pada satu waktu. ByteTrack
   dipakai untuk asosiasi, tetapi acuan yang benar-benar teramati memakai bbox
   asli keluaran model, bukan bbox Kalman yang telah disaring.
2. Worker gerak berjalan terpisah. Frame grayscale lebar 640 piksel, target
   maksimal 25 fps, tanpa antrean frame tak terbatas. Setiap kotak dilacak
   melalui maksimal 12 titik Shi–Tomasi dan Lucas–Kanade bertingkat.
3. Setiap titik melewati pemeriksaan residual gambar dan gerak maju/balik.
   Median gerak dan perbandingan jarak antar-titik mengukur translasi serta
   pertumbuhan ukuran karena perspektif. Velocity hanya menjadi tebakan awal
   pencarian piksel, bukan sumber posisi akhir.
4. Riwayat maksimal 80 frame/2,8 detik menyelaraskan hasil YOLO yang terlambat
   ke gambar kini. Acuan model diproses per kendaraan dengan yield di antaranya
   supaya frame video berikutnya mendapat kesempatan diproses.
5. Satu frame rusak boleh dipulihkan dari gambar terakhir yang berhasil
   dilacak selama 120 ms. Bukti piksel yang hilang terus-menerus dan observasi
   model yang tidak diperbarui selama 2,2 detik mengakhiri tampilan kotak.
   Track Kalman yang hanya diprediksi tidak memperpanjang bukti observasi.
6. Overlay membaca snapshot melalui ref tanpa merender React pada setiap
   frame. Ekstrapolasi terakhir dibatasi 70 ms; snapshot tertinggal lebih dari
   200 ms disembunyikan. Seek, resize, retry, toggle, dan unmount mengakhiri
   generasi sebelumnya, menutup bitmap, dan menghentikan worker/timer terkait.

Capture gerak dijadwalkan pada timestamp video, sehingga jitter callback pada
jam browser tidak membuat stream 25 fps kehilangan setiap frame kedua.

Ambang awal track ada di `vehicleConfig.ts`: mobil **0,45**, motor **0,30**.
Observasi >=0,15 dapat menyambung track yang sudah terkonfirmasi. Slider
confidence dihapus. Label menampilkan jenis dan ID, tanpa menampilkan confidence
sebagai persentase akurasi. Bobot model tetap YOLO26n COCO; akurasi kendaraan
yang belum dikenali memerlukan evaluasi model dengan anotasi CCTV sebenarnya.

Referensi metode: [OpenCV optical flow](https://docs.opencv.org/4.10.0/d4/dee/tutorial_optical_flow.html)
dan [Ultralytics tracking](https://docs.ultralytics.com/modes/track/).
Implementasi piksel lokal memakai TypeScript tanpa menambahkan runtime OpenCV.

## Dataset dihapus

Card, upload, paste, daftar sampel, delete, export ZIP, akses SQLite runtime,
seed metadata, CSS, dan skrip trainer terkait sudah dihapus. Semua endpoint
`/api/dataset` mengembalikan 404. Database lama tidak dibuka atau diubah oleh
server, dan tetap tersimpan sebagai arsip pengguna. Dokumen dataset/training
lama ditandai sebagai arsip.

## Verifikasi

Tes piksel menggunakan gambar bertekstur dengan koordinat objek yang diketahui:
translasi, perubahan skala, akselerasi, berhenti/berbalik, dua arah gerak,
pergantian ID YOLO, kecepatan tinggi, satu frame rusak, oklusi, seek, perubahan
resolusi, dan kedaluwarsa. Hasil terlambat 0,8 detik diputar ulang melalui
gambar sebenarnya; batas galat pusat pada skenario gerak adalah 1,5 piksel
di frame uji lebar 320/640 piksel. Ini bukan pengukuran akurasi model pada CCTV.

Probe CCTV selama optimasi mencakup 15 detik video: 225 pembaruan gerak,
YOLO sekitar 3 fps, tracking 14,9 fps, 376 frame video dan 0 dropped frames.
Semua pembaruan gerak memiliki setidaknya satu kotak; 147 memuat track motor.
Jumlah kotak rata-rata 4,32, maksimum 6. Biaya frame worker median 30 ms,
p95 50 ms (tidak mencakup seluruh pekerjaan acuan yang dijadwalkan terpisah).
Card dataset dan slider sudah tidak ada pada DOM.

Angka tersebut mengukur kelancaran dan beban pada sampel itu, bukan persentase
akurasi atau jaminan semua kendaraan terdeteksi/tidak pernah hilang.
Artefak lokal: `output/playwright/vehicle-lock-live.png`.

Verifikasi versi final: **36 tes lolos**, build TypeScript/Vite berhasil.
Probe final di port 3000 mencakup 14,99 detik video dengan 380 frame decode
dan 0 tambahan dropped frames; indikator akhir YOLO 3 fps dan tracking
15,8 fps. Pause mempertahankan waktu 113,5986 selama 1,2 detik; resume dan
seek kembali berjalan tanpa error deteksi. Health mendapat 200 dan dataset
404. Screenshot memiliki delay lebih panjang karena pengujian manual pause.
Hitungan callback mentah dari probe yang dipasang ulang tidak dipakai sebagai
jumlah frame unik karena callback instrumentasi dapat terpasang rangkap.
