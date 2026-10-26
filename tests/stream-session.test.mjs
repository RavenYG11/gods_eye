import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHealth } from "../dashboard/src/lib/streamHealth.ts";

globalThis.window = globalThis;
const ranges = (...pairs) => ({ length: pairs.length, start: (i) => pairs[i][0], end: (i) => pairs[i][1] });
class Video extends EventTarget {
  currentTime = 16; readyState = 4; paused = true; seeking = false;
  videoWidth = 1920; videoHeight = 1080; playbackRate = 1;
  buffered = ranges([16, 40]); seekable = ranges([0, 40]);
  playCount = 0; pauseCount = 0;
  canPlayType() { return "maybe"; }
  removeAttribute() {} load() {}
  async play() {
    this.playCount++; this.paused = false;
    queueMicrotask(() => { this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); });
  }
  pause() {
    this.pauseCount++;
    if (!this.paused) { this.paused = true; queueMicrotask(() => this.dispatchEvent(new Event("pause"))); }
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const camera = { id: "test", name: "test", streamUrl: "https://cctv.test/test.m3u8" };
test("startup waits for both model warmup and contiguous video buffer", async () => {
  const engine = new StreamHealth(), video = new Video();
  let state; engine.subscribe((next) => { state = next; });
  engine.setDetectionReady(false); engine.attach(video, camera);
  video.dispatchEvent(new Event("loadeddata"));
  assert.equal(video.playCount, 0); assert.equal(state.status, "loading");
  engine.setDetectionReady(true); await tick();
  assert.equal(video.playCount, 1); assert.equal(state.prebuffering, false);
  assert.equal(state.delaySec, 24); assert.equal(state.paused, false);
  engine.detach();
});
test("a decoder waiting event with healthy buffer never pauses playback", async () => {
  const engine = new StreamHealth(), video = new Video();
  engine.attach(video, camera); video.dispatchEvent(new Event("loadeddata")); await tick();
  const pauses = video.pauseCount;
  video.dispatchEvent(new Event("waiting"));
  assert.equal(video.pauseCount, pauses);
  // A small buffer alone is also not permission to pause an advancing video.
  video.buffered = ranges([16, 20]); engine.tick();
  assert.equal(video.pauseCount, pauses);
  engine.detach();
});
test("a delayed internal pause event cannot overwrite resumed user intent", async () => {
  const engine = new StreamHealth(), video = new Video();
  let state; engine.subscribe((next) => { state = next; });
  engine.attach(video, camera); video.dispatchEvent(new Event("loadeddata")); await tick();
  video.buffered = ranges([16, 16.2]); video.dispatchEvent(new Event("waiting"));
  video.buffered = ranges([16, 40]); video.dispatchEvent(new Event("progress"));
  await tick();
  assert.equal(state.paused, false); assert.equal(state.prebuffering, false);
  assert.equal(video.paused, false);
  engine.pausePlayback(); await tick();
  assert.equal(state.paused, true);
  engine.resumePlayback(); await tick();
  assert.equal(state.paused, false); engine.detach();
});
test("DVR expiry guard preserves an older frame that remains buffered", async () => {
  const engine = new StreamHealth(), video = new Video();
  engine.attach(video, camera); video.dispatchEvent(new Event("loadeddata")); await tick();
  video.seekable = ranges([20, 60]); engine.tick();
  assert.equal(engine.guardDvrWindow(), false); assert.equal(video.currentTime, 16);
  video.buffered = ranges(); engine.tick();
  assert.ok(video.currentTime >= 20 && video.currentTime < 60);
  engine.detach();
});
test("long model warmup starts inside the current playlist", async () => {
  const engine = new StreamHealth(), video = new Video();
  engine.setDetectionReady(false); engine.attach(video, camera);
  video.buffered = ranges([16, 70]); video.seekable = ranges([30, 70]);
  engine.tick();
  engine.setDetectionReady(true);
  assert.equal(video.currentTime, 46);
  video.dispatchEvent(new Event("seeked")); await tick();
  assert.equal(video.paused, false); engine.detach();
});
test("an aborted play during seek retries without overriding a user pause", async () => {
  const engine = new StreamHealth(), video = new Video();
  let first = true;
  video.play = async () => {
    if (first) { first = false; throw new DOMException("Seek interrupted play", "AbortError"); }
    return Video.prototype.play.call(video);
  };
  engine.attach(video, camera); video.dispatchEvent(new Event("loadeddata")); await tick();
  assert.equal(video.paused, true);
  engine.tick(); await tick();
  assert.equal(video.paused, false);
  engine.pausePlayback(); engine.tick(); await tick();
  assert.equal(video.paused, true); engine.detach();
});
test("manual retry clears the reconnect timer state", () => {
  const engine = new StreamHealth(), video = new Video();
  engine.attach(video, camera);
  engine.reconnectTimer = setTimeout(() => {}, 1000);
  engine.retry();
  assert.equal(engine.reconnectTimer, 0);
  engine.detach();
});
