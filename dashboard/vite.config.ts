import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Rujukan: docs/arsitektur.md §3 — base './' agar bisa disajikan dari
// subfolder, mis. http://localhost/gods-eye/ (deploy default: localhost).
//
// server.proxy (fix bug CORS #58, 2026-10-15):
// request HLS via hls.js dari origin http://localhost:5173 diblokir browser
// (CORS — server tidak mengirim Access-Control-Allow-Origin), padahal URL
// yang sama dibuka langsung di tab → video LIVE. Maka saat DEV, app memakai
// URL same-origin "/cctv/backupcctv/m3/….m3u8"; Vite meneruskannya ke
// https://eofficev2.bekasikota.go.id → browser tidak kena CORS.
// Lihat getStreamUrl() di src/config/cameras.ts.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    proxy: {
      "/cctv": {
        target: "https://eofficev2.bekasikota.go.id",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cctv/, ""),
      },
    },
  },
});
