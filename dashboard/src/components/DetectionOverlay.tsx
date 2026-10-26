// Boxes are measured by the independent pixel tracker. Only bridge the
// last fraction of a video frame, never extrapolate an entire YOLO interval.
import { useEffect, useRef, type MutableRefObject } from "react";
import { DIRECTION_COLORS } from "../detection";
import type { MotionSnapshot } from "../detection/motionTracker";
import type { Detection } from "../detection";
import { BoxPresenter } from "../detection/boxPresenter";

interface Props {
  getVideo: () => HTMLVideoElement | null;
  motion: MutableRefObject<MotionSnapshot>;
  visible: boolean;
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  det: Detection,
  scale: number,
  opacity: number,
): void {
  const [x, y, w, h] = det.bbox;
  const sx = x * scale;
  const sy = y * scale;
  const sw = w * scale;
  const sh = h * scale;
  const color = DIRECTION_COLORS[det.direction ?? "unknown"];

  // Pixel tracking keeps the box fully visible while evidence remains valid.
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, sy, sw, sh);

  // Vehicle identity; model confidence is not an accuracy percentage.
  const text = `${det.label}${det.trackId ? ` #${det.trackId}` : ""}`;
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

export function DetectionOverlay({ getVideo, motion, visible }: Props) {
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

  // Read worker snapshots without rerendering React at the tracking frame rate.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = getVideo();
    if (!canvas || !video || !visible) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const presenter = new BoxPresenter();
    const render = () => {
      raf = requestAnimationFrame(render);
      const v = getVideo();
      if (!v || v.videoWidth === 0) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const scale = Math.min(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
      const offsetX = (canvas.width - v.videoWidth * scale) / 2;
      const offsetY = (canvas.height - v.videoHeight * scale) / 2;
      const nowPts = v.currentTime;
      ctx.save();
      ctx.translate(offsetX, offsetY);
      presenter.begin(nowPts, new Set(motion.current.detections.map((d) => d.trackId)));
      for (const det of motion.current.detections) {
        const presentation = presenter.present(det, nowPts);
        if (presentation) drawBox(ctx, { ...det, bbox: presentation.bbox }, scale, presentation.opacity);
      }
      ctx.restore();

      // Legenda kecil — jujur: arah vertikal frame, bukan in/out gerbang.
      const legend = "Ruas menuju Bekasi · Biru: ke atas · Abu: diam / baru terlihat";
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
