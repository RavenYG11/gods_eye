// Menyalin file .wasm ONNX Runtime dari node_modules ke public/ort/
// agar ikut ke dist/ saat `npm run build` (offline, tanpa CDN).
//
// Kenapa tidak dibundle Vite? onnxruntime-web memuat .wasm saat runtime via
// ort.env.wasm.wasmPaths — file-nya harus tersedia sebagai aset statis.
// Dijalankan otomatis via "prebuild" di package.json.

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "node_modules", "onnxruntime-web", "dist");
const dstDir = join(here, "..", "public", "ort");

mkdirSync(dstDir, { recursive: true });
// File yang dibutuhkan loader ORT saat runtime: .wasm (biner) + .mjs (glue
// Emscripten — loader melakukan dynamic import "<nama>.mjs" dari wasmPaths).
// Ditemukan via uji headless #60: tanpa .mjs → "no available backend found".
const files = readdirSync(srcDir).filter(
  (f) =>
    f.endsWith(".wasm") ||
    (f.startsWith("ort-wasm-") && f.endsWith(".mjs")),
);
if (files.length === 0) {
  console.error("[copy-ort-wasm] TIDAK ada .wasm di", srcDir);
  process.exit(1);
}
for (const f of files) {
  copyFileSync(join(srcDir, f), join(dstDir, f));
  console.log("[copy-ort-wasm]", f);
}
console.log(`[copy-ort-wasm] OK — ${files.length} file → public/ort/`);
