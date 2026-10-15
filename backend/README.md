# Backend GODS EYE v0.1 — reverse proxy + static server

Satu server Node.js/Express (Assignment **#59**, Gunet, 15 Okt 2026) yang membuat
GODS EYE **fullstack**: browser hanya bicara ke satu origin, sehingga masalah
**CORS hilang permanen** di semua environment (dev maupun production).

## Yang dilakukan server

| Path | Tujuan |
|---|---|
| `GET /cctv/*` | **Reverse proxy** → `https://eofficev2.bekasikota.go.id/*` (prefix `/cctv` dibuang). Meneruskan request HLS apa adanya: `.m3u8`, segmen `.ts`, dll. **Keep-alive ke upstream WAJIB (#66):** `https.Agent({ keepAlive: true })` — tanpa ini http-proxy memaksa `Connection: close` + agent:false sehingga tiap segmen .ts membayar handshake TLS + slow-start baru (terbukti: .ts ±841KB makan 2–3 dtk via proksi). |
| `GET /api/health` | Health check JSON (`ok`, `upstream`, `frontendBuilt`). |
| `GET /*` (lainnya) | File statis dari `../dashboard/dist` (hasil build frontend) + fallback `index.html`. |

Diagram:

```
Browser ──HTTP──▶ backend (Express, :3000)
  ├─ /            → file statis dashboard/dist  (satu origin → bebas CORS)
  └─ /cctv/*.m3u8 → proksi ──HTTPS──▶ eofficev2.bekasikota.go.id
```

## Cara jalan

```bash
# 1. Build frontend dulu (sekali saja per perubahan dashboard)
cd dashboard
npm install
npm run build        # → dashboard/dist/

# 2. Jalanin backend
cd ../backend
npm install
npm start            # → http://localhost:3000
```

Buka **http://localhost:3000** — badge harus ● LIVE (dari jaringan rumah;
server CCTV memblokir IP data center/VM).

## Mode dev (ngoding dashboard)

Untuk iterasi UI cepat, tetap bisa pakai Vite dev-server (hot reload):

```bash
cd dashboard
npm run dev          # → http://localhost:5173 (proksi /cctv ada di vite.config.ts)
```

Frontend selalu memakai path relatif `/cctv/…` (lihat
`dashboard/src/config/cameras.ts`), sehingga **kedua mode jalan tanpa ubah kode**:
dev → proksi Vite, production → proksi backend ini.

## Environment variable (opsional)

| Nama | Default | Fungsi |
|---|---|---|
| `PORT` | `3000` | Port backend |
| `CCTV_UPSTREAM` | `https://eofficev2.bekasikota.go.id` | Target proksi (ganti bila URL CCTV pindah) |

Contoh: `PORT=8080 npm start`

## Batasan yang diketahui (jujur)

- **Stream tidak bisa dites dari VM/server** (WAF server CCTV memblokir IP data
  center) — "video tampil" **wajib diverifikasi Rama di laptop** (checklist
  `docs/runbook.md` §7).
- Bila isi `.m3u8` berisi URL segmen **absolut** (bukan relatif), hls.js akan
  request segmen langsung ke upstream → kena CORS lagi. Backend ini sengaja
  **tidak** me-rewrite isi playlist (scope minimal, tanpa over-engineering).
  Bila terbukti jadi masalah di laptop Rama, solusinya: tambahkan rewrite
  playlist di proksi — laporkan dulu ke manager, jangan diam-diam.
