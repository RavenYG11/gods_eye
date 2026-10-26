// GODS EYE: same-origin HLS proxy and dashboard static server.
// Playback and detection policy: docs/optimisasi-2026-10-24.md.

import express from "express";
import { createStreamProxy } from "./lib/stream-proxy.js";
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
app.disable("x-powered-by");

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
const streamProxy = createStreamProxy(UPSTREAM);
app.use("/cctv", streamProxy.middleware);

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
    stream: streamProxy.snapshot(),
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
app.use(express.static(DIST_DIR, {
  setHeaders(res, filename) {
    if (/\.(onnx|wasm)$/.test(filename)) res.setHeader("Cache-Control", "private, max-age=3600");
    if (filename.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  },
}));
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Endpoint tidak ditemukan." }));
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("[gods-eye] request gagal:", err.message);
  res.status(500).json({ ok: false, error: "Request tidak dapat diproses." });
});

// SPA fallback: path apa pun yang bukan file/statis/proxy → index.html
// (v0.1 hanya 1 halaman; ini jaga-jaga agar refresh di path dalam tidak 404)
app.get("*", (req, res) => {
  if (path.extname(req.path)) return res.status(404).send("File tidak ditemukan.");
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// ---------------------------------------------------------------------------
const server = app.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`[gods-eye] backend jalan di http://localhost:${server.address().port}`);
  console.log(`[gods-eye] proksi CCTV : /cctv/*  →  ${UPSTREAM}/*`);
  console.log(`[gods-eye] frontend     : ${DIST_DIR}`);
});
server.requestTimeout = 30000;
server.headersTimeout = 35000;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  streamProxy.close();
  server.close(() => { process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
});
