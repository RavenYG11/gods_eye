> **Arsip versi sebelumnya.** Fitur dataset sudah dihapus; tracking terbaru memakai worker optical flow. Lihat [tracking-piksel.md](tracking-piksel.md) dan [README](../README.md).

# Training Model Deteksi dari Dataset GODS EYE (#74)

Pipeline v1: **dataset (SQLite)** → **export ZIP (YOLO)** → **train (Ultralytics)**
→ **ONNX** → **pasang di dashboard**. Ditulis untuk Rama — langkah presisi,
tanpa asumsi.

## Batas jujur — baca dulu (penting)

1. **Label export = pseudo-box full-frame (bootstrap).** Sampel dataset GODS EYE
   berlabel *image-level* ("gambar ini berisi mobil"), tanpa bounding box.
   Export menulis `<classId> 0.5 0.5 1.0 1.0` — seluruh gambar dianggap objek.
   Model yang dilatih darinya belajar "seluruh frame = kendaraan": cocok
   sebagai **titik awal / eksperimen**, BUKAN sebagai detektor presisi.
2. **Untuk akurasi serius:** anotasi bounding box manual per gambar
   (mis. via [CVAT](https://www.cvat.ai/) / labelImg — format YOLO txt
   `class cx cy w h` dinormalisasi 0–1), ganti isi `labels/*.txt` di hasil
   extract ZIP, lalu train dari folder (bukan ZIP).
3. **Sampel minimal realistis:** 50–200+ per kelas, variasi sudut /
   pencahayaan / malam-hari. 2 seed bawaan TIDAK cukup untuk training
   (lihat `docs/dataset.md` — "Batasan yang JUJUR").
4. **Bobot hasil training TIDAK BOLEH di-commit** (`.gitignore` +
   `docs/arsitektur.md` §5 butir 3) — simpan di `dashboard/public/models/`
   lokal saja.

## Langkah end-to-end

### 1. Kumpulkan dataset
Via dashboard → card **Kelola Dataset** (kolom kanan): Upload / paste
(`Ctrl+V`) / drag-drop, pilih label `mobil`/`motor` dulu. Target: puluhan–
ratusan per kelas.

### 2. Export ZIP dari backend
Backend harus jalan (`npm start` di root repo — lihat bawah):

```bash
curl -o dataset.zip http://localhost:3000/api/dataset/export
```

Isi ZIP: `images/train|val/<id>.<ext>`, `labels/train|val/<id>.txt`,
`dataset.yaml` (`nc: 2`, `names: ['mobil','motor']` → mobil=0, motor=1;
split train/val 80/20 deterministik). Verifikasi cepat:

```bash
unzip -l dataset.zip
unzip -p dataset.zip dataset.yaml
```

### 3. Training

Butuh Python + `ultralytics` (menarik torch ±2 GB — sekali saja):

```bash
pip install ultralytics
python3 tools/train_yolo.py --data dataset.zip --dry-run   # validasi dulu
python3 tools/train_yolo.py --data dataset.zip --epochs 50 --imgsz 640
```

Argumen lengkap: `python3 tools/train_yolo.py --help`. Catatan:

- `--model` default `yolo26n.pt` (diunduh otomatis Ultralytics saat pertama
  dipakai) — SELARAS dengan detektor dashboard (YOLO26n, output `[1,300,6]`).
- `--device cpu` untuk laptop tanpa GPU (lambat — untuk dataset besar
  pertimbangkan GPU/Colab).
- Hasil: `runs/gods-eye/weights/best.onnx` (+ `best.pt` bila perlu).

### 4. Pasang ONNX ke dashboard

```bash
cp runs/gods-eye/weights/best.onnx dashboard/public/models/gods-eye-custom.onnx
cd dashboard
VITE_DETECTOR_MODEL=models/gods-eye-custom.onnx npm run build
```

`VITE_DETECTOR_MODEL` = path relatif ke base (boleh juga URL). Bila tidak
diset, dashboard tetap memakai `models/yolo26n.onnx` bawaan. Model custom
**wajib** hasil export Ultralytics YOLO26n (output `[1,300,6]`) — warmup
detektor menolak format lain dengan pesan jelas.

Di Windows (bash Rama):

```bash
cp runs/gods-eye/weights/best.onnx dashboard/public/models/gods-eye-custom.onnx
cd dashboard
VITE_DETECTOR_MODEL=models/gods-eye-custom.onnx npm run build
```

### 5. Verifikasi di dashboard

1. `npm start` (root repo) → buka `http://localhost:3000`.
2. Card **Deteksi kendaraan**: status harus `ready`; chip menampilkan
   provider (`webgl`/`wasm`) + `inferMs` + fps deteksi.
3. Arahkan ke jalan dengan kendaraan: box harus muncul & mengunci
   (bandingkan dengan model bawaan — reload dengan build tanpa
   `VITE_DETECTOR_MODEL` untuk A/B).
4. Bila "Model deteksi gagal dimuat": file `.onnx` belum tersalin ke
   `public/models/` SEBELUM build, atau bukan format YOLO26n
   (lihat `docs/runbook.md` §7 troubleshooting).

## Referensi silang

- Export endpoint: `backend/server.js` → `GET /api/dataset/export`
  (ZIP pure-Node: `backend/lib/zip.js`).
- CLI: `tools/train_yolo.py` (`--help` jalan tanpa ultralytics).
- Pilihan model via env: `dashboard/src/detection/vehicleConfig.ts`
  (`modelUrl()` + `VITE_DETECTOR_MODEL`).
- Panel dataset: `docs/dataset.md`.
