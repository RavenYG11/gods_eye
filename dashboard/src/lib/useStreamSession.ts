// Jembatan StreamHealth (imperatif) → React state.
// App membuat SATU engine dan membagikannya ke StreamPlayer + ConnectionLog
// lewat props — satu sumber kebenaran untuk status, metrik, dan log.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraConfig } from "../config/cameras";
import {
  StreamHealth,
  type StreamSnapshot,
  type TelemetrySample,
} from "./streamHealth";

export interface StreamSession {
  snap: StreamSnapshot;
  /** Ref callback untuk <video> — dipasang oleh StreamPlayer. */
  attachVideo: (el: HTMLVideoElement | null) => void;
  retry: () => void;
  /** #68: salinan ring buffer telemetri playback (bukti uji 10+ menit). */
  getTelemetry: () => TelemetrySample[];
  /**
   * #69: penjaga jendela DVR — dipanggil UI tepat SEBELUM resume dari pause
   * agar posisi play masih valid (tidak menabrak posisi kedaluwarsa).
   */
  guardDvrWindow: () => boolean;
  /** #70.1: seek manual user ke posisi detik dalam jendela DVR (scrub). */
  seekTo: (targetSec: number) => boolean;
  /**
   * #70.3: resume tahan banting — guard DVR + clamp jendela + startLoad +
   * watchdog pemulihan. Pengganti pola guardDvrWindow()+play() (#69).
   */
  resumePlayback: () => void;
  pausePlayback: () => void;
  setDetectionReady: (ready: boolean) => void;
}

const INITIAL: StreamSnapshot = {
  status: "loading",
  paused: false,
  prebuffering: false,
  playback: { pos: 0, bufStart: -1, bufEnd: -1, edge: -1, windowStart: -1, windowEnd: -1, dvrState: "loading" },
  delaySec: 0,
  attempt: 0,
  maxAttempts: 5,
  countdownSec: 0,
  errorCode: "",
  metrics: {
    bitrateMbps: null,
    width: null,
    height: null,
    fps: null,
    stalls: 0,
    reconnects: 0,
    uptimeSec: 0,
  },
  log: [],
};

export function useStreamSession(camera: CameraConfig): StreamSession {
  const engineRef = useRef<StreamHealth | null>(null);
  if (!engineRef.current) {
    engineRef.current = new StreamHealth();
  }
  const [snap, setSnap] = useState<StreamSnapshot>(INITIAL);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const off = engine.subscribe(setSnap);
    return () => {
      off();
    };
  }, []);

  // attachVideo stabil: engine & camera tidak berubah selama sesi v0.1.
  const attachVideo = useCallback((el: HTMLVideoElement | null) => setVideo(el), []);
  // The effect owns the connection, including React StrictMode setup/cleanup.
  useEffect(() => {
    const engine = engineRef.current;
    if (!video || !engine) return;
    engine.attach(video, camera);
    return () => engine.detach();
  }, [video, camera]);
  const pausePlayback = useCallback(() => engineRef.current?.pausePlayback(), []);
  const setDetectionReady = useCallback((ready: boolean) => engineRef.current?.setDetectionReady(ready), []);

  const [retry] = useState(() => () => {
    engineRef.current?.retry();
  });

  // #68: stabil — engine tidak berubah selama sesi v0.1.
  const [getTelemetry] = useState(
    () => () => engineRef.current?.getTelemetry() ?? [],
  );

  // #69: stabil — engine tidak berubah selama sesi v0.1.
  const [guardDvrWindow] = useState(
    () => () => engineRef.current?.guardDvrWindow() ?? false,
  );

  // #70.1 / #70.3: stabil — engine tidak berubah selama sesi v0.1.
  const [seekTo] = useState(
    () => (targetSec: number) =>
      engineRef.current?.seekTo(targetSec) ?? false,
  );
  const [resumePlayback] = useState(
    () => () => engineRef.current?.resumePlayback(),
  );

  return {
    snap,
    attachVideo,
    retry,
    getTelemetry,
    guardDvrWindow,
    seekTo,
    resumePlayback,
    pausePlayback,
    setDetectionReady,
  };
}
