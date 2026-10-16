// GODS EYE #73 — modul database dataset kendaraan (SQLite via node:sqlite).
//
// KEPUTUSAN ENGINE (#73, menggantikan #72): node:sqlite (modul BAWAAN Node
// >= 22.5), NOL native dependency, NOL compile.
// Alasan: better-sqlite3@13.0.3 TIDAK punya prebuilt binary untuk ABI Node 24
// → `npm install` di laptop Rama (Node v24.15.0 Windows) fallback ke
// node-gyp rebuild dari source → GAGAL karena tidak ada Visual Studio.
// node:sqlite ikut di dalam Node sendiri: `npm install` selalu sukses,
// tanpa compiler, tanpa download binary tambahan.
//
// Skema: dataset_images(id, label, mime, data, sha256 UNIQUE, source, created_at)
//   label  : 'mobil' | 'motor'
//   source : 'upload' | 'paste' | 'seed'
//   data   : BLOB biner gambar (maks 5MB, divalidasi di server.js)
//   sha256 : UNIQUE — tolak duplikat (409 dari endpoint)

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const LABELS = new Set(["mobil", "motor"]);
const SOURCES = new Set(["upload", "paste", "seed"]);

let db = null;

/** Buka (atau buat) database di dbPath. Idempoten. */
export function openDatasetDb(dbPath) {
  if (db) return db;
  if (dbPath) mkdirSync(path.dirname(dbPath), { recursive: true });
  // Tanpa argumen → database in-memory (dipakai hanya sebagai fallback aman).
  db = dbPath ? new DatabaseSync(dbPath) : new DatabaseSync();
  db.exec("PRAGMA journal_mode = WAL;");
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
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dataset_label ON dataset_images(label);`);
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
  const row = database.prepare("SELECT COUNT(*) AS c FROM dataset_images").get();
  if (Number(row?.c ?? 0) > 0) return 0;
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
    .get(Number(id));
  if (!row) return null;
  // node:sqlite mengembalikan BLOB sebagai Buffer/Uint8Array — samakan ke Buffer
  // agar pemanggil (res.send, .length) berperilaku identik.
  const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  return { id: Number(row.id), label: row.label, mime: row.mime, data, source: row.source };
}

/**
 * Hapus satu gambar. Melempar Error('SEED_PROTECTED') bila source = 'seed'.
 * Mengembalikan true bila ada yang terhapus, false bila id tidak ada.
 */
export function deleteImage(id) {
  const database = db ?? openDatasetDb();
  const row = database
    .prepare("SELECT source FROM dataset_images WHERE id = ?")
    .get(Number(id));
  if (!row) return false;
  if (row.source === "seed") throw new Error("SEED_PROTECTED");
  const info = database.prepare("DELETE FROM dataset_images WHERE id = ?").run(Number(id));
  return Number(info.changes) > 0;
}
