// Entri "Log koneksi" — panel di bawah video player (instruksi eksplisit
// Rama, 15 Okt 2026): menampilkan EVENT NYATA dari player hls.js, bukan
// simulasi. Setiap entri dicatat dengan timestamp WIB.

export type LogLevel = "info" | "ok" | "warn" | "error";

export interface LogEntry {
  id: number;
  /** Epoch ms saat event dicatat. */
  t: number;
  level: LogLevel;
  msg: string;
}

let nextId = 1;

export function makeLogEntry(level: LogLevel, msg: string): LogEntry {
  return { id: nextId++, t: Date.now(), level, msg };
}

/** "15/10 09:58:12" dalam zona Asia/Jakarta. */
export function formatWaktuWIB(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, "0");
  // Dihitung manual dari UTC agar tidak bergantung pada locale runtime.
  const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return `${p(wib.getUTCDate())}/${p(wib.getUTCMonth() + 1)} ${p(wib.getUTCHours())}:${p(wib.getUTCMinutes())}:${p(wib.getUTCSeconds())}`;
}

/** "09:58:12 WIB" — untuk jam header & OSD ala CCTV. */
export function formatJamWIB(epochMs: number): string {
  const wib = new Date(epochMs + 7 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(wib.getUTCHours())}:${p(wib.getUTCMinutes())}:${p(wib.getUTCSeconds())} WIB`;
}
