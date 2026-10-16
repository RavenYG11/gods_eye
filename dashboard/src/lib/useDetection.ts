// Hook React ↔ Detection Worker.
// Rujukan #60: deteksi 10–15 fps, video 60fps tidak block (inferensi di worker).
//
// Satu-satunya tempat yang memegang WorkerVehicleDetector (composition root).
// Komponen UI hanya menerima Detection[] + status — tidak pernah menyentuh
// worker/model langsung (arsitektur §2).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAPTURE_FPS,
  CONFIDENCE_THRESHOLD,
  WorkerVehicleDetector,
  modelFallbackUrl,
  modelUrl,
  ortWasmBase,
} from "../detection";
import type { TrackedDetection } from "../detection";

export type DetStatus = "off" | "loading" | "ready" | "error";

export interface DetectionState {
  status: DetStatus;
  /**
   * #62: hasil dari WORKER = TrackedDetection (trackId + direction + stale),
   * BUKAN raw detection. Kontrak Detector tetap Detection[] — cast aman di
   * sini karena worker selalu mengembalikan keluaran ByteTracker (#74).
   */
  detections: TrackedDetection[];
  /** fps deteksi aktual (hasil inferensi per detik, bukan fps video). */
  detFps: number | null;
  /**
   * #68: biaya putaran worker terakhir (ms) — diagnosis bottleneck,
   * tampil di chip UI.
   */
  inferMs: number | null;
  /**
   * #68: execution provider ONNX terpilih ("webgl" | "wasm") — tampil di
   * chip UI sebagai bukti pengukuran (bukan asumsi).
   */
  provider: string | null;
  /** Hitung kendaraan per label pada frame terakhir. */
  counts: Record<string, number>;
  /** Pesan galat bila status "error". */
  error: string;
  enabled: boolean;
  toggle: () => void;
  retry: () => void;
  /** #62: ambang confidence live (0,1–0,9) + pengubahnya (slider UI). */
  threshold: number;
  setThreshold: (v: number) => void;
}

/** Jendela hitung fps deteksi: N hasil terakhir. */
const FPS_WINDOW = 10;

export function useDetection(
  getVideo: () => HTMLVideoElement | null,
  /**
   * #69: true bila video dijeda user. Loop tangkap frame dilewati selama
   * pause — menginferensi frame yang SAMA berulang-ulang hanya membuang CPU.
   * Overlay tetap freeze dengan benar karena basis waktunya
   * video.currentTime (#68) — tidak perlu disentuh di sini.
   */
  paused = false,
): DetectionState {
  const [enabled, setEnabled] = useState(true); // #60: deteksi ON by default
  const [status, setStatus] = useState<DetStatus>("off");
  const [detections, setDetections] = useState<TrackedDetection[]>([]);
  const [detFps, setDetFps] = useState<number | null>(null);
  const [inferMs, setInferMs] = useState<number | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [retryTick, setRetryTick] = useState(0);
  // #62: ambang confidence — default dari vehicleConfig, bisa digeser live.
  const [threshold, setThresholdState] = useState(CONFIDENCE_THRESHOLD);

  const detectorRef = useRef<WorkerVehicleDetector | null>(null);
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const stampsRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  // #69: ref agar interval selalu membaca nilai pause TERBARU tanpa restart.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggle = useCallback(() => setEnabled((e) => !e), []);
  const retry = useCallback(() => setRetryTick((t) => t + 1), []);
  // #62: kirim ke worker yang sedang aktif; worker baru (retry/toggle)
  // menerima nilai terkini lewat thresholdRef saat init selesai.
  const setThreshold = useCallback((v: number) => {
    const clamped = Math.min(0.9, Math.max(0.1, v));
    setThresholdState(clamped);
    detectorRef.current?.setThreshold(clamped);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      setDetections([]);
      setCounts({});
      setDetFps(null);
      setInferMs(null);
      setProvider(null);
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
        // #68: catat execution provider terpilih (webgl|wasm) untuk chip UI.
        setProvider(detector.lastProvider);
        // Terapkan ambang terkini (slider mungkin digeser sebelum ready).
        detector.setThreshold(thresholdRef.current);
        // Loop tangkap frame: tiap 1/CAPTURE_FPS dtk, lewati bila worker sibuk.
        timer = window.setInterval(() => {
          // #69: video dijeda → jangan inferensi frame yang sama berulang.
          if (pausedRef.current) return;
          const video = getVideo();
          if (!video || detectorRef.current !== detector) return;
          // #69: video dijeda → frame beku; lewati inferensi (hemat CPU).
          // Box overlay tetap tampil beku karena basis waktunya
          // video.currentTime (#68) — konsisten, tidak perlu hasil baru.
          if (video.paused) return;
          void detector
            .detect(video)
            .then((dets) => {
              if (cancelled || !mountedRef.current) return;
              // Frame yang dilewati (worker sibuk / pesan "dropped") atau
              // TIMEOUT (#68) BUKAN hasil inferensi — jangan masuk penghitung
              // fps, jangan sentuh overlay, jangan catat inferMs.
              if (detector.lastSkipped || detector.lastTimedOut) return;
              const now = performance.now();
              const stamps = stampsRef.current;
              stamps.push(now);
              if (stamps.length > FPS_WINDOW) stamps.shift();
              if (stamps.length >= 2) {
                const span = (stamps[stamps.length - 1] - stamps[0]) / 1000;
                if (span > 0) setDetFps(+(stamps.length / span).toFixed(1));
              }
              setInferMs(detector.lastInferMs);
              setDetections(dets as TrackedDetection[]);
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
    inferMs,
    provider,
    counts,
    error,
    enabled,
    toggle,
    retry,
    threshold,
    setThreshold,
  };
}
