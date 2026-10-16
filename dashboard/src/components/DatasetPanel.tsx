// #74 (16 Okt 2026) — Card "Kelola Dataset" ditulis ulang atas keluhan Rama:
// "abis ctrl+v kok ditampilin di frontend? kalo add banyak masa card panjang
//  ke bawah?"
//
// Perubahan #74:
//   - GRID THUMBNAIL DIHAPUS TOTAL. Tidak ada lagi render daftar gambar.
//   - Ringkasan kompak: jumlah per label + waktu tambah terakhir.
//   - Upload/paste/drag-drop tetap berfungsi; hasilnya hanya TOAST sukses
//     singkat (auto-hilang), bukan daftar.
//   - Daftar item = COLLAPSIBLE (<details>), default TERTUTUP, berisi baris
//     kompak (id, label, ukuran, tanggal, tombol hapus) TANPA thumbnail.
//   - Seed tetap tidak bisa dihapus (proteksi backend 403; tombol hapus
//     disembunyikan untuk source 'seed').
//
// Penyimpanan tetap: database SQLite backend via ../lib/dataset.ts (#72/#73).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteDatasetImage,
  listDataset,
  uploadDatasetImage,
  type DatasetImage,
  type DatasetLabel,
} from "../lib/dataset";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — selaras backend
const LABELS: DatasetLabel[] = ["mobil", "motor"];
const TOAST_MS = 4000;

interface Toast {
  kind: "ok" | "err";
  text: string;
  key: number;
}

function formatTanggal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function formatUkuran(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function DatasetPanel() {
  const [items, setItems] = useState<DatasetImage[]>([]);
  const [counts, setCounts] = useState({ mobil: 0, motor: 0 });
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState<DatasetLabel>("mobil");
  const [busy, setBusy] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ kind, text, key: Date.now() });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const list = await listDataset();
      setItems(list.items);
      setCounts(list.counts);
    } catch (err) {
      showToast(
        "err",
        err instanceof Error ? err.message : "gagal memuat dataset",
      );
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Waktu tambah terakhir (dari createdAt terbaru) — ringkasan kompak. */
  const lastAdded =
    items.length > 0
      ? items.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).createdAt
      : null;

  /** Kirim sekumpulan File gambar dengan label & sumber tertentu. */
  const submitFiles = useCallback(
    async (files: Iterable<File>, source: "upload" | "paste") => {
      const list = [...files].filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) {
        showToast("err", "tidak ada file gambar yang valid");
        return;
      }
      setBusy((b) => b + list.length);
      let okCount = 0;
      const errors: string[] = [];
      for (const file of list) {
        if (file.size > MAX_FILE_BYTES) {
          errors.push(`${file.name}: melebihi 5 MB`);
          continue;
        }
        try {
          await uploadDatasetImage(file, label, source);
          okCount++;
        } catch (err) {
          errors.push(
            `${file.name}: ${err instanceof Error ? err.message : "gagal"}`,
          );
        } finally {
          setBusy((b) => b - 1);
        }
      }
      await refresh();
      // #74: hasil upload/paste = TOAST singkat saja, tidak me-render daftar.
      if (okCount > 0) {
        showToast(
          "ok",
          `${okCount} gambar tersimpan (label: ${label}, via ${
            source === "paste" ? "paste" : "upload"
          })`,
        );
      }
      if (errors.length > 0) {
        showToast("err", errors.slice(0, 3).join(" · "));
      }
    },
    [label, refresh, showToast],
  );

  /** Ambil gambar dari clipboard (paste). */
  const handlePasteEvent = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const images: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) images.push(file);
        }
      }
      if (images.length > 0) {
        e.preventDefault();
        void submitFiles(images, "paste");
      }
    },
    [submitFiles],
  );

  // Tangkap paste dokumen selama fokus ada di dalam panel (mis. user klik
  // area paste lalu Ctrl+V — atau paste saat fokus di tombol panel).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (panelRef.current?.contains(document.activeElement)) {
        handlePasteEvent(e);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [handlePasteEvent]);

  const handleDelete = useCallback(
    async (item: DatasetImage) => {
      if (
        !window.confirm(
          `Hapus sampel #${item.id} (${item.label}) dari dataset?\nDihapus permanen dari database.`,
        )
      ) {
        return;
      }
      try {
        await deleteDatasetImage(item.id);
        await refresh();
        showToast("ok", `sampel #${item.id} dihapus`);
      } catch (err) {
        showToast(
          "err",
          err instanceof Error ? err.message : "gagal menghapus",
        );
      }
    },
    [refresh, showToast],
  );

  return (
    <aside
      className="dataset-panel"
      aria-label="Panel kelola dataset"
      ref={panelRef}
    >
      <div className="ds-head">
        <h2>Kelola Dataset</h2>
      </div>

      {/* #74: ringkasan KOMPAK — jumlah per label + waktu tambah terakhir.
          Tidak ada lagi grid thumbnail. */}
      <p className="ds-summary" aria-live="polite">
        mobil: {counts.mobil} · motor: {counts.motor}
        {lastAdded && (
          <span className="ds-last">
            {" "}
            · terakhir: {formatTanggal(lastAdded)}
          </span>
        )}
      </p>

      {/* Pemilih label — berlaku untuk upload & paste berikutnya. */}
      <div className="ds-seg" role="group" aria-label="Label kelas gambar">
        {LABELS.map((l) => (
          <button
            key={l}
            type="button"
            className={l === label ? "active" : ""}
            aria-pressed={l === label}
            onClick={() => setLabel(l)}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="ds-actions">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void submitFiles(e.target.files, "upload");
            e.target.value = ""; // boleh pilih file yang sama lagi
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={busy > 0}
          onClick={() => fileInputRef.current?.click()}
        >
          {busy > 0 ? `Mengunggah… (${busy})` : "Upload gambar"}
        </button>
      </div>

      {/* Area paste: fokus + Ctrl+V. onPaste di sini + listener dokumen
          (efek di atas) saat fokus di dalam panel. */}
      <div
        className={`ds-paste${dragOver ? " dragover" : ""}`}
        tabIndex={0}
        role="button"
        aria-label="Area paste gambar: klik lalu tekan Ctrl+V"
        onPaste={(e) => handlePasteEvent(e.nativeEvent)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0)
            void submitFiles(e.dataTransfer.files, "upload");
        }}
      >
        Klik di sini lalu <kbd>Ctrl</kbd>+<kbd>V</kbd> untuk paste screenshot
        <span className="ds-paste-sub">
          png / jpg / webp · maks 5 MB per file
        </span>
      </div>

      {/* #74: TOAST — melayang singkat, auto-hilang 4 dtk. */}
      {toast && (
        <div
          key={toast.key}
          className={`ds-toast ds-toast-${toast.kind}`}
          role={toast.kind === "err" ? "alert" : "status"}
        >
          {toast.text}
        </div>
      )}

      {/* #74: daftar item COLLAPSIBLE, default TERTUTUP — baris kompak
          TANPA thumbnail (id, label, ukuran, tanggal, hapus). */}
      {!loading && items.length > 0 && (
        <details className="ds-list">
          <summary>
            Daftar sampel ({items.length})
            <span className="ds-list-hint">klik untuk buka/tutup</span>
          </summary>
          <ul>
            {items.map((item) => {
              const isSeed = item.source === "seed";
              return (
                <li key={item.id} className="ds-row">
                  <span className="ds-row-id">#{item.id}</span>
                  <span className={`ds-row-label${isSeed ? " seed" : ""}`}>
                    {item.label}
                    {isSeed ? " · seed" : ""}
                  </span>
                  <span className="ds-row-meta">
                    {formatUkuran(item.size)} · {formatTanggal(item.createdAt)}
                  </span>
                  {!isSeed && (
                    <button
                      type="button"
                      className="ds-row-del"
                      aria-label={`Hapus sampel #${item.id}`}
                      title="Hapus dari dataset"
                      onClick={() => void handleDelete(item)}
                    >
                      Hapus
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {loading && <p className="ds-note">Memuat dataset…</p>}
      {!loading && items.length === 0 && (
        <p className="ds-note">Belum ada sampel. Upload atau paste gambar pertama.</p>
      )}

      <p className="ds-hint">
        Gambar tersimpan di <span className="mono">database SQLite</span>{" "}
        backend (<span className="mono">backend/data/dataset.db</span>, tidak
        di-commit). Sampel seed tidak bisa dihapus.
      </p>
    </aside>
  );
}
