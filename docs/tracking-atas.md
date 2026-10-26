# Kontinuitas kotak dan kendaraan ke atas

Perubahan lanjutan 24 Oktober 2026 setelah posisi kotak sudah mengikuti kendaraan.
Dokumen ini memperbarui batas waktu dan rendering pada `tracking-piksel.md`.

## Penyebab hilang-muncul dan getaran

- Tenggang kehilangan titik 120 ms tidak cukup pada tracking 12 fps: satu
  frame gagal membuat jarak ke percobaan berikutnya sekitar 167 ms.
- Jeda komputasi di atas 300 ms mereset seluruh track, sehingga semua kotak
  menunggu deteksi dan identitas baru walaupun tidak ada seek.
- Kendaraan terkonfirmasi ditolak lagi ketika confidence observasi terbaru
  turun melewati ambang kelahiran track. Ambang yang sama diterapkan dua kali.
- Hasil model untuk objek yang sudah terkunci masih memutar ulang seluruh
  riwayat optical flow. Saat ramai, pekerjaan yang makin terlambat membuat
  frame berikutnya ikut terlambat.
- Koreksi bbox YOLO dan velocity per-frame langsung masuk ke canvas;
  batas prediksi 70 ms membuat kotak berhenti sebentar pada laju sekitar 12 fps.

## Perubahan

Badge **Delay** di kiri atas disembunyikan. Cadangan video tetap bekerja;
informasi delay di kontrol DVR dan log koneksi tetap tersedia.

Hanya kendaraan dengan gerak piksel yang terkonfirmasi **ke atas gambar**
yang ditampilkan dan dihitung. Arah memakai perpindahan yang terkumpul,
bukan tanda delta satu frame. Koreksi posisi model tidak dipakai sebagai gerak
kendaraan saat menentukan arah. Track bergerak ke bawah dihentikan lebih awal.

Tenggang pixel-tracking mengikuti tiga interval gerak dengan batas 220–400 ms.
Identitas disimpan terpisah selama maksimal 800 ms kehilangan bukti piksel;
kotak yang sudah kedaluwarsa tetap disembunyikan. Track naik yang konsisten
boleh melewati model miss sampai empat detik selama titik gambarnya masih
terlacak. Tenggang ini tidak diperbarui oleh prediksi Kalman.

Observasi yang sudah terkonfirmasi tidak melewati ambang kelahiran dua kali.
Observasi pertama yang kuat (mobil >=0,75; motor >=0,65) juga boleh memulai
track jika replay piksel telah membuktikan gerak ke atas. Noise lemah tidak
bisa memakai jalur ini.

Riwayat bbox hasil flow disimpan bersama timestamp. Acuan model untuk track
yang sudah terkunci diverifikasi terhadap posisi pada **waktu capture** lalu
dikoreksi ringan, tanpa mengulang flow. Riwayat setelah capture ikut dikoreksi
agar beberapa hasil terlambat tidak mengoreksi kesalahan lama berulang kali.
Gangguan komputasi singkat tidak lagi mereset semua ID; reset pada seek,
perubahan resolusi, waktu mundur, dan lompatan besar tetap berlaku.
Replay kendaraan baru juga dipecah per frame riwayat dan memberi giliran
kepada frame video di antaranya. Pekerjaan itu mengejar frame baru secara
bertahap; acuan yang digantikan atau direset langsung dibatalkan.

Titik flow yang masih baik dipertahankan; penambahan titik dilakukan ketika
jumlahnya kurang dari enam. Rendering 60 Hz memakai feed-forward gerak dan
menghaluskan residual koreksi sekitar 55 ms. Prediksi dibatasi 80–240 ms sesuai
cadence, dan berakhir bersama tenggang bukti piksel. Latensi hasil worker
diukur terpisah ketika hasil tiba. Tenggang render mencakup latensi itu,
maksimal 600 ms, sementara prediksi posisi tetap dibatasi maksimal 240 ms.
Jika worker menghilangkan track karena bukti piksel gagal, snapshot kosong
tetap langsung mengakhiri tampilan; kompensasi pengiriman tidak memulihkannya.

Inferensi bergantian antara pandangan utuh dan crop jalan dekat kamera.
Hanya satu inferensi dijalankan per giliran. Crop memperbesar motor pada input
model tanpa menjalankan dua inferensi sekaligus; koordinat dikembalikan ke
frame utuh dan objek terpotong di tepi crop diserahkan ke pandangan utuh.
Bobot model tetap sama, sehingga kendaraan yang tidak dikenali model masih
bisa terlewat. Perubahan ini tidak mengklaim persentase kenaikan akurasi.

## Verifikasi

`npm test`: **50 tes lolos**. Build TypeScript/Vite berhasil.
Tambahan tes mencakup pemulihan pada 12 fps, arah naik/turun, observasi lemah
yang sudah terkonfirmasi, pengambilan awal dari gerak piksel, model miss,
jeda komputasi, replay dengan frame live yang menyela, koreksi model terlambat berulang, penghalusan tanpa lag satu
interval, dan pemetaan koordinat crop.

Pada uji sintetis dengan jitter pengukuran +/-2 piksel, RMS jitter tampilan
harus di bawah 1,5 piksel. Pada gerak konstan dengan pengukuran 12 fps,
galat posisi rendering 60 Hz harus di bawah 0,1 piksel. Ini menguji presenter,
bukan akurasi detektor pada citra CCTV.

Artefak uji CCTV lokal berada di `output/playwright/upward-continuity.png`.
Probe final 20,01 detik merekam 1.183 frame canvas dan 44 ID. Tidak ditemukan
ID yang hilang lalu muncul kembali dalam celah kurang dari satu detik pada
sampel ini. Sebanyak 1.166 frame canvas memiliki kotak; 17 sisanya kosong.
Video merekam 501 frame decode dan dua dropped frames. Indikator akhir:
YOLO 3,2 fps, tracking 16,3 fps, 9 mobil dan 6 motor. Semua arah pada snapshot
adalah `atas`, dan badge Delay tidak ada di DOM.

Ini bukan bukti semua kendaraan terdeteksi atau tidak pernah hilang. Metrik
celah pendek tidak mengukur kendaraan yang luput permanen maupun pergantian
identitas antarkendaraan. Rincian lokal: `output/playwright/upward-report.json`.
Server uji memakai port 3100 dan dihentikan sesudah verifikasi; proses pengguna
pada port 3000 tidak diambil alih.
