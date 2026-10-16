#!/usr/bin/env python3
"""GODS EYE — latih model deteksi YOLO dari hasil export dataset.

Alur (lihat docs/training.md):
    1. Export dataset dari backend: GET /api/dataset/export → dataset.zip
    2. python3 tools/train_yolo.py --data dataset.zip --epochs 50
    3. Salin runs/<nama>/weights/best.onnx ke dashboard/public/models/
    4. Build dashboard dengan VITE_DETECTOR_MODEL=models/<nama>.onnx

BUTUH (hanya saat training, bukan untuk --help / --dry-run):
    pip install ultralytics   (menarik torch otomatis; butuh ruang ±2 GB)

Contoh:
    python3 tools/train_yolo.py --help
    python3 tools/train_yolo.py --data dataset.zip --dry-run   # validasi saja
    python3 tools/train_yolo.py --data dataset.zip --epochs 50 --imgsz 640
    python3 tools/train_yolo.py --data ./dataset --model yolo26n.pt --batch 8
"""

import argparse
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Latih YOLO (Ultralytics) dari export dataset GODS EYE lalu export ke ONNX.",
        epilog=(
            "Dataset export = ZIP dari GET /api/dataset/export "
            "(images/train|val + labels/train|val + dataset.yaml). "
            "Label di export = pseudo-box full-frame (bootstrap) — baca "
            "docs/training.md sebelum training serius."
        ),
    )
    p.add_argument(
        "--data",
        required=True,
        help="ZIP hasil export (/api/dataset/export) ATAU folder hasil extract-nya "
             "(yang berisi dataset.yaml).",
    )
    p.add_argument(
        "--model",
        default="yolo26n.pt",
        help="Bobot awal Ultralytics (default: yolo26n.pt — diunduh otomatis saat pertama "
             "dipakai; cocok dengan detektor dashboard). Alternatif: yolov8n.pt, dst.",
    )
    p.add_argument("--epochs", type=int, default=50, help="Jumlah epoch (default: 50).")
    p.add_argument("--imgsz", type=int, default=640, help="Ukuran input training (default: 640).")
    p.add_argument("--batch", type=int, default=16, help="Batch size (default: 16; kecilkan bila OOM).")
    p.add_argument(
        "--device",
        default="auto",
        help='Perangkat: "auto" (default), "cpu", atau "0" (GPU CUDA pertama).',
    )
    p.add_argument(
        "--name",
        default="gods-eye",
        help="Nama run (default: gods-eye) — hasil di <out>/<name>/weights/best.onnx.",
    )
    p.add_argument(
        "--out",
        default="runs",
        help="Folder output training (default: ./runs).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Hanya validasi struktur dataset (yaml + pasangan images/labels), tanpa training.",
    )
    return p.parse_args(argv)


def fail(msg):
    print(f"[train_yolo] GALAT: {msg}", file=sys.stderr)
    sys.exit(1)


def prepare_data(data_arg):
    """Kembalikan (dataset_yaml: Path, tmpdir | None). Extract ZIP bila perlu."""
    src = Path(data_arg)
    if not src.exists():
        fail(f"path tidak ada: {src}")
    if src.is_file():
        if not zipfile.is_zipfile(src):
            fail(f"bukan file ZIP valid: {src}")
        tmp = Path(tempfile.mkdtemp(prefix="gods-eye-dataset-"))
        with zipfile.ZipFile(src) as z:
            z.extractall(tmp)
        # dataset.yaml bisa di root ZIP atau satu folder di dalam
        cands = [tmp / "dataset.yaml", *sorted(tmp.glob("*/dataset.yaml"))]
        yaml = next((c for c in cands if c.is_file()), None)
        if yaml is None:
            fail("dataset.yaml tidak ditemukan di dalam ZIP")
        base = yaml.parent
        return base / "dataset.yaml", tmp, base
    # folder
    yaml = src / "dataset.yaml"
    if not yaml.is_file():
        fail(f"dataset.yaml tidak ditemukan di folder: {src}")
    return yaml, None, src


def validate_dataset(base):
    """Validasi jujur: yaml + pasangan images/labels. Kembalikan statistik."""
    yaml = base / "dataset.yaml"
    errors, stats = [], {"train": 0, "val": 0, "tanpa_label": [], "tanpa_gambar": []}
    try:
        import yaml as pyyaml  # opsional — fallback ke parse manual
        cfg = pyyaml.safe_load(yaml.read_text())
        names = cfg.get("names") if isinstance(cfg, dict) else None
    except ImportError:
        text = yaml.read_text()
        names = ["mobil", "motor"] if "mobil" in text and "motor" in text else None
    if not names:
        errors.append("dataset.yaml: 'names' tidak terbaca")
    for split in ("train", "val"):
        imgdir, lbldir = base / "images" / split, base / "labels" / split
        if not imgdir.is_dir():
            errors.append(f"folder hilang: images/{split}/")
            continue
        if not lbldir.is_dir():
            errors.append(f"folder hilang: labels/{split}/")
            continue
        for img in sorted(imgdir.iterdir()):
            if not img.is_file():
                continue
            lbl = lbldir / (img.stem + ".txt")
            if not lbl.is_file():
                stats["tanpa_label"].append(f"{split}/{img.name}")
                continue
            stats[split] += 1
            # validasi isi label: "<classId> 0.5 0.5 1.0 1.0"
            try:
                parts = lbl.read_text().strip().split()
                if len(parts) != 5 or not parts[0].isdigit():
                    errors.append(f"label rusak: labels/{split}/{lbl.name}")
            except OSError as e:
                errors.append(f"label tak terbaca: {lbl.name} ({e})")
    return errors, stats


def main(argv=None):
    args = parse_args(argv)
    dataset_yaml, tmpdir, base = prepare_data(args.data)
    try:
        print(f"[train_yolo] dataset: {dataset_yaml}")
        errors, stats = validate_dataset(base)
        if errors:
            for e in errors:
                print(f"[train_yolo] GALAT dataset: {e}", file=sys.stderr)
            fail("dataset tidak valid — perbaiki dulu (lihat docs/training.md)")
        print(
            f"[train_yolo] valid: train={stats['train']} val={stats['val']} "
            f"(tanpa label: {len(stats['tanpa_label'])})"
        )
        if stats["train"] == 0:
            fail("tidak ada sampel train — tambah gambar dulu via panel Kelola Dataset")
        if stats["train"] < 20:
            print(
                "[train_yolo] PERINGATAN jujur: sampel train < 20. "
                "Model mungkin overfit / tidak lebih baik dari bawaan. "
                "Target realistis: 50–200+ per kelas (docs/training.md).",
                file=sys.stderr,
            )
        if args.dry_run:
            print("[train_yolo] --dry-run: validasi selesai, tanpa training.")
            return 0

        try:
            from ultralytics import YOLO
        except ImportError:
            fail(
                "paket 'ultralytics' belum terinstall.\n"
                "  pip install ultralytics\n"
                "(menarik torch ±2 GB; di laptop tanpa GPU training akan lambat — "
                "pertimbangkan sewa GPU / Google Colab untuk dataset besar)"
            )

        device = None if args.device == "auto" else args.device
        print(f"[train_yolo] model awal: {args.model} | epochs={args.epochs} "
              f"imgsz={args.imgsz} batch={args.batch} device={args.device}")
        model = YOLO(args.model)
        results = model.train(
            data=str(dataset_yaml),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            device=device,
            name=args.name,
            project=args.out,
            exist_ok=True,
        )
        savedir = Path(results.save_dir)
        print(f"[train_yolo] training selesai → {savedir}")

        # Export ke ONNX (format yang dipakai dashboard).
        print("[train_yolo] export ke ONNX…")
        onnx_path = model.export(format="onnx", imgsz=args.imgsz)
        onnx_path = Path(onnx_path)
        print(f"[train_yolo] SELESAI: {onnx_path}")
        print(
            "[train_yolo] Langkah berikut (docs/training.md):\n"
            f"  1. Salin {onnx_path.name} ke dashboard/public/models/\n"
            "  2. Build: VITE_DETECTOR_MODEL=models/<nama>.onnx npm run build  (di dashboard/)\n"
            "  3. npm start (root) → verifikasi box di dashboard"
        )
        return 0
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
