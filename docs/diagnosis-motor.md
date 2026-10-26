# Diagnosis motor — 26 Oktober 2026

Pengguna melaporkan motor terlambat atau tidak terlihat sejak perubahan prioritas
mobil. Audit ini membedakan jadwal melihat suatu area, inferensi model, dan
pelacakan setelah model mengenali kendaraan.

## Temuan terverifikasi

Pada kode sebelumnya, posisi representatif motor kiri atas dan masuk bawah kiri
hanya masuk dua dari enam giliran crop. Dengan laju total dari probe terakhir
2,7729 fps, kesempatan area itu sekitar 0,924 kali/detik. Jarak empat giliran
antara dua view yang mencakup motor dapat memakan sekitar 1,44 detik, sebelum
menambahkan waktu inferensi rata-rata 335,25 ms. Nilai ini perkiraan dari cadence
probe, bukan batas waktu saat perangkat melambat.

Posisi representatif motor pada screenshot lolos filter median. Karena itu
filter median bukan penjelasan untuk kasus posisi tersebut. Belum ada output
mentah YOLO dari frame screenshot pengguna; penyebab setiap motor yang sama
sekali terlewat tidak boleh disimpulkan hanya dari screenshot atau hitungan bbox.

Motor perlu score >=0,25 untuk melahirkan track; score >=0,12 hanya menyambung
track yang sudah ada. Observasi juga harus melewati validasi geometri dan bukti
tracking piksel. Model miss, score rendah dan kegagalan replay masih mungkin;
menaikkan frekuensi scan tidak otomatis mengubah score/kelas keluaran model.

Tracking sekitar 21 fps bukan 21 inferensi YOLO per detik: tracking memperbarui
posisi objek yang sudah dikenal. `inferMs` mengukur satu putaran worker, bukan
seluruh jeda sejak kendaraan memasuki kamera sampai kotaknya tampil.

## Koreksi yang dilakukan

Crop kiri dan kanan sekarang memakai tinggi gambar penuh. Pada kamera 960×540,
crop kanan sebelumnya 653×389 dan input model 640×640; lebar menentukan skala
640/653. Memperpanjang crop menjadi 653×540 tetap memakai skala yang sama,
dengan padding vertikal yang lebih kecil. Jumlah inferensi tidak ditambah.

Urutan: kanan, kiri, kanan, overview, kanan, kiri. Motor kiri atas dan bawah kiri
kini mendapat giliran 1/3/5: tiga kesempatan merata dalam enam giliran, dibanding
dua yang tidak merata. Pada cadence acuan yang sama, kesempatan naik menjadi
1,386 kali/detik dan jarak maksimal antarview sekitar 0,721 detik. Mobil kanan
tetap mendapat giliran 0/2/3/4 dengan skala detail yang sama.

Tes memverifikasi cakupan motor, interval giliran, pemulihan tepi atas/bawah,
dan skala serta jumlah giliran mobil. Ini memperbaiki regresi penjadwalan;
belum membuktikan recall motor pada video pengguna dan tidak menjamin motor
setengah badan selalu dikenali model.

Artefak audit lokal: `output/playwright/motor-coverage-before.json`,
`motor-coverage-diagnosis.json` dan `motor-coverage-diagnosis.mjs`.
Tidak ada browser atau service pengujian yang dijalankan untuk audit ini.
