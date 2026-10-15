// Jembatan StreamHealth (imperatif) → React state.
// App membuat SATU engine dan membagikannya ke StreamPlayer + ConnectionLog
// lewat props — satu sumber kebenaran untuk status, metrik, dan log.

import { useEffect, useRef, useState } from "react";
import type { CameraConfig } from "../config/cameras";
import { StreamHealth, type StreamSnapshot } from "./streamHealth";

export interface StreamSession {
  snap: StreamSnapshot;
  /** Ref callback untuk <video> — dipasang oleh StreamPlayer. */
  attachVideo: (el: HTMLVideoElement | null) => void;
  retry: () => void;
}

const INITIAL: StreamSnapshot = {
  status: "loading",
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

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const off = engine.subscribe(setSnap);
    return () => {
      off();
      engine.detach();
    };
  }, []);

  // attachVideo stabil: engine & camera tidak berubah selama sesi v0.1.
  const [attachVideo] = useState(
    () => (el: HTMLVideoElement | null) => {
      const engine = engineRef.current;
      if (el && engine) {
        engine.attach(el, camera);
      }
    },
  );

  const [retry] = useState(() => () => {
    engineRef.current?.retry();
  });

  return { snap, attachVideo, retry };
}
