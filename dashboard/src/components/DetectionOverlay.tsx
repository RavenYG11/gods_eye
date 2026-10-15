// Overlay deteksi kendaraan — kanvas di atas <video>.
// Rujukan #60: WARNA BOX: BIRU = kendaraan ke ATAS, HIJAU = ke BAWAH
// (siap untuk vehicle in/out counting — DB BELUM dibuat, visual dulu).
//
// #68: overlay kini berjalan pada FRAME-RATE VIDEO (requestAnimationFrame),
// bukan pada frame-rate deteksi. Tiap track membawa velocity (vx, vy;
// piksel per detik-waktu-video) + framePts terakhir terlihat — posisi box
// diekstrapolasi TIAP frame: pos = bbox + v·(video.currentTime − framePts).
// Deteksi boleh 1 fps; box tetap meluncur mulus 60fps mengikuti kendaraan.
// dt dijepit [0, PREDICT_CAP_S=3 dtk] oleh predictBbox — lewat dari itu box
// digambar beku di posisi terakhir (jujur, tidak "terbang").
//
// Kanvas pointer-events:none (klik tetap ke video), z-index 2: di atas video,
// di bawah shimmer/overlay/badge. Kotak digambar dalam piksel frame sumber
// (mis. 1920×1080) lalu diskala ke ukuran tampil video.

import { useEffect, useRef } from "react";
import { DIRECTION_COLORS, predictBbox } from "../detection";
import type { Detection, TrackedDetection } from "../detection";

interface Props {
  getVideo: () => HTMLVideoElement | null;
  detections: Detection[];
  visible: boolean;
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  det: Detection,
  scale: number,
  dim: boolean,
): void {
  const [x, y, w, h] = det.bbox;
  const sx = x * scale;
  const sy = y * scale;
  const sw = w * scale;
  const sh = h * scale;
  const color = DIRECTION_COLORS[det.direction ?? "unknown"];

  // #68: track stale (tanpa deteksi segar frame ini) digambar sedikit redup —
  // jujur bahwa posisinya hasil prediksi, bukan deteksi segar.
  ctx.globalAlpha = dim ? 0.55 : 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, sy, sw, sh);

  // Chip label: "mobil 92% #3"
  const text = `${det.label} ${Math.round(det.confidence * 100)}%${det.trackId ? ` #${det.trackId}` : ""}`;
  ctx.font = "600 11px system-ui, sans-serif";
  const pad = 4;
  const tw = ctx.measureText(text).width;
  const chipH = 16;
  const chipY = sy - chipH - 3 >= 0 ? sy - chipH - 3 : sy + 3;
  ctx.fillStyle = color;
  ctx.fillRect(sx, chipY, tw + pad * 2, chipH);
  ctx.fillStyle = "#04060b";
  ctx.fillText(text, sx + pad, chipY + 12);
  ctx.globalAlpha = 1;
}

export function DetectionOverlay({ getVideo, detections, visible }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // #68: ref agar loop rAF selalu membaca hasil deteksi TERBARU tanpa
  // me-restart loop tiap ada hasil baru.
  const detsRef = useRef(detections);
  detsRef.current = detections;

  // Samakan ukuran kanvas dengan ukuran tampil video (termasuk fullscreen).
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = getVideo();
    if (!canvas || !video) return;
    const fit = () => {
      canvas.width = Math.max(1, video.clientWidth);
      canvas.height = Math.max(1, video.clientHeight);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(video);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // #68: LOOP PREDIKSI — gambar ulang tiap frame video (rAF), bukan tiap
  // hasil deteksi. Box diekstrapolasi dari velocity track sehingga mengikuti
  // kendaraan dengan mulus walau deteksi hanya 1–4 fps. Basis waktu =
  // video.currentTime (bukan wall-clock): saat video buffering (freeze),
  // box ikut freeze — benar, karena gambarnya pun diam.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = getVideo();
    if (!canvas || !video || !visible) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const v = getVideo();
      if (!v || v.videoWidth === 0) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const scale = canvas.width / v.videoWidth;
      const nowPts = v.currentTime;
      for (const det of detsRef.current) {
        const td = det as TrackedDetection;
        // TrackedDetection selalu membawa vx/vy/framePts (kontrak #68);
        // fallback aman bila bukan (mis. data lama).
        const bbox =
          typeof td.vx === "number" &&
          typeof td.vy === "number" &&
          typeof td.framePts === "number"
            ? predictBbox(det.bbox, td.vx, td.vy, nowPts - td.framePts)
            : det.bbox;
        drawBox(ctx, { ...det, bbox }, scale, td.stale === true);
      }

      // Legenda kecil — jujur: arah vertikal frame, bukan in/out gerbang.
      const legend = "■ ke atas (biru) · ■ ke bawah (hijau)";
      ctx.font = "500 10px system-ui, sans-serif";
      const tw = ctx.measureText(legend).width;
      ctx.fillStyle = "rgba(4,6,11,.65)";
      ctx.fillRect(canvas.width - tw - 20, canvas.height - 24, tw + 12, 18);
      ctx.fillStyle = "rgba(229,231,235,.9)";
      ctx.fillText(legend, canvas.width - tw - 14, canvas.height - 11);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;
  return (
    <canvas
      ref={canvasRef}
      className="det-overlay"
      aria-hidden="true"
    />
  );
}
