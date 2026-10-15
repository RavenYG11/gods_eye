// Hook React ↔ Detection Worker.
// Rujukan #60: deteksi 10–15 fps, video 60fps tidak block (inferensi di worker).
//
// Satu-satunya tempat yang memegang WorkerVehicleDetector (composition root).
// Komponen UI hanya menerima Detection[] + status — tidak pernah menyentuh
// worker/model langsung (arsitektur §2).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAPTURE_FPS,
  WorkerVehicleDetector,
  modelFallbackUrl,
  modelUrl,
  ortWasmBase,
} from "../detection";
import type { Detection } from "../detection";

export type DetStatus = "off" | "loading" | "ready" | "error";

export interface DetectionState {
  status: DetStatus;
  detections: Detection[];
  /** fps deteksi aktual (hasil inferensi per detik, bukan fps video). */
  detFps: number | null;
  /** Hitung kendaraan per label pada frame terakhir. */
  counts: Record<string, number>;
  /** Pesan galat bila status "error". */
  error: string;
  enabled: boolean;
  toggle: () => void;
  retry: () => void;
}

/** Jendela hitung fps deteksi: N hasil terakhir. */
const FPS_WINDOW = 10;

export function useDetection(
  getVideo: () => HTMLVideoElement | null,
): DetectionState {
  const [enabled, setEnabled] = useState(true); // #60: deteksi ON by default
  const [status, setStatus] = useState<DetStatus>("off");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [detFps, setDetFps] = useState<number | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [retryTick, setRetryTick] = useState(0);

  const detectorRef = useRef<WorkerVehicleDetector | null>(null);
  const stampsRef = useRef<number[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggle = useCallback(() => setEnabled((e) => !e), []);
  const retry = useCallback(() => setRetryTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      setDetections([]);
      setCounts({});
      setDetFps(null);
      return;
    }

    const detector = new WorkerVehicleDetector();
    detectorRef.current = detector;
    let timer: number | null = null;
    let cancelled = false;
    setError("");
    setStatus("loading");

    const base = document.baseURI;
    detector
      .init({
        modelUrl: modelUrl(base),
        labels: [], // label final dipetakan di worker (vehicleConfig)
        fallbackUrl: modelFallbackUrl(base),
        wasmBase: ortWasmBase(base),
      })
      .then(() => {
        if (cancelled || !mountedRef.current) return;
        setStatus("ready");
        // Loop tangkap frame: tiap 1/CAPTURE_FPS dtk, lewati bila worker sibuk.
        timer = window.setInterval(() => {
          const video = getVideo();
          if (!video || detectorRef.current !== detector) return;
          void detector
            .detect(video)
            .then((dets) => {
              if (cancelled || !mountedRef.current) return;
              // Frame yang dilewati (worker sibuk) BUKAN hasil inferensi —
              // jangan masuk penghitung fps maupun overlay.
              if (detector.lastSkipped) return;
              const now = performance.now();
              const stamps = stampsRef.current;
              stamps.push(now);
              if (stamps.length > FPS_WINDOW) stamps.shift();
              if (stamps.length >= 2) {
                const span = (stamps[stamps.length - 1] - stamps[0]) / 1000;
                if (span > 0) setDetFps(+(stamps.length / span).toFixed(1));
              }
              setDetections(dets);
              const c: Record<string, number> = {};
              for (const d of dets) c[d.label] = (c[d.label] ?? 0) + 1;
              setCounts(c);
            })
            .catch(() => {
              // Kontrak: detect() tidak melempar — catch ini jaga-jaga.
            });
        }, 1000 / CAPTURE_FPS);
      })
      .catch((e: unknown) => {
        if (cancelled || !mountedRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setStatus("error");
      });

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      stampsRef.current = [];
      void detector.dispose();
      if (detectorRef.current === detector) detectorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, retryTick]);

  return {
    status,
    detections,
    detFps,
    counts,
    error,
    enabled,
    toggle,
    retry,
  };
}
