#!/usr/bin/env node
// GODS EYE #75 — zip SELURUH folder proyek untuk arsip/backup.
//
// Cara pakai (dari folder gods_eye):
//     node scripts/zip-project.mjs
//
// Pure Node TANPA dependency (memakai ulang backend/lib/zip.js — penulis ZIP
// minimal #74). Yang dikemas = seluruh isi folder gods_eye/ KECUALI:
//   - node_modules/**   (bisa npm install ulang)
//   - .git/**            (riwayat git — bukan bagian proyek jalan)
//   - backend/data/**    (database runtime SQLite — data lokal Rama)
//   - *.zip di root proyek (agar hasil zip run sebelumnya tidak ikut
//     terkemas bila disalin ke dalam folder)
// Output: <parent>/gods_eye.zip — satu tingkat DI ATAS folder gods_eye.
// Parent dihitung dari lokasi script ini sendiri (bukan hardcode path),
// jadi tetap benar di laptop Rama maupun di VM.

import { readdirSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "../backend/lib/zip.js";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPTS_DIR); // .../gods_eye
const OUT_PATH = join(dirname(ROOT), "gods_eye.zip"); // <parent>/gods_eye.zip

// Daftar exclude — DITAMPILKAN di stdout setiap run (transparan).
const EXCLUDES = [
  "node_modules/**",
  ".git/**",
  "backend/data/**",
  "*.zip di root proyek",
];

const skipped = {
  "node_modules/**": 0,
  ".git/**": 0,
  "backend/data/**": 0,
  "*.zip di root proyek": 0,
  symlink: 0,
};

/** true bila path relatif (format '/') masuk salah satu pola exclude. */
function excludeReason(rel) {
  const parts = rel.split("/");
  if (parts.includes("node_modules")) return "node_modules/**";
  if (parts.includes(".git")) return ".git/**";
  if (rel === "backend/data" || rel.startsWith("backend/data/"))
    return "backend/data/**";
  // *.zip di root proyek — pengaman bila hasil run lama disalin ke dalam.
  if (/^[^/]+\.zip$/i.test(rel)) return "*.zip di root proyek";
  return null;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs).split(sep).join("/");
    const reason = excludeReason(rel);
    if (reason) {
      skipped[reason]++;
      continue;
    }
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      skipped.symlink++; // symlink tidak diikuti — arsip harus portabel
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, out);
    } else if (st.isFile()) {
      // Pengaman ganda: jangan kemas file output itu sendiri.
      if (abs === OUT_PATH) continue;
      out.push({ name: rel, data: readFileSync(abs) });
    }
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const files = [];
walk(ROOT, files);
const totalBytes = files.reduce((a, f) => a + f.data.length, 0);
const zipBuf = createZip(files);
writeFileSync(OUT_PATH, zipBuf);

console.log("GODS EYE — zip proyek");
console.log(`Root   : ${ROOT}`);
console.log(`Output : ${OUT_PATH}`);
console.log("Exclude yang dipakai:");
for (const e of EXCLUDES) {
  console.log(`  - ${e}  (${skipped[e]} entri dilewati)`);
}
if (skipped.symlink > 0) console.log(`  - symlink  (${skipped.symlink} dilewati)`);
console.log(`Berkas dikemas : ${files.length} (${fmtBytes(totalBytes)})`);
console.log(`Ukuran hasil zip: ${fmtBytes(zipBuf.length)} (${zipBuf.length} bytes)`);
