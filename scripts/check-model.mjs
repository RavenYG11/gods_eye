// GODS EYE — pengingat model deteksi (bagian dari `npm run setup`).
// yolo26n.onnx TIDAK di-commit (bobot model, lihat .gitignore) — wajib
// diunduh SEKALI via dashboard/scripts/unduh-model.bat (Windows) atau
// dashboard/scripts/unduh-model.sh (Linux/Mac) SEBELUM build pertama.
// Script ini hanya MENGINGATKAN (exit 0 selalu — tidak menggagalkan setup).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = path.join(root, "dashboard", "public", "models", "yolo26n.onnx");

if (!existsSync(model)) {
  console.warn("");
  console.warn("[gods-eye] PERINGATAN: model deteksi belum ada:");
  console.warn(`[gods-eye]   ${model}`);
  console.warn("[gods-eye] Unduh SEKALI saja, lalu ulangi setup:");
  console.warn("[gods-eye]   Windows : dashboard\\scripts\\unduh-model.bat");
  console.warn("[gods-eye]   Linux/Mac: bash dashboard/scripts/unduh-model.sh");
  console.warn("[gods-eye] Tanpa model, deteksi kendaraan nonaktif (stream tetap jalan).");
  console.warn("");
}
