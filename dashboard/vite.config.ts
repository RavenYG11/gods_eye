import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Rujukan: docs/arsitektur.md §3 — base './' agar bisa disajikan dari
// subfolder, mis. http://localhost/gods-eye/ (deploy default: localhost).
export default defineConfig({
  plugins: [react()],
  base: "./",
});
