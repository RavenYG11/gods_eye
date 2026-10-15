// Overlay deteksi kendaraan — kanvas di atas <video>.
// Rujukan #60: WARNA BOX: BIRU = kendaraan ke ATAS, HIJAU = ke BAWAH
// (siap untuk vehicle in/out counting — DB BELUM dibuat, visual dulu).
//
// Kanvas pointer-events:none (klik tetap ke video), z-index 2: di atas video,
// di bawah shimmer/overlay/badge. Kotak digambar dalam piksel frame sumber
// (mis. 1920×1080) lalu diskala ke ukuran tampil video.

import { useEffect, useRef } from "react";
import { DIRECTION_COLORS } from "../detection";
import type { Detection } from "../detection";

interface Props {
  getVideo: () => HTMLVideoElement | null;
  detections: Detection[];
  visible: boolean;
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  det: Detection,
  scale: number,
): void {
  const [x, y, w, h] = det.bbox;
  const sx = x * scale;
  const sy = y * scale;
  const sw = w * scale;
  const sh = h * scale;
  const color = DIRECTION_COLORS[det.direction ?? "unknown"];

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
}

export function DetectionOverlay({ getVideo, detections, visible }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  // Gambar ulang tiap ada hasil deteksi baru (~10fps — cukup untuk overlay).
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = getVideo();
    if (!canvas || !visible) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!video || video.videoWidth === 0) return;

    const scale = canvas.width / video.videoWidth;
    for (const det of detections) {
      drawBox(ctx, det, scale);
    }

    // Legenda kecil — jujur: arah vertikal frame, bukan in/out gerbang.
    const legend = "■ ke atas (biru) · ■ ke bawah (hijau)";
    ctx.font = "500 10px system-ui, sans-serif";
    const tw = ctx.measureText(legend).width;
    ctx.fillStyle = "rgba(4,6,11,.65)";
    ctx.fillRect(canvas.width - tw - 20, canvas.height - 24, tw + 12, 18);
    ctx.fillStyle = "rgba(229,231,235,.9)";
    ctx.fillText(legend, canvas.width - tw - 14, canvas.height - 11);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detections, visible]);

  if (!visible) return null;
  return (
    <canvas
      ref={canvasRef}
      className="det-overlay"
      aria-hidden="true"
    />
  );
}
