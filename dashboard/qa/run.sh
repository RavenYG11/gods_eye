#!/bin/bash
# Uji unit Node untuk logika deteksi GODS EYE (tanpa DOM/browser).
# Mengkompilasi modul deteksi TypeScript ke ESM lalu menjalankan uji.
# Penggunaan: ./run.sh   (dari direktori ini)
set -e
cd "$(dirname "$0")"
OUT="./.tmp-test"
rm -rf "$OUT"
mkdir -p "$OUT"
# Kompilasi modul yang dibutuhkan uji (emit saja, tanpa type-check penuh).
npx tsc ../src/detection/tracker.ts ../src/detection/yolo26n.ts \
        ../src/detection/types.ts ../src/detection/vehicleConfig.ts \
        ../src/detection/workerDetector.ts ../src/detection/workerProtocol.ts \
  --outDir "$OUT" --module es2020 --target es2020 --moduleResolution bundler \
  --skipLibCheck 2>&1 | grep -v "TS1343\|TS2339" | head -5 || true
# tsc tak menulis ulang import relatif tanpa ekstensi → tambahkan .js untuk Node ESM.
for f in "$OUT"/*.js; do
  sed -i -E 's#from "\./([a-zA-Z0-9_]+)"#from "./\1.js"#g' "$f"
done
# Tes ditulis sebagai ESM (.mjs) agar import.meta di vehicleConfig valid.
for t in tracker inflight; do
  sed -E 's#require\("\./([a-zA-Z0-9]+)\.js"\)#await import("./\1.js")#g;
          s#require\("node:assert"\)#await import("node:assert")#g' \
    "$t.test.cjs" > "$OUT/$t.test.mjs"
done
echo "=== tracker.test ==="
node "$OUT/tracker.test.mjs"
echo ""
echo "=== inflight.test (regresi bug fatal #76) ==="
node "$OUT/inflight.test.mjs"
