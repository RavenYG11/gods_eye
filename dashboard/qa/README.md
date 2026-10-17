# QA — Uji Unit Node (tanpa browser)

Uji logika murni modul deteksi. Dijalankan via `./run.sh` (kompilasi
TypeScript → ESM di `.tmp-test/`, lalu `node`).

## tracker.test.cjs (15 uji)
- **Skenario A (#75 regresi)**: 12 frame @1fps, objek 250px/dtk → 1 ID stabil,
  velocity konvergen, `framePts` = waktu update kini (anti prediksi ganda, bug C).
- **Bug C**: track hilang < graceSec tetap dirender sebagai `stale` dengan
  framePts kini; > graceSec tak dirender; > maxTimeLostSec dihapus → ID baru.
- **Gate**: dt dijepit 2 dtk (jeda 30 dtk tak asosiasi liar); gate relatif ukuran
  (`distGateSizeFactor=3`) — objek kecil tak dapat gate raksasa.
- **Arah**: gerak ke atas terklasifikasi `atas`.
- **parseYolo26nOutput**: hanya kelas COCO car=2 → `mobil`, motorcycle=3 → `motor`;
  person/truck/dll dibuang; classId dipertahankan.

## inflight.test.cjs (regresi bug FATAL #76)
Bug: `finally { inflight = false }` di `workerDetector.detect()` berjalan untuk
SEMUA panggilan termasuk yang di-skip guard → tick genap (di-skip) me-reset
inflight milik tick ganjil yang sedang inferensi → tick berikutnya lolos guard →
slot `pending` tertimpa ID baru → SEMUA hasil worker jadi "basi" (`p.id !== msg.id`)
dan dibuang → deteksi tak pernah tampil (ok=0 selamanya).
Perbaikan: flag lokal `releaseInflight` — hanya panggilan yang memasang inflight
boleh melepasnya.
Uji memverifikasi dengan Worker mock: panggilan 2 & 3 tetap di-skip saat
panggilan 1 in-flight; hasil worker ID cocok diterima (tidak basi); panggilan
baru jalan setelah yang lama selesai.
