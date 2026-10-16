// GODS EYE #72 — modul database dataset kendaraan (SQLite via better-sqlite3).
//
// KEPUTUSAN ENGINE (#72, Gunet): better-sqlite3, bukan node:sqlite bawaan.
// Alasan: node:sqlite butuh Node >= 22.5 — versi Node di laptop Windows Rama
// tidak terverifikasi; better-sqlite3 jalan di Node 18/20/22/24 dan membawa
// prebuilt binary Windows sehingga `npm install` biasa cukup (tanpa compile).
// API sinkron → kode sederhana, tanpa dependency selain better-sqlite3.
//
// Skema: dataset_images(id, label, mime, data, sha256 UNIQUE, source, created_at)
//   label  : 'mobil' | 'motor'
//   source : 'upload' | 'paste' | 'seed'
//   data   : BLOB biner gambar (maks 5MB, divalidasi di server.js)
//   sha256 : UNIQUE — tolak duplikat diam-diam (409 dari endpoint)

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const LABELS = new Set(["mobil", "motor"]);
const SOURCES = new Set(["upload", "paste", "seed"]);

let db = null;

/** Buka (atau buat) database di dbPath. Idempoten. */
export function openDatasetDb(dbPath) {
  if (db) return db;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS dataset_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL CHECK (label IN ('mobil','motor')),
      mime       TEXT NOT NULL,
      data       BLOB NOT NULL,
      sha256     TEXT NOT NULL UNIQUE,
      source     TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','paste','seed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dataset_label ON dataset_images(label);
  `);
  return db;
}

/** sha256 hex dari buffer — dipakai untuk dedup. */
export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Seed-on-first-run: bila tabel kosong, import motor-1.png & mobil-1.png
 * dari folder dataset (dist/dataset/ saat production, dashboard/public/dataset/
 * saat dev). Gagal baca file = lewati diam-diam (seed manual Rama via UI).
 * Mengembalikan jumlah yang berhasil diimport.
 */
export function seedIfEmpty(searchDirs) {
  const database = db ?? openDatasetDb();
  const { c } = database.prepare("SELECT COUNT(*) AS c FROM dataset_images").get();
  if (c > 0) return 0;
  let imported = 0;
  for (const label of ["motor", "mobil"]) {
    const fname = `${label}-1.png`;
    const found = searchDirs.map((d) => path.join(d, fname)).find(existsSync);
    if (!found) continue;
    try {
      const data = readFileSync(found);
      addImage({ label, mime: "image/png", data, source: "seed" });
      imported++;
    } catch {
      // file rusak/tidak terbaca — lewati, seed bisa ditambah manual via UI
    }
  }
  return imported;
}

/** Simpan satu gambar. Melempar Error('DUPLICATE') bila sha256 sudah ada. */
export function addImage({ label, mime, data, source = "upload" }) {
  if (!LABELS.has(label)) throw new Error("LABEL_INVALID");
  if (!SOURCES.has(source)) throw new Error("SOURCE_INVALID");
  const database = db ?? openDatasetDb();
  const hash = sha256Hex(data);
  try {
    const info = database
      .prepare(
        "INSERT INTO dataset_images (label, mime, data, sha256, source) VALUES (?,?,?,?,?)",
      )
      .run(label, mime, data, hash, source);
    return { id: Number(info.lastInsertRowid), sha256: hash };
  } catch (err) {
    if (String(err?.message ?? err).includes("UNIQUE constraint failed")) {
      throw new Error("DUPLICATE");
    }
    throw err;
  }
}

/** Daftar metadata TANPA blob — untuk GET /api/dataset. */
export function listImages() {
  const database = db ?? openDatasetDb();
  return database
    .prepare(
      `SELECT id, label, mime, source, created_at AS createdAt,
              length(data) AS size FROM dataset_images ORDER BY id ASC`,
    )
    .all()
    .map((r) => ({ ...r, id: Number(r.id), size: Number(r.size) }));
}

/** Ambil satu baris lengkap termasuk blob. null bila tidak ada. */
export function getImage(id) {
  const database = db ?? openDatasetDb();
  const row = database
    .prepare("SELECT id, label, mime, data, source FROM dataset_images WHERE id = ?")
    .get(id);
  return row ? { ...row, id: Number(row.id) } : null;
}

/** Hapus satu gambar. true bila ada yang terhapus. */
export function deleteImage(id) {
  const database = db ?? openDatasetDb();
  return database.prepare("DELETE FROM dataset_images WHERE id = ?").run(id).changes > 0;
}
