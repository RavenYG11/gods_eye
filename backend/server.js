// GODS EYE v0.1 — backend fullstack (Assignment #59, Gunet, 15 Okt 2026).
//
// Satu server Node.js/Express yang melayani DUA hal:
//   1. REVERSE PROXY  GET /cctv/*  →  https://eofficev2.bekasikota.go.id/*
//      Menyelesaikan bug CORS secara PERMANEN di semua environment: browser
//      hanya request ke origin yang sama (same-origin), server backend yang
//      meneruskannya ke server CCTV. Request HLS (.m3u8, segmen .ts, dll)
//      diteruskan apa adanya — isi tidak diubah.
//   2. FILE STATIS frontend dari ../dashboard/dist (hasil `npm run build`)
//      → satu server melayani app + proksi = CORS hilang total.
//
// #60: header COOP/COEP (cross-origin isolation) — WAJIB untuk ONNX Runtime
// WASM multi-thread (SharedArrayBuffer). Pola yang sama dipakai Ventra
// (vite.config.ts + .htaccess, pelajaran 2026-10-14). Semua aset same-origin
// sehingga COEP require-corp aman di sini.
//
// Cara jalan:  cd backend && npm install && npm start
//              → buka http://localhost:3000
//
// Rujukan: docs/runbook.md §1 (diagram arsitektur), §4 (cara jalan).

import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import https from "node:https";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addImage,
  deleteImage,
  getImage,
  listImages,
  openDatasetDb,
  seedIfEmpty,
} from "./lib/dataset-db.js";

// ---------------------------------------------------------------------------
// Konfigurasi (bisa dioverride via environment variable)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3000);
const UPSTREAM =
  process.env.CCTV_UPSTREAM ?? "https://eofficev2.bekasikota.go.id";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Folder hasil build frontend: gods_eye/dashboard/dist
const DIST_DIR = path.resolve(__dirname, "..", "dashboard", "dist");

const app = express();

// ---------------------------------------------------------------------------
// #60: Cross-origin isolation (COOP + COEP) — syarat SharedArrayBuffer untuk
// ONNX Runtime WASM multi-thread (deteksi kendaraan). Tanpa ini, ORT
// otomatis turun ke 1 thread (atau gagal total di versi baru).
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// ---------------------------------------------------------------------------
// 1) Reverse proxy: /cctv/* → <UPSTREAM>/*
//    Contoh: /cctv/backupcctv/m3/kamera.m3u8
//         → https://eofficev2.bekasikota.go.id/backupcctv/m3/kamera.m3u8
// ---------------------------------------------------------------------------
app.use(
  "/cctv",
  createProxyMiddleware({
    target: UPSTREAM,
    changeOrigin: true, // Host header disesuaikan ke upstream
    pathRewrite: { "^/cctv": "" }, // buang prefix /cctv
    logLevel: "warn",
    // #66 (15 Okt 2026) — AKAR BUFFERING (a): tanpa `agent` eksplisit,
    // http-proxy mengirim tiap request upstream dengan `Connection: close`
    // + agent:false → SETIAP poll .m3u8 (±2–4 dtk) dan SETIAP segmen .ts
    // membayar handshake TCP+TLS baru + slow-start dari nol. Itulah kenapa
    // .ts ±841KB makan 2–3 dtk via proksi padahal URL asli (koneksi
    // keep-alive) lancar. Dengan https.Agent keep-alive, koneksi ke upstream
    // dipakai ulang → handshake & slow-start hanya sekali.
    // (Diverifikasi di node_modules/http-proxy/lib/http-proxy/common.js:
    //  `outgoing.agent = options.agent || false`, lalu `Connection: close`
    //  dipaksa bila agent falsy.)
    agent: new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 }),
  }),
);

// ---------------------------------------------------------------------------
// 2) Health check — untuk memastikan backend hidup (dipakai runbook §7)
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "gods-eye-backend",
    version: "0.1.0",
    upstream: UPSTREAM,
    frontendBuilt: existsSync(path.join(DIST_DIR, "index.html")),
  });
});

// ---------------------------------------------------------------------------
// #72 (16 Okt 2026, FINAL — keputusan Rama: gambar disimpan di DATABASE
// SQLite, BUKAN file).
// #73 (16 Okt 2026 — engine diganti better-sqlite3 → node:sqlite bawaan Node
// >= 22.5: better-sqlite3@13.0.3 tidak punya prebuilt untuk ABI Node 24,
// `npm install` di laptop Rama gagal total tanpa Visual Studio).
//   POST   /api/dataset            → tambah 1 sampel {label, source, dataUrl}
//   GET    /api/dataset            → {ok, items, counts} (metadata TANPA blob)
//   GET    /api/dataset/:id/image  → biner gambar (Content-Type asli)
//   DELETE /api/dataset/:id        → hapus 1 sampel (seed dilindungi)
// DB: backend/data/dataset.db (di-gitignore; dibuat otomatis). Seed-on-first-run
// mengimpor motor-1.png & mobil-1.png dari public/dataset/ bila tabel kosong.
// BLOB maks 5 MB, duplikat (sha256) → 409. Tidak menyentuh proxy /cctv/*.
// ---------------------------------------------------------------------------
const MAX_DATASET_BYTES = 5 * 1024 * 1024; // 5 MB per gambar
const DATASET_MIME_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/;
const DATASET_LABELS = new Set(["mobil", "motor"]);
const DATASET_SOURCES = new Set(["upload", "paste"]);

/** Validasi + decode dataUrl → {mime, bytes}. Lempar Error bila tak valid. */
function decodeDatasetDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("dataUrl wajib string base64 data URL");
  const m = DATASET_MIME_RE.exec(dataUrl.trim());
  if (!m) throw new Error("dataUrl bukan gambar valid (hanya png/jpg/webp base64)");
  const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) throw new Error("dataUrl kosong / base64 tidak valid");
  if (bytes.length > MAX_DATASET_BYTES) {
    throw new Error(
      `ukuran ${(bytes.length / 1048576).toFixed(1)} MB melebihi batas 5 MB per file`,
    );
  }
  return { mime: m[1], bytes };
}

const DATASET_DB_PATH = path.resolve(__dirname, "data", "dataset.db");
openDatasetDb(DATASET_DB_PATH);
// Seed dari public/dataset/ (dev) atau dist/dataset/ (production build).
const seeded = seedIfEmpty([
  path.join(DIST_DIR, "dataset"),
  path.resolve(__dirname, "..", "dashboard", "public", "dataset"),
]);
if (seeded > 0) console.log(`[gods-eye] dataset: seed ${seeded} sampel awal dari PNG`);

// Body JSON sampai ±12 MB hanya untuk /api/dataset (5 MB gambar → ±6,7 MB base64).
app.use("/api/dataset", express.json({ limit: "12mb" }));

app.get("/api/dataset", (_req, res) => {
  try {
    const items = listImages();
    const counts = { mobil: 0, motor: 0 };
    for (const it of items) counts[it.label] = (counts[it.label] ?? 0) + 1;
    res.json({ ok: true, items, counts });
  } catch (err) {
    console.error("[gods-eye] dataset GET gagal:", err.message);
    res.status(500).json({ ok: false, error: "gagal membaca dataset" });
  }
});

app.post("/api/dataset", (req, res) => {
  try {
    const { label, source, dataUrl } = req.body ?? {};
    if (!DATASET_LABELS.has(label)) {
      return res.status(400).json({ ok: false, error: 'label wajib "mobil" atau "motor"' });
    }
    if (!DATASET_SOURCES.has(source)) {
      return res.status(400).json({ ok: false, error: 'source wajib "upload" atau "paste"' });
    }
    const { mime, bytes } = decodeDatasetDataUrl(dataUrl);
    const { id } = addImage({ label, mime, data: bytes, source });
    console.log(`[gods-eye] dataset: + id=${id} (${label}, ${source})`);
    res.status(201).json({ ok: true, id });
  } catch (err) {
    if (err?.message === "DUPLICATE") {
      return res.status(409).json({ ok: false, error: "duplikat: gambar ini sudah ada di dataset" });
    }
    console.error("[gods-eye] dataset POST gagal:", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/dataset/:id/image", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "id tidak valid" });
  }
  try {
    const row = getImage(id);
    if (!row) return res.status(404).json({ ok: false, error: "gambar tidak ditemukan" });
    res.setHeader("Content-Type", row.mime);
    res.setHeader("Content-Length", String(row.data.length));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(row.data);
  } catch (err) {
    console.error("[gods-eye] dataset image gagal:", err.message);
    res.status(500).json({ ok: false, error: "gagal membaca gambar" });
  }
});

app.delete("/api/dataset/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "id tidak valid" });
  }
  try {
    const removed = deleteImage(id); // SEED_PROTECTED bila source='seed' (#73)
    if (!removed) return res.status(404).json({ ok: false, error: "gambar tidak ditemukan" });
    console.log(`[gods-eye] dataset: - id=${id}`);
    res.json({ ok: true, removed: id });
  } catch (err) {
    if (err?.message === "SEED_PROTECTED") {
      return res.status(403).json({ ok: false, error: "sampel seed tidak bisa dihapus via API" });
    }
    console.error("[gods-eye] dataset DELETE gagal:", err.message);
    res.status(500).json({ ok: false, error: "gagal menghapus gambar" });
  }
});

// ---------------------------------------------------------------------------
// 3) Serve file statis frontend (hasil `npm run build` di dashboard/)
// ---------------------------------------------------------------------------
if (!existsSync(path.join(DIST_DIR, "index.html"))) {
  console.warn(
    `[gods-eye] PERINGATAN: ${DIST_DIR} belum ada — ` +
      `jalankan dulu "npm run build" di folder dashboard/.`,
  );
}
app.use(express.static(DIST_DIR));

// SPA fallback: path apa pun yang bukan file/statis/proxy → index.html
// (v0.1 hanya 1 halaman; ini jaga-jaga agar refresh di path dalam tidak 404)
app.get("*", (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[gods-eye] backend jalan di http://localhost:${PORT}`);
  console.log(`[gods-eye] proksi CCTV : /cctv/*  →  ${UPSTREAM}/*`);
  console.log(`[gods-eye] frontend     : ${DIST_DIR}`);
});
