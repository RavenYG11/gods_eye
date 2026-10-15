// GODS EYE v0.1 — App utama.
// Layout (atas → bawah), rujukan docs/mockup-dashboard.html VARIAN 1
// (pilihan Rama) + panel "Log koneksi" di BAWAH video player:
//   1. Header minimal — wordmark + jam WIB + chip "localhost"
//   2. Player 16:9 (StreamPlayer)
//   3. Log koneksi — full-width horizontal, event nyata hls.js
//   4. Bar info kamera — CameraSelector (disabled, 1 item)
// Pagar §5: tanpa panel deteksi, tanpa tombol record, tanpa face recognition.

import { useEffect, useState } from "react";
import { CAMERAS } from "./config/cameras";
import { formatJamWIB } from "./lib/log";
import { useStreamSession } from "./lib/useStreamSession";
import { CameraSelector } from "./components/CameraSelector";
import { ConnectionLog } from "./components/ConnectionLog";
import { StreamPlayer } from "./components/StreamPlayer";
import "./styles.css";

const HARI = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];
const BULAN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

/** "Kamis, 15 Okt 2026" dalam WIB — dihitung manual dari UTC. */
function formatTanggalWIB(epochMs: number): string {
  const wib = new Date(epochMs + 7 * 60 * 60 * 1000);
  return `${HARI[wib.getUTCDay()]}, ${wib.getUTCDate()} ${BULAN[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`;
}

export default function App() {
  const camera = CAMERAS[0]; // v0.1 dikunci 1 kamera
  const session = useStreamSession(camera);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <header>
        <div className="brand">
          <span className="dot" aria-hidden="true" />
          GODS EYE
          <span className="pill">v0.1</span>
        </div>
        <div className="head-right">
          <span className="pill">localhost</span>
          <div id="clock" aria-label="Jam saat ini">
            <small>
              {formatTanggalWIB(now)} WIB
            </small>
            <span>{formatJamWIB(now).replace(" WIB", "")}</span>
          </div>
        </div>
      </header>

      <main>
        <StreamPlayer session={session} camera={camera} />

        <ConnectionLog entries={session.snap.log} />

        <section className="cam-bar" aria-label="Informasi kamera">
          <CameraSelector />
          <div className="chips" aria-label="Spesifikasi stream">
            <span className="chip">1080p</span>
            <span className="chip">HLS</span>
            <span className="chip">60fps</span>
          </div>
        </section>

        <footer>
          GODS EYE v0.1 — viewer 1 kamera CCTV Kota Bekasi · frontend-only,
          tanpa backend
          <br />
          Acuan: <span className="mono">docs/arsitektur.md</span> (Sentot, #49)
          · visual: <span className="mono">docs/mockup-dashboard.html</span>{" "}
          (Prapto, #50 — varian 1 pilihan Rama)
        </footer>
      </main>
    </>
  );
}
