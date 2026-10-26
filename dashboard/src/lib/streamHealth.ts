import Hls, { type ErrorData } from "hls.js";
import type { CameraConfig } from "../config/cameras";
import { getStreamUrl } from "../config/cameras";
import { makeLogEntry, type LogEntry, type LogLevel } from "./log";
import { bufferedAt, bufferGoal, safePlaybackPosition, PLAYBACK_DELAY_SEC } from "./bufferPolicy";

export type StreamStatus = "loading" | "live" | "delay" | "buffering" | "reconnecting" | "offline" | "error";
export type DvrState = "loading" | "ready" | "unavailable";
export interface StreamMetrics {
  bitrateMbps: number | null; width: number | null; height: number | null;
  fps: number | null; stalls: number; reconnects: number; uptimeSec: number;
}
export interface PlaybackInfo {
  pos: number; bufStart: number; bufEnd: number;
  /** Actual playlist edge, never hls.liveSyncPosition (which is a target). */
  edge: number; windowStart: number; windowEnd: number; dvrState: DvrState;
}
export interface StreamSnapshot {
  status: StreamStatus; paused: boolean; prebuffering: boolean;
  playback: PlaybackInfo; delaySec: number; attempt: number; maxAttempts: number;
  countdownSec: number; errorCode: string; metrics: StreamMetrics; log: LogEntry[];
}
export interface TelemetrySample {
  t: number; pos: number; bufStart: number; bufEnd: number; edge: number;
  delay: number; gap: number; stalls: number; status: StreamStatus;
  prebuffering: boolean; droppedFrames: number;
}
const BACKOFF = [1000, 2000, 5000, 15000, 30000];
const emptyPlayback = (): PlaybackInfo => ({ pos: 0, bufStart: -1, bufEnd: -1,
  edge: -1, windowStart: -1, windowEnd: -1, dvrState: "loading" });
const emptyMetrics = (): StreamMetrics => ({ bitrateMbps: null, width: null,
  height: null, fps: null, stalls: 0, reconnects: 0, uptimeSec: 0 });

/** Startup buffer first, then uninterrupted 1x playback. No proactive pauses. */
export class StreamHealth {
  private hls: Hls | null = null;
  private video: HTMLVideoElement | null = null;
  private camera: CameraConfig | null = null;
  private listeners = new Set<(snap: StreamSnapshot) => void>();
  private logEntries: LogEntry[] = [];
  private telemetry: TelemetrySample[] = [];
  private status: StreamStatus = "loading";
  private paused = false;
  private prebuffering = false;
  private userPaused = false;
  private started = false;
  private cycle = 0;
  private cycleAt = 0;
  private gateAt = 0;
  private mediaRecovered = false;
  private attempt = 0;
  private countdownSec = 0;
  private errorCode = "";
  private metrics = emptyMetrics();
  private playback = emptyPlayback();
  private dvr: { start: number; end: number } | null = null;
  private ticker = 0;
  private reconnectTimer = 0;
  private reconnectAt = 0;
  private manualSeekAt = 0;
  private prevFrames = 0;
  private prevFramesAt = 0;
  private lastTelemetry = 0;
  private connectedAt = 0;
  private detectionReady = true;
  private playPending = false;

  setDetectionReady(ready: boolean): void {
    this.detectionReady = ready;
    if (ready) this.tryStart();
  }

  subscribe(fn: (snap: StreamSnapshot) => void): () => void {
    this.listeners.add(fn); fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }
  getTelemetry(): TelemetrySample[] { return this.telemetry.map((row) => ({ ...row })); }

  attach(video: HTMLVideoElement, camera: CameraConfig): void {
    this.detach();
    this.video = video; this.camera = camera;
    this.metrics = emptyMetrics(); this.playback = emptyPlayback(); this.telemetry = [];
    this.attempt = 0; this.started = false; this.userPaused = false;
    this.connectedAt = Date.now(); this.prevFramesAt = 0;
    for (const [event, handler] of this.events) video.addEventListener(event, handler);
    this.startCycle();
    this.ticker = window.setInterval(() => this.tick(), 500);
  }
  detach(): void {
    this.cycle++;
    clearInterval(this.ticker); clearTimeout(this.reconnectTimer);
    this.ticker = this.reconnectTimer = 0;
    this.hls?.destroy(); this.hls = null;
    if (this.video) {
      for (const [event, handler] of this.events) this.video.removeEventListener(event, handler);
      this.video.pause(); this.video.removeAttribute("src"); this.video.load();
    }
    this.video = null; this.dvr = null; this.prebuffering = false;
  }
  retry(): void {
    clearTimeout(this.reconnectTimer);
    this.attempt = 0; this.userPaused = false;
    this.startCycle();
  }
  pausePlayback(): void {
    this.userPaused = true; this.prebuffering = false;
    this.video?.pause(); this.paused = true; this.emit();
  }
  resumePlayback(): void {
    if (!this.video) return;
    this.userPaused = false; this.paused = false;
    this.guardDvrWindow();
    this.hls?.resumeBuffering();
    this.updatePlayback();
    const range = bufferedAt(this.video.buffered, this.video.currentTime);
    if (!this.started || !range || range.end - this.video.currentTime < 1) this.beginGate();
    else this.play();
    this.emit();
  }
  seekTo(target: number): boolean {
    const video = this.video;
    this.updatePlayback();
    const { windowStart: start, windowEnd: end } = this.playback;
    if (!video || !Number.isFinite(target) || !(end > start)) return false;
    const margin = Math.min(0.5, (end - start) / 4);
    video.currentTime = Math.max(start + margin, Math.min(end - margin, target));
    this.manualSeekAt = Date.now();
    this.hls?.resumeBuffering();
    this.updatePlayback(); this.emit();
    return true;
  }
  guardDvrWindow(): boolean {
    const video = this.video, dvr = this.dvr;
    if (!video || !dvr || !this.started) return false;
    // Buffered old segments remain playable even after leaving the playlist.
    const buffered = bufferedAt(video.buffered, video.currentTime);
    if (buffered && buffered.end - video.currentTime > 0.25) return false;
    if (video.currentTime >= dvr.start && video.currentTime < dvr.end) return false;
    if (Date.now() - this.manualSeekAt < 1500) return false;
    const target = safePlaybackPosition(dvr.start, dvr.end);
    video.currentTime = target;
    this.log("warn", `Posisi kedaluwarsa; lanjut dari cadangan video pada ${target.toFixed(1)} dtk.`);
    return true;
  }

  private startCycle(): void {
    const video = this.video, camera = this.camera;
    if (!video || !camera) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0; this.countdownSec = 0;
    this.hls?.destroy(); this.hls = null;
    const cycle = ++this.cycle;
    this.cycleAt = Date.now(); this.gateAt = this.cycleAt;
    this.playPending = false;
    this.dvr = null; this.started = false; this.mediaRecovered = false;
    this.prebuffering = !this.userPaused; this.paused = this.userPaused;
    this.playback = emptyPlayback();
    video.pause(); video.playbackRate = 1;
    this.status = "loading";
    this.log("info", "Memuat stream dan mengisi cadangan video sebelum diputar.");
    if (!Hls.isSupported()) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) {
        this.errorCode = "Browser tidak mendukung HLS."; this.status = "error"; this.emit(); return;
      }
      video.src = getStreamUrl(camera); video.preload = "auto"; video.load();
      return;
    }
    const hls = new Hls({
      enableWorker: true, lowLatencyMode: false,
      liveSyncDuration: PLAYBACK_DELAY_SEC, liveMaxLatencyDuration: Infinity,
      maxLiveSyncPlaybackRate: 1,
      maxBufferLength: 60, maxMaxBufferLength: 120,
      maxBufferSize: 64 * 1024 * 1024, backBufferLength: 30,
      manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4,
      manifestLoadingTimeOut: 15000, levelLoadingTimeOut: 15000, fragLoadingTimeOut: 20000,
    });
    this.hls = hls;
    const current = () => this.cycle === cycle && this.hls === hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!current()) return;
      this.log("ok", `Manifest siap; target delay ${PLAYBACK_DELAY_SEC} dtk, kecepatan tetap 1×.`);
    });
    hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
      if (!current()) return;
      const fragments = data.details.fragments;
      const first = fragments[0], last = fragments[fragments.length - 1];
      if (first && last) this.dvr = { start: first.start, end: last.start + last.duration };
      this.updatePlayback();
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => { if (current()) this.tryStart(); });
    hls.on(Hls.Events.ERROR, (_event, data) => { if (current()) this.onHlsError(data); });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (!current()) return;
      const level = hls.levels[data.level];
      if (!level) return;
      this.metrics.bitrateMbps = level.bitrate ? +(level.bitrate / 1e6).toFixed(1) : null;
      this.metrics.width = level.width || null; this.metrics.height = level.height || null;
      this.emit();
    });
    hls.loadSource(getStreamUrl(camera)); hls.attachMedia(video);
  }

  private beginGate(): void {
    if (!this.video || this.userPaused) return;
    if (!this.prebuffering) this.gateAt = Date.now();
    this.prebuffering = true;
    this.status = this.started ? "buffering" : "loading";
    this.video.pause(); this.paused = false;
    this.tryStart(); this.emit();
  }
  private tryStart(): void {
    const video = this.video;
    if (!video || !this.prebuffering || this.userPaused || video.seeking || (!this.started && !this.detectionReady)) return;
    // Initial media time can be zero while HLS segments start later.
    if (!this.started && video.buffered.length && video.currentTime < video.buffered.start(0) - 0.1) {
      video.currentTime = video.buffered.start(0) + 0.05;
    }
    // Model warmup may outlast the playlist. Start once from a safe, current
    // buffered position instead of playing an already-expired old segment.
    if (!this.started && this.dvr && video.buffered.length && video.currentTime < this.dvr.start + 0.5) {
      video.currentTime = safePlaybackPosition(this.dvr.start, this.dvr.end);
      return;
    }
    this.updatePlayback();
    const p = this.playback;
    const goal = bufferGoal(this.dvr?.start ?? -1, this.dvr?.end ?? -1, p.pos, !this.started);
    if (p.bufEnd < 0 || p.bufEnd - p.pos < goal || video.readyState < 2) return;
    this.prebuffering = false;
    this.log("ok", `Cadangan siap: ${(p.bufEnd - p.pos).toFixed(1)} dtk; pemutaran dimulai.`);
    this.play();
  }
  private play(): void {
    const video = this.video;
    const cycle = this.cycle;
    if (!video || this.userPaused || this.playPending) return;
    this.playPending = true;
    void video.play().catch((err: DOMException) => {
      if (cycle !== this.cycle || err.name === "AbortError") return;
      this.userPaused = true; this.paused = true; this.prebuffering = false;
      this.log("warn", "Klik tombol play untuk melanjutkan pemutaran.");
    }).finally(() => { if (cycle === this.cycle) this.playPending = false; });
  }

  private onPlaying = (): void => {
    if (this.userPaused) { this.video?.pause(); return; }
    if (!this.started && this.attempt > 0) this.metrics.reconnects++;
    this.started = true; this.prebuffering = false; this.paused = false;
    this.attempt = 0; this.countdownSec = 0;
    this.status = "delay"; this.updatePlayback(); this.emit();
  };
  private onWaiting = (): void => {
    if (this.userPaused || this.prebuffering || !this.started) return;
    const range = this.video && bufferedAt(this.video.buffered, this.video.currentTime);
    // A busy decoder is not a network shortage. Pausing here creates a pause/play race.
    if (range && this.video && range.end - this.video.currentTime > 1) return;
    this.metrics.stalls++;
    this.log("warn", "Cadangan habis; mengisi ulang buffer sebelum melanjutkan.");
    this.beginGate();
  };
  private onPause = (): void => {
    // pause events are queued: an internal pause can arrive after play().
    // User intent is owned by pausePlayback(), never inferred from this event.
    this.paused = this.userPaused;
    this.emit();
  };
  private onPlay = (): void => { this.paused = false; this.emit(); };
  private onProgress = (): void => { this.tryStart(); };
  private onNativeError = (): void => {
    if (!this.hls && this.video?.error) this.scheduleReconnect("Stream native gagal dimuat.");
  };
  private events: Array<[string, EventListener]> = [
    ["playing", this.onPlaying], ["waiting", this.onWaiting], ["pause", this.onPause],
    ["play", this.onPlay], ["progress", this.onProgress], ["loadeddata", this.onProgress],
    ["seeked", this.onProgress], ["error", this.onNativeError],
  ];

  private onHlsError(data: ErrorData): void {
    if (!data.fatal) return; // ordinary HLS retries do not need a player restart
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered && this.hls) {
      this.mediaRecovered = true;
      this.log("warn", `Memulihkan decoder (${data.details}).`);
      this.hls.recoverMediaError(); return;
    }
    this.scheduleReconnect(data.details);
  }
  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) return;
    this.cycle++; // invalidate callbacks before destroying the old instance
    this.hls?.destroy(); this.hls = null;
    this.prebuffering = false;
    const offline = this.attempt >= BACKOFF.length;
    const wait = offline ? 60000 : BACKOFF[this.attempt++];
    this.status = offline ? "offline" : "reconnecting";
    this.video?.pause();
    this.reconnectAt = Date.now() + wait;
    this.log("warn", `Sambung ulang dalam ${wait / 1000} dtk: ${reason}`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      if (offline) this.attempt = 0;
      this.startCycle();
    }, wait);
  }

  private updatePlayback(): void {
    const video = this.video;
    if (!video) return;
    if (!this.hls && video.seekable.length) this.dvr = {
      start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1),
    };
    const range = bufferedAt(video.buffered, video.currentTime);
    const start = this.dvr?.start ?? -1, end = this.dvr?.end ?? -1;
    this.playback = { pos: video.currentTime, bufStart: range?.start ?? -1,
      bufEnd: range?.end ?? -1, edge: end,
      windowStart: range ? Math.min(start >= 0 ? start : range.start, range.start) : start,
      windowEnd: end, dvrState: end > start && start >= 0 ? "ready" :
        Date.now() - this.cycleAt > 20000 ? "unavailable" : "loading" };
  }
  private tick(): void {
    const video = this.video;
    if (!video) return;
    const now = Date.now();
    this.updatePlayback();
    // A seek/source update may abort play() after the buffer gate opens.
    // Retry the desired playback; only explicit user intent keeps it paused.
    if (!this.userPaused && !this.prebuffering && video.paused &&
      (this.status === "loading" || this.status === "delay" || this.status === "live")) this.play();
    this.metrics.uptimeSec = Math.floor((now - this.connectedAt) / 1000);
    if (this.reconnectTimer) this.countdownSec = Math.max(0, Math.ceil((this.reconnectAt - now) / 1000));
    else if (this.prebuffering) {
      if (this.started) this.guardDvrWindow();
      this.tryStart();
      if (this.prebuffering && this.detectionReady && now - this.gateAt > 45000) this.scheduleReconnect("Buffer tidak terisi dalam 45 detik.");
    } else if (this.started && !this.userPaused && (this.status === "delay" || this.status === "live")) {
      this.guardDvrWindow();
      this.status = this.playback.edge - this.playback.pos <= 3 ? "live" : "delay";
    }
    const quality = video.getVideoPlaybackQuality?.();
    if (quality && now - this.prevFramesAt >= 2000) {
      if (this.prevFramesAt) this.metrics.fps = Math.round((quality.totalVideoFrames - this.prevFrames) * 1000 / (now - this.prevFramesAt));
      this.prevFrames = quality.totalVideoFrames; this.prevFramesAt = now;
    }
    if (video.videoWidth) { this.metrics.width = video.videoWidth; this.metrics.height = video.videoHeight; }
    if (now - this.lastTelemetry >= 2000) {
      this.lastTelemetry = now;
      const p = this.playback;
      this.telemetry.push({ t: now, pos: p.pos, bufStart: p.bufStart, bufEnd: p.bufEnd,
        edge: p.edge, delay: p.edge >= 0 ? Math.max(0, p.edge - p.pos) : -1,
        gap: p.bufEnd >= 0 ? Math.max(0, p.bufEnd - p.pos) : 0,
        stalls: this.metrics.stalls, status: this.status, prebuffering: this.prebuffering,
        droppedFrames: quality?.droppedVideoFrames ?? 0 });
      if (this.telemetry.length > 2000) this.telemetry.shift();
    }
    this.emit();
  }
  private log(level: LogLevel, message: string): void {
    this.logEntries.push(makeLogEntry(level, message));
    if (this.logEntries.length > 300) this.logEntries.shift();
    this.emit();
  }
  private snapshot(): StreamSnapshot {
    return { status: this.status, paused: this.paused, prebuffering: this.prebuffering,
      playback: { ...this.playback }, delaySec: this.playback.edge >= 0
        ? Math.max(0, Math.round(this.playback.edge - this.playback.pos)) : 0,
      attempt: this.attempt, maxAttempts: BACKOFF.length, countdownSec: this.countdownSec,
      errorCode: this.errorCode, metrics: { ...this.metrics }, log: [...this.logEntries] };
  }
  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}
