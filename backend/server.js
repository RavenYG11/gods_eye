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
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
