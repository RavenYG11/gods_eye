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
  enteredCounts: Record<string, number>;
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
    };
  }, [enabled, retryTick]);
  return { status, motion, detFps, trackingFps, inferMs, provider, counts, enteredCounts, error, enabled, toggle, retry };
}
