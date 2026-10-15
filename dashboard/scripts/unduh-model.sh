#!/usr/bin/env bash
# GODS EYE #60 — Unduh bobot YOLO26n (.onnx resmi Ultralytics).
# Jalankan SEKALI dari folder dashboard/:  bash scripts/unduh-model.sh
# File TIDAK di-commit (lihat .gitignore: *.onnx) — tiap mesin unduh sendiri.
# Sumber: https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx
set -euo pipefail

URL="https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx"
DEST="$(dirname "$0")/../public/models/yolo26n.onnx"
EXPECTED=9941957

mkdir -p "$(dirname "$DEST")"
echo "[gods-eye] Mengunduh YOLO26n (~9,5 MB)..."
curl -L --fail -o "$DEST" "$URL"

SIZE=$(stat -c%s "$DEST" 2>/dev/null || stat -f%z "$DEST")
echo "[gods-eye] Selesai: $DEST ($SIZE byte, ekspektasi ~$EXPECTED)"
if [ "$SIZE" != "$EXPECTED" ]; then
  echo "[gods-eye] PERINGATAN: ukuran tidak cocok — file mungkin korup, unduh ulang bila deteksi gagal."
fi
echo "[gods-eye] Lanjut: npm run build && (cd ../backend && npm start)"
