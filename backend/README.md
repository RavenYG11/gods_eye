# Backend GODS EYE

Node.js/Express menyajikan dashboard dan proxy HLS pada satu origin.
Dari root proyek: `npm run build`, lalu `npm start`.

| Path | Fungsi |
|---|---|
| `/cctv/*` | Proxy ke CCTV Bekasi, keep-alive, timeout, rewrite playlist, cache segmen maksimal 64 MB |
| `/api/health` | Status backend dan statistik proxy |
| `/*` | Dashboard hasil build di dashboard/dist; file yang tidak ditemukan mendapat 404 |

Environment: `PORT` (3000), `HOST` (127.0.0.1),
`CCTV_UPSTREAM` (https://eofficev2.bekasikota.go.id).
Mode development Vite meneruskan /cctv dan /api ke backend port 3000.
COOP/COEP mengaktifkan isolasi untuk runtime deteksi browser.

Dataset API dan SQLite runtime sudah dihapus. Seluruh /api/dataset mendapat 404.
Database lama di backend/data tidak dibuka, diubah, atau dihapus.
Rujuk [README proyek](../README.md) untuk kebijakan playback dan tracking.
