> **Arsip versi sebelumnya.** Fitur dataset sudah dihapus; tracking terbaru memakai worker optical flow. Lihat [tracking-piksel.md](tracking-piksel.md) dan [README](../README.md).

# Perbaikan kotak deteksi hilang–muncul

Keluhan: kotak kadang tepat tetapi berkedip saat indikator menunjukkan
2,3 fps / 434 ms. Perubahan ini melanjutkan perombakan 24 Oktober dan mengganti
batas render 350/500/750 ms yang dijelaskan di dokumen perombakan awal.

## Penyebab

- Saat hasil inference tiba, frame-nya sudah berumur sekitar 434 ms. Hasil
  berikutnya baru datang sekitar 435 ms kemudian. Menghapus kotak pada umur
  750 ms membuat celah kosong sekitar 119 ms pada setiap putaran normal.
- Tracker sebelumnya membuang tampilan track hilang setelah 350 ms. Satu
  deteksi luput pada 2,3 fps sudah melewati batas itu, sehingga kotak langsung
  hilang meskipun ID internal masih disimpan.
- Overlay memakai batas stale 500 ms dan menurunkan opacity dari 1 ke 0,55.
  Selain hilang total, kotak juga tampak berkedip karena perubahan opacity.
- Tahap pencocokan confidence rendah hanya menerima track aktif. Setelah
  satu hasil kosong, skor lemah berikutnya tidak dapat memulihkan track yang
  sudah berstatus lost sampai hasil high-confidence muncul lagi.

## Perubahan

- Interval capture diukur dalam waktu video dan menyesuaikan ketika model
  melambat. Latensi capture sampai hasil diterima diukur terpisah di main thread.
- Grace tracker mengikuti 2,5 kali interval deteksi, dengan batas 350–1.600 ms.
  Pada 2,3 fps ini memberi sekitar 1,08 detik untuk track baru dan 1,96 detik
  untuk track yang sudah konsisten terkonfirmasi.
- Umur presentasi mencakup grace, latensi hasil dan satu interval berikutnya,
  dengan batas maksimum 3 detik. Prediksi ikut memakai horizon yang sesuai;
  kotak tidak berhenti bergerak pada 750 ms sementara masih terlihat.
- Track confirmed yang baru hilang boleh tersambung melalui confidence rendah
  selama jendela pemulihan pendek. Gate jarak/ukuran tetap berlaku; confidence
  rendah sendiri tidak membuat track baru.
- Opacity stabil selama grace, baru fade mendekati kedaluwarsa. Counter memakai
  track confirmed yang masih dipertahankan, sehingga tidak turun-naik tiap miss.
- UI menyimpan track yang masih valid saat worker tidak menyertakannya dalam
  hasil berikutnya. Timestamp observasi tidak diperbarui oleh retensi ini,
  sehingga kotak tetap kedaluwarsa. Track baru yang terkonfirmasi dan sangat
  berimpit menggantikan cache lama agar tidak menggambar dua kotak untuk objek sama.
- Seek tetap mengosongkan hasil lama. Model macet dan kendaraan yang benar-benar
  hilang tetap kedaluwarsa; perubahan ini tidak menahan kotak selamanya.

## Verifikasi

Tes menggunakan tracker dan fungsi presentasi yang sama dengan overlay aplikasi,
disampling pada 60 Hz dengan delay hasil yang disimulasikan:

- 2,3 fps dan latensi 434 ms, tanpa hasil kosong;
- satu, dua, dan empat frame YOLO kosong, disusul skor lemah 22%;
- 1 fps dengan latensi 900 ms;
- hasil berhenti, kendaraan pergi, seek, dan deteksi lemah tanpa konfirmasi.

`npm test`: **37 tes lolos**. Build TypeScript/Vite produksi berhasil.

Probe Chrome pada stream asli merekam **1.194 frame canvas**, **45 ID track**,
dan tidak menemukan ID yang hilang lalu muncul lagi dalam celah kurang dari
1 detik selama sampel tersebut. Indikator saat akhir sampel: **2,7 fps / 340 ms,
WebGPU**, dropped video frames pada interval probe: **0**. Ada 51 frame canvas
tanpa kotak sama sekali; pengukuran ini tidak membuktikan semua kendaraan
terdeteksi dan tidak mengukur pergantian ID antar-kendaraan.
Probe berikutnya pada versi awal menemukan tujuh celah pendek pada 87 ID.
Hasil ini mendorong penambahan grace khusus track yang sudah konsisten kuat;
sampel pertama saja tidak cukup untuk menyimpulkan semua kedip hilang.
Screenshot: `output/playwright/flicker-fixed.png` (artefak lokal, diabaikan Git).

Probe sebelum retensi UI selama 19,99 detik merekam 1.191 frame canvas, semuanya
memiliki setidaknya satu kotak. Dari 88 ID, masih tercatat tiga celah
hilang–muncul pendek (0,647; 0,332; 0,917 detik). Video: 500 frame, 1 dropped
frame; deteksi 2,8 fps / 309 ms melalui WebGPU. Adegan antar-probe berbeda,
sehingga hasil ini tidak boleh dianggap benchmark penurunan persentase kedip.
Perbaikan timer dan pemulihan track lolos tes regresi, tetapi seluruh kehilangan
objek pada stream nyata belum bisa diklaim hilang. Ringkasan angka disimpan di
`output/playwright/flicker-report.json`.

Sesudah retensi UI ditambahkan, probe berikutnya mencakup **9,98 detik waktu
video**, **582 frame canvas**, **52 ID**, dan masih menemukan **satu celah
0,433 detik**. Semua 582 frame canvas memiliki setidaknya satu kotak; video
251 frame dengan 0 dropped frames pada interval itu. Indikator akhir 2,5 fps /
311 ms. Ini memperbaiki penyebab periodik yang direproduksi oleh tes, tetapi
bukan bukti semua objek sudah stabil atau semua kesalahan model sudah teratasi.

Ini memperbaiki kontinuitas tracking/presentasi. Bobot YOLO tidak berubah;
kendaraan yang tidak dikenali model sama sekali tidak dapat dimunculkan hanya
dengan memperpanjang umur track. Skor 22% pada track yang sudah terkonfirmasi
merupakan confidence observasi terbaru, bukan ukuran akurasi sistem keseluruhan.
