# Deteksi awal frame dan hitungan masuk Bekasi — 26 Oktober 2026

Filter arah sebelumnya menahan kotak sampai optical flow menyatakan kendaraan
bergerak ke atas. Ada syarat dua observasi/first confidence tinggi di worker
gerak dan penolakan seluruh tepi crop. Akibatnya objek diam dan kendaraan baru
masuk terlambat terlihat meskipun YOLO sudah memberi observasi kendaraan.

Sekarang deteksi, arah, dan hitungan memakai syarat berbeda:

- Mobil >=0,35 dan motor >=0,25 memulai track pada observasi pertama.
  Observasi >=0,12 hanya menyambung track yang sudah ada.
- Semua arah tampil. Abu berarti diam/arah belum pasti; biru berarti ke atas;
  hijau berarti ke bawah. Arah visual berasal dari gerak piksel.
- Frame utuh diproses setiap giliran genap. Giliran lain bergantian memperbesar
  jalan dekat kiri, dekat kanan dan area jauh. Satu inferensi per giliran tetap.
- Tepi asli gambar menerima kendaraan yang baru terlihat sebagian. Sambungan
  crop buatan tetap menolak fragmen yang disediakan overview/view tumpang tindih.
- Kendaraan minim fitur mendapat kotak observasi model yang berumur terbatas
  300–800 ms. Kehilangan fitur pada track yang sebelumnya terlacak tetap memakai
  tenggat piksel yang lebih pendek, sehingga oklusi tidak meninggalkan ghost.
- Total masuk Bekasi terpisah dari jumlah mobil/motor yang sedang terlihat.
  Satu identitas visual dihitung sekali setelah arah ke atas terkonfirmasi,
  minimal tiga pengukuran piksel, durasi >=0,3 detik, dan perpindahan kumulatif
  ke atas >maks(4 piksel, 12% tinggi bbox) pada gambar tracking. Model direction
  flag atau koreksi bbox saja tidak menambah hitungan.
- Status sudah dihitung mengikuti identitas visual saat ID YOLO berubah selama
  objek masih dapat dicocokkan. Objek hilang lama dan identitas baru tetap dapat
  menyebabkan hitungan ganda; belum ada re-identifikasi lintas oklusi panjang.
- Total hanya sesi browser. Seek, perubahan resolusi, diskontinuitas >1 detik,
  reload dan restart deteksi memulai sesi baru. Belum ada penyimpanan total harian
  atau pengukuran lewat garis geografis; arah ke atas mengikuti definisi pengguna.

Regresi mencakup deteksi pertama objek diam dan motor setengah badan pada tepi
frame, batas asli versus sambungan crop, objek minim tekstur yang kedaluwarsa,
dua arah lalu lintas, pemisahan total per kelas, stop, pergantian ID model,
dan penolakan hitungan dari jitter model. Tes ini mengukur perilaku pipeline;
akurasi klasifikasi YOLO pada CCTV malam/blur/oklusi belum diukur dengan anotasi.

## Verifikasi

`npm.cmd test`: **55 tes lolos**. `npm.cmd run build`: TypeScript dan Vite
berhasil. Tes protokol menjalankan handler worker gerak dengan frame sintetis,
memastikan kotak dipulihkan ke resolusi sumber dan total sampai ke respons
worker, lalu kembali nol setelah reset.

Probe browser lokal pada stream aktual: 14,92 detik video, 373 frame decode,
4 dropped frames. Ada 200 pembaruan gerak, rata-rata 4,01 kotak dan maksimum 7;
motor muncul pada 31 pembaruan. Semua status arah (`unknown`, `atas`, `bawah`)
muncul. Ada 15 kemunculan kotak ber-observasi pertama pada snapshot (bukan
15 kendaraan unik). Indikator akhir sekitar 2 fps deteksi dan 15,5 fps tracking.
Total worker bergerak dari 1 mobil/0 motor menjadi 8 mobil/2 motor; screenshot
panel memperlihatkan total 8/2 dan kotak abu pada mobil parkir. Ini memverifikasi
aliran data dan perilaku tampilan, bukan kebenaran jumlah terhadap anotasi.

Artefak lokal: `output/playwright/frame-entry-live.png`,
`output/playwright/frame-entry-report.json`, dan `frame-entry-probe.js`.
