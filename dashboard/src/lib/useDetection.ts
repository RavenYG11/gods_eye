import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { CAPTURE_FPS, WorkerVehicleDetector, modelFallbackUrl, modelUrl, ortWasmBase } from "../detection";
import { MOTION_FPS } from "../detection/vehicleConfig";
import { VisualTracker } from "../detection/visualTracker";
import type { MotionSnapshot } from "../detection/motionTracker";
import { compensateDelivery } from "../detection/presentationTiming";

export type DetStatus = "off" | "loading" | "ready" | "error";
export interface DetectionState {
  status: DetStatus;
  motion: MutableRefObject<MotionSnapshot>;
  detFps: number | null;
  trackingFps: number | null;
  inferMs: number | null;
  provider: string | null;
  counts: Record<string, number>;
<<<<<<< HEAD
  enteredCounts: Record<string, number>;
=======
  /**
   * #76: statistik panggilan detect() kumulatif (calls, inferStarted,
   * skipped, timedOut, ok) — diagnostik/QA via window.__godsEye.
   */
  stats: { calls: number; inferStarted: number; skipped: number; timedOut: number; ok: number } | null;
  /** Pesan galat bila status "error". */
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
  error: string;
  enabled: boolean;
  toggle: () => void;
  retry: () => void;
}

export function useDetection(getVideo: () => HTMLVideoElement | null, paused = false): DetectionState {
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<DetStatus>("off");
  const motion = useRef<MotionSnapshot>({ framePts: -1, detections: [] });
  const [detFps, setDetFps] = useState<number | null>(null);
  const [trackingFps, setTrackingFps] = useState<number | null>(null);
  const [inferMs, setInferMs] = useState<number | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [enteredCounts, setEnteredCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [retryTick, setRetryTick] = useState(0);
<<<<<<< HEAD
  const latest = useRef({ getVideo, paused });
  latest.current = { getVideo, paused };
  const toggle = useCallback(() => setEnabled((v) => !v), []);
  const retry = useCallback(() => setRetryTick((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false, failed = false;
    let timer = 0, callback = 0, statsAt = 0;
    let video: HTMLVideoElement | null = null;
    let lastPts = -1, lastCapture = -Infinity;
    let measuredMotionFps: number | null = null;
    let processing = false, motionPts = -1;
    let deliveryLag = 0.08;
    const stamps: number[] = [], motionStamps: number[] = [];
    motion.current = { framePts: -1, detections: [] };
    setCounts({}); setEnteredCounts({}); setDetFps(null); setInferMs(null); setTrackingFps(null);
    setProvider(null); setError("");
    if (!enabled) { setStatus("off"); return; }
=======
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
  /**
   * #76: GENERASI TIMELINE — naik tiap diskontinuitas currentTime (event
   * 'seeking': scrub user, guard DVR, seek internal hls.js). Hasil detect
   * yang generasinya kedaluwarsa dibuang (tak boleh diterapkan ke timeline
   * baru) + tracker di worker di-reset via resetTracker().
   */
  const genRef = useRef(0);
  const seekVideoRef = useRef<HTMLVideoElement | null>(null);

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
    // #76: handler 'seeking' di-hoist agar cleanup effect bisa mencabutnya.
    const onSeeking = () => {
      if (cancelled || detectorRef.current !== detector) return;
      genRef.current += 1;
      detector.currentGeneration = genRef.current;
      // Track lama mereferensikan timeline lama → buang di worker.
      detector.resetTracker();
    };
    setError("");
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
    setStatus("loading");
    const detector = new WorkerVehicleDetector();
    const fail = (message: string) => {
      if (cancelled || failed) return;
      failed = true;
      motion.current = { framePts: -1, detections: [] };
      setCounts({}); setError(message); setStatus("error");
      visual.dispose(); void detector.dispose();
    };
    const rate = (samples: number[], now: number): number | null => {
      samples.push(now);
      while (samples.length > 30) samples.shift();
      return samples.length > 1 ? +((samples.length - 1) * 1000 / (now - samples[0])).toFixed(1) : null;
    };
    const visual = new VisualTracker((snapshot) => {
      if (cancelled || failed || snapshot.framePts < motion.current.framePts) return;
      const presentation = compensateDelivery(snapshot,
        latest.current.getVideo()?.currentTime ?? snapshot.framePts, deliveryLag);
      deliveryLag = presentation.lag;
      motion.current = presentation.snapshot; // overlay reads directly, no React render at video rate
      const now = performance.now();
      if (snapshot.framePts !== motionPts) { measuredMotionFps = rate(motionStamps, now); motionPts = snapshot.framePts; }
      if (now - statsAt > 500) {
        statsAt = now; setTrackingFps(measuredMotionFps);
        const next: Record<string, number> = {};
        for (const d of snapshot.detections) next[d.label] = (next[d.label] ?? 0) + 1;
        setCounts(next);
        setEnteredCounts({ ...snapshot.entries });
      }
    }, fail);
    const reset = () => {
      detector.reset(); visual.reset(); lastPts = -1; motionPts = -1;
      lastCapture = -Infinity; measuredMotionFps = null; stamps.length = motionStamps.length = 0;
      deliveryLag = 0.08;
      motion.current = { framePts: -1, detections: [] };
      setCounts({}); setEnteredCounts({}); setDetFps(null); setTrackingFps(null);
    };
    const infer = async (pts: number) => {
      if (!video || processing || performance.now() - lastCapture < 1000 / CAPTURE_FPS) return;
      processing = true; lastCapture = performance.now();
      try {
        const frame = await detector.detectFrame(video, pts);
        if (cancelled || failed) return;
        if (detector.lastError) { fail(detector.lastError); return; }
        if (!frame) return;
        setDetFps(rate(stamps, performance.now())); setInferMs(frame.inferMs);
        visual.anchor(frame, video);
      } finally { processing = false; }
    };
    const capture = (pts: number) => {
      if (!video || failed || latest.current.paused || video.paused || video.seeking ||
        video.readyState < 2 || !video.videoWidth || pts === lastPts) return;
      // Throttle on the media clock: wall-clock callback jitter must not skip
      // every other decoded frame of a 25 fps stream.
      if (pts - lastPts < 1 / MOTION_FPS - 0.003) return;
      // Only run YOLO on a frame also sent to the motion history. Matching
      // presentation timestamps allow exact replay of its delayed result.
      if (!visual.capture(video, pts)) return;
      lastPts = pts;
      void infer(pts);
    };
    const schedule = () => {
      if (cancelled || failed) return;
      if (!video) {
        video = latest.current.getVideo();
        if (video) { video.addEventListener("seeking", reset); video.addEventListener("resize", reset); }
      }
      if (video && typeof video.requestVideoFrameCallback === "function") {
        callback = video.requestVideoFrameCallback((_now, meta) => { capture(meta.mediaTime); schedule(); });
      } else {
        timer = window.setTimeout(() => { if (video) capture(video.currentTime); schedule(); }, 1000 / MOTION_FPS);
      }
    };
    const base = document.baseURI;
<<<<<<< HEAD
    void detector.init({ modelUrl: modelUrl(base), labels: [],
      fallbackUrl: modelFallbackUrl(base), wasmBase: ortWasmBase(base) }).then(() => {
      if (cancelled || failed) return;
      setProvider(detector.lastProvider); setStatus("ready"); schedule();
    }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true; clearTimeout(timer);
      if (callback) video?.cancelVideoFrameCallback(callback);
      video?.removeEventListener("seeking", reset); video?.removeEventListener("resize", reset);
      visual.dispose(); void detector.dispose();
=======
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
        // #76: dengarkan diskontinuitas timeline LANGSUNG dari <video>.
        // 'seeking' menyala untuk SETIAP perubahan currentTime yang
        // diskontinu (scrub user, guard DVR, seek internal hls.js) — jauh
        // lebih presisi daripada heuristik selisih antar-tick (yang bisa
        // salah tembak saat GC pause / stall).
        const v0 = getVideo();
        if (v0) {
          v0.addEventListener("seeking", onSeeking);
          seekVideoRef.current = v0;
        }
        // Loop tangkap frame: tiap 1/CAPTURE_FPS dtk, lewati bila worker sibuk.
        timer = window.setInterval(() => {
          // #69: video dijeda → jangan inferensi frame yang sama berulang.
          if (pausedRef.current) return;
          const video = getVideo();
          if (!video || detectorRef.current !== detector) return;
          // #76: pasang listener seeking bila elemen video berganti
          // (jaga-jaga — normalnya elemen stabil sepanjang sesi).
          if (seekVideoRef.current !== video) {
            seekVideoRef.current?.removeEventListener("seeking", onSeeking);
            video.addEventListener("seeking", onSeeking);
            seekVideoRef.current = video;
          }
          // #69: video dijeda → frame beku; lewati inferensi (hemat CPU).
          // Box overlay tetap tampil beku karena basis waktunya
          // video.currentTime (#68) — konsisten, tidak perlu hasil baru.
          if (video.paused) return;
          detector.currentGeneration = genRef.current;
          void detector
            .detect(video)
            .then((outcome) => {
              if (cancelled || !mountedRef.current) return;
              // #76: hasil dari timeline LAMA (seek terjadi saat inferensi
              // berjalan) → buang; tracker sudah di-reset oleh onSeeking.
              if (outcome.generation !== genRef.current) return;
              // Frame yang dilewati (worker sibuk / pesan "dropped") atau
              // TIMEOUT (#68) BUKAN hasil inferensi — jangan masuk penghitung
              // fps, jangan sentuh overlay, jangan catat inferMs.
              // #76: keputusan dari outcome PER PANGGILAN (akar bug audit A),
              // bukan flag global detector.lastSkipped.
              if (outcome.skipped || outcome.timedOut) return;
              const dets = outcome.detections;
              const now = performance.now();
              const stamps = stampsRef.current;
              stamps.push(now);
              if (stamps.length > FPS_WINDOW) stamps.shift();
              if (stamps.length >= 2) {
                const span = (stamps[stamps.length - 1] - stamps[0]) / 1000;
                if (span > 0) setDetFps(+(stamps.length / span).toFixed(1));
              }
              setInferMs(outcome.inferMs);
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
      // #76: cabut listener seeking (jangan bocor antar-siklus detector).
      seekVideoRef.current?.removeEventListener("seeking", onSeeking);
      seekVideoRef.current = null;
      stampsRef.current = [];
      void detector.dispose();
      if (detectorRef.current === detector) detectorRef.current = null;
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
    };
  }, [enabled, retryTick]);
<<<<<<< HEAD
  return { status, motion, detFps, trackingFps, inferMs, provider, counts, enteredCounts, error, enabled, toggle, retry };
=======

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
    /** #76: statistik panggilan detect() kumulatif (diagnostik/QA). */
    stats: detectorRef.current?.stats ?? null,
  };
>>>>>>> 24d4d19e00c1e15bc33f1bb16a1404b872d3cb6e
}
