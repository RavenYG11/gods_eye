// #72 (16 Okt 2026, FINAL) — Klien API "Kelola Dataset" (DATABASE).
//
// Keputusan Rama (final): gambar dataset disimpan di SQLite backend
// (better-sqlite3), BUKAN file. Modul ini SATU-SATUNYA jalur frontend
// untuk baca/tulis dataset:
//
//   GET    /api/dataset            → metadata (TANPA blob)
//   POST   /api/dataset            → tambah {label, source, dataUrl}
//   GET    /api/dataset/:id/image  → biner gambar
//   DELETE /api/dataset/:id        → hapus (seed dilindungi backend)
//
// getDatasetImageUrl(id) me-cache objectURL per id — panggil
// revokeDatasetImageUrl(id) / revokeAllDatasetImageUrls() saat tidak dipakai
// (unmount panel / hapus item) agar tidak bocor memori.

export type DatasetLabel = "mobil" | "motor";
export type DatasetSource = "upload" | "paste" | "seed";

/** Metadata satu sampel (tanpa blob). */
export interface DatasetImage {
  id: number;
  label: DatasetLabel;
  mime: string;
  source: DatasetSource;
  createdAt: string;
  size: number; // byte
}

export interface DatasetList {
  items: DatasetImage[];
  counts: { mobil: number; motor: number };
}

const API_BASE = "/api/dataset";

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/** Ambil daftar metadata dataset (terbaru, tanpa blob). */
export async function listDataset(): Promise<DatasetList> {
  const res = await fetch(API_BASE, { cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, "gagal memuat dataset"));
  const body = (await res.json()) as {
    items?: DatasetImage[];
    counts?: { mobil: number; motor: number };
  };
  return {
    items: body.items ?? [],
    counts: body.counts ?? { mobil: 0, motor: 0 },
  };
}

/** Kirim 1 gambar ke backend. Menerima File/Blob ATAU {dataUrl}. */
export async function uploadDatasetImage(
  input: File | Blob | { dataUrl: string },
  label: DatasetLabel,
  source: "upload" | "paste",
): Promise<DatasetImage> {
  let dataUrl: string;
  if (input instanceof Blob) {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("gagal membaca file"));
      reader.readAsDataURL(input);
    });
  } else {
    dataUrl = input.dataUrl;
  }
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, source, dataUrl }),
  });
  if (!res.ok) throw new Error(await readError(res, "gagal menyimpan gambar"));
  const body = (await res.json()) as { id?: number };
  if (typeof body.id !== "number") throw new Error("respons backend tidak berisi id");
  // Ambil metadata baris yang baru dibuat (satu-satunya cara dapat label/mime/size).
  const list = await listDataset();
  const item = list.items.find((it) => it.id === body.id);
  if (!item) throw new Error("gambar tersimpan tapi metadata tidak ditemukan");
  return item;
}

// --- Cache objectURL per id ------------------------------------------------
const urlCache = new Map<number, string>();

/**
 * URL <img> untuk satu sampel. Hasil di-cache per id — jangan panggil
 * berulang tanpa revoke saat item dihapus / panel di-unmount.
 */
export async function getDatasetImageUrl(id: number): Promise<string> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const res = await fetch(`${API_BASE}/${id}/image`, { cache: "force-cache" });
  if (!res.ok) throw new Error(await readError(res, "gagal memuat gambar"));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

/** Bebaskan objectURL satu id (panggil setelah item dihapus). */
export function revokeDatasetImageUrl(id: number): void {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
}

/** Bebaskan semua objectURL (panggil saat panel di-unmount). */
export function revokeAllDatasetImageUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/** Hapus satu sampel (backend menolak seed → 403 diteruskan sebagai Error). */
export async function deleteDatasetImage(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res, "gagal menghapus gambar"));
  revokeDatasetImageUrl(id);
}
