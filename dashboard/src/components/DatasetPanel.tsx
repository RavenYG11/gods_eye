// #72 (16 Okt 2026, FINAL) — Card "Kelola Dataset" di kolom kanan,
// DI BAWAH card "Deteksi kendaraan".
//
// Keputusan Rama (final): gambar disimpan di DATABASE SQLite backend
// (better-sqlite3), BUKAN file. Panel ini memakai SATU-SATUNYA modul
// frontend: ../lib/dataset.ts (GET metadata, GET /:id/image → objectURL,
// POST, DELETE). Seed (source 'seed') tampil tapi TIDAK bisa dihapus
// (backend menolak dengan 403).
//
// Dua cara tambah sampel: (1) upload file (multiple, accept="image/*");
// (2) paste gambar (klik area paste lalu Ctrl+V — juga menangkap event
// paste dokumen selama fokus ada di dalam panel; bonus drag-and-drop).
// Setiap gambar wajib berlabel "mobil"/"motor" (default "mobil").

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteDatasetImage,
  getDatasetImageUrl,
  listDataset,
  revokeAllDatasetImageUrls,
  revokeDatasetImageUrl,
  uploadDatasetImage,
  type DatasetImage,
  type DatasetLabel,
} from "../lib/dataset";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — selaras backend
const LABELS: DatasetLabel[] = ["mobil", "motor"];

interface Msg {
  kind: "ok" | "err";
  text: string;
}

export function DatasetPanel() {
  const [items, setItems] = useState<DatasetImage[]>([]);
  const [counts, setCounts] = useState({ mobil: 0, motor: 0 });
  const [urls, setUrls] = useState<ReadonlyMap<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState<DatasetLabel>("mobil");
  const [busy, setBusy] = useState(0);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [broken, setBroken] = useState<ReadonlySet<number>>(new Set());
  const panelRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  const refresh = useCallback(async () => {
    try {
      const list = await listDataset();
      setItems(list.items);
      setCounts(list.counts);
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "gagal memuat dataset" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => revokeAllDatasetImageUrls();
  }, [refresh]);

  // Muat objectURL thumbnail untuk item yang belum punya (lazy, cache di modul).
  useEffect(() => {
    let cancelled = false;
    const missing = items.filter((it) => !urlsRef.current.has(it.id));
    if (missing.length === 0) return;
    void (async () => {
      const next = new Map(urlsRef.current);
      for (const it of missing) {
        try {
          next.set(it.id, await getDatasetImageUrl(it.id));
        } catch {
          setBroken((prev) => new Set(prev).add(it.id));
        }
        if (cancelled) return;
      }
      setUrls(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  /** Kirim sekumpulan File gambar dengan label & sumber tertentu. */
  const submitFiles = useCallback(
    async (files: Iterable<File>, source: "upload" | "paste") => {
      const list = [...files].filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) {
        setMsg({ kind: "err", text: "tidak ada file gambar yang valid" });
        return;
      }
      setBusy((b) => b + list.length);
      setMsg(null);
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
          errors.push(`${file.name}: ${err instanceof Error ? err.message : "gagal"}`);
        } finally {
          setBusy((b) => b - 1);
        }
      }
      await refresh();
      if (okCount > 0) {
        setMsg({
          kind: "ok",
          text: `${okCount} gambar tersimpan di database (label: ${label}, via ${source === "paste" ? "paste" : "upload"})`,
        });
      }
      if (errors.length > 0) {
        setMsg({ kind: "err", text: errors.slice(0, 3).join(" · ") });
      }
    },
    [label, refresh],
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
      setMsg(null);
      try {
        await deleteDatasetImage(item.id);
        revokeDatasetImageUrl(item.id);
        setUrls((prev) => {
          const next = new Map(prev);
          next.delete(item.id);
          return next;
        });
        await refresh();
        setMsg({ kind: "ok", text: `sampel #${item.id} dihapus` });
      } catch (err) {
        setMsg({ kind: "err", text: err instanceof Error ? err.message : "gagal menghapus" });
      }
    },
    [refresh],
  );

  return (
    <aside className="dataset-panel" aria-label="Panel kelola dataset" ref={panelRef}>
      <div className="ds-head">
        <h2>Kelola Dataset</h2>
      </div>

      <p className="ds-summary" aria-live="polite">
        mobil: {counts.mobil} · motor: {counts.motor}
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
          if (e.dataTransfer.files.length > 0) void submitFiles(e.dataTransfer.files, "upload");
        }}
      >
        Klik di sini lalu <kbd>Ctrl</kbd>+<kbd>V</kbd> untuk paste screenshot
        <span className="ds-paste-sub">png / jpg / webp · maks 5 MB per file</span>
      </div>

      {msg && (
        <p className={`ds-msg ds-msg-${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>
          {msg.text}
        </p>
      )}

      {loading ? (
        <p className="ds-note">Memuat dataset…</p>
      ) : items.length === 0 ? (
        <p className="ds-note">Belum ada sampel. Upload atau paste gambar pertama.</p>
      ) : (
        <div className="ds-grid" aria-label="Daftar sampel dataset">
          {items.map((item) => {
            const src = urls.get(item.id);
            const isSeed = item.source === "seed";
            return (
              <figure className="ds-thumb" key={item.id} title={`#${item.id} · ${(item.size / 1024).toFixed(1)} KB`}>
                {broken.has(item.id) || !src ? (
                  <span className="ds-broken">#{item.id}</span>
                ) : (
                  <img src={src} alt={`${item.label} — sampel #${item.id}`} loading="lazy" />
                )}
                <span className={`ds-badge${isSeed ? " seed" : ""}`}>{item.label}</span>
                {!isSeed && (
                  <button
                    type="button"
                    className="ds-del"
                    aria-label={`Hapus sampel #${item.id}`}
                    title="Hapus dari dataset"
                    onClick={() => void handleDelete(item)}
                  >
                    ×
                  </button>
                )}
              </figure>
            );
          })}
        </div>
      )}

      <p className="ds-hint">
        Gambar tersimpan di <span className="mono">database SQLite</span> backend
        (<span className="mono">backend/data/dataset.db</span>, tidak di-commit).
        Sampel seed (badge hijau) tidak bisa dihapus dari panel.
      </p>
    </aside>
  );
}
