import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteTracker, predictBbox } from "../dashboard/src/detection/tracker.ts";
import { parseYolo26nOutput, letterboxParams } from "../dashboard/src/detection/yolo26n.ts";
import { WorkerVehicleDetector } from "../dashboard/src/detection/workerDetector.ts";
import { canAnchor } from "../dashboard/src/detection/motionPolicy.ts";

const det = (x, y = 100, score = 0.9, size = 30) => ({ classId: 2, label: "mobil",
  confidence: score, bbox: [x, y, size, size], timestamp: 0 });
test("tracker keeps IDs and predicts through irregular inference intervals", () => {
  const tracker = new ByteTracker();
  let pts = 0, id;
  for (const dt of [0, 0.1, 0.12, 0.35, 0.15, 0.5, 0.2, 0.25]) {
    pts += dt;
    const [track] = tracker.update([det(100 + pts * 80)], pts);
    id ??= track.trackId;
    assert.equal(track.trackId, id);
    assert.ok(Math.abs(track.bbox[0] - (100 + pts * 80)) < 8);
  }
});
test("lost track prediction uses current PTS exactly once", () => {
  const tracker = new ByteTracker();
  for (let i = 0; i < 10; i++) tracker.update([det(i * 10)], i * 0.1);
  const [lost] = tracker.update([], 1);
  assert.equal(lost.framePts, 1);
  assert.equal(lost.lastSeenPts, 0.9);
  assert.ok(lost.bbox[0] > 90 && lost.bbox[0] < 110);
  assert.deepEqual(predictBbox(lost.bbox, lost.vx, lost.vy, 0), lost.bbox);
  for (let i = 11; i < 17; i++) tracker.update([], i / 10);
  assert.equal(tracker.update([], 1.7).length, 0);
});
test("low confidence sustains an existing track but does not create one", () => {
  const tracker = new ByteTracker();
  const [first] = tracker.update([det(10)], 0);
  const [next] = tracker.update([det(12, 100, 0.2)], 0.1);
  assert.equal(first.trackId, next.trackId);
  assert.equal(next.stale, false);
  assert.equal(new ByteTracker().update([det(10, 100, 0.2)], 0).length, 0);
});
test("different vehicle sizes cannot steal an existing ID", () => {
  const tracker = new ByteTracker();
  const [first] = tracker.update([det(10)], 0);
  const tracks = tracker.update([det(11, 100, 0.9, 200)], 0.1);
  assert.ok(tracks.find((t) => !t.stale).trackId !== first.trackId);
});
test("seek backwards resets velocity and large forward discontinuities reset tracks", () => {
  const tracker = new ByteTracker();
  tracker.update([det(10)], 10); tracker.update([det(20)], 10.2);
  const [back] = tracker.update([det(300)], 5);
  assert.equal(back.vx, 0); assert.equal(back.bbox[0], 300);
  const [forward] = tracker.update([det(400)], 50);
  assert.equal(forward.vx, 0);
});
test("parser maps letterbox coordinates and rejects nonfinite boxes", () => {
  const data = new Float32Array(1800);
  data.set([64, 204, 128, 268, 0.9, 2]);
  data.set([NaN, 204, 128, 268, 0.9, 2], 6);
  const results = parseYolo26nOutput(data, { srcW: 1920, srcH: 1080,
    lb: letterboxParams(1920, 1080), timestamp: 123 });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].bbox, [192, 192, 192, 192]);
});
test("custom model class IDs follow training order", () => {
  const data = new Float32Array(1800);
  data.set([10, 10, 50, 60, 0.9, 0]);
  const result = parseYolo26nOutput(data, { srcW: 640, srcH: 640,
    lb: letterboxParams(640, 640), timestamp: 0, classMap: { 0: "motor" } });
  assert.equal(result[0].label, "motor");
});

test("fixed class thresholds accept motorcycles separately from cars", () => {
  const tracker = new ByteTracker();
  assert.equal(tracker.update([det(10, 100, 0.3)], 0).length, 0);
  const motor = { ...det(10, 100, 0.3), label: "motor", classId: 3 };
  assert.equal(tracker.update([motor], 0.1).length, 1);
});

test("partial bottom entries may start immediately while interior and opposite-road gates stay unchanged", () => {
  const size = { width: 320, height: 200 };
  const car = { ...det(260, 177, .26), bbox: [260, 177, 60, 23] };
  const motor = { ...det(80, 180, .19), label: 'motor', classId: 3, bbox: [80, 180, 20, 20] };
  const born = new ByteTracker().update([car, motor], 0, size);
  assert.equal(born.length, 2);
  assert.ok(born.every(d => d.observations === 1 && canAnchor(d)));
  assert.equal(new ByteTracker().update([{ ...car, bbox: [150, 120, 60, 23] }], 0, size).length, 0);
  assert.equal(new ByteTracker().update([{ ...car, bbox: [290, 30, 30, 23] }], 0, size).length, 0);
  assert.equal(new ByteTracker().update([{ ...car, confidence: .15 }], 0, size).length, 0);
});

test("a clipped birth keeps its identity when more body appears with a weaker observation", () => {
  const tracker = new ByteTracker(), size = { width: 320, height: 200 };
  const first = { ...det(300, 175, .26), bbox: [300, 175, 20, 25] };
  const [born] = tracker.update([first], 0, size);
  const full = { ...first, confidence: .2, bbox: [272, 140, 48, 55] };
  const [next] = tracker.update([full], .15, size);
  assert.equal(next.trackId, born.trackId);
  assert.equal(next.stale, false);
  assert.deepEqual(next.bbox, full.bbox);
});

const weakMotor = (x, y, confidence = .115) => ({ ...det(x, y, confidence), label: "motor", classId: 3,
  bbox: [x, y, 20, 40] });
test("two consistent weak upward motorcycle observations can establish and sustain one ID", () => {
  const tracker = new ByteTracker(), size = { width: 960, height: 540 };
  assert.equal(tracker.update([weakMotor(400, 240)], 0, size).length, 0);
  const [born] = tracker.update([weakMotor(395, 229, .105)], .35, size);
  assert.equal(born.label, "motor"); assert.equal(born.observations, 2);
  assert.equal(born.confidence, .105); assert.equal(canAnchor(born), true);
  const [next] = tracker.update([weakMotor(390, 218)], .7, size);
  assert.equal(next.trackId, born.trackId); assert.equal(next.stale, false);
});

test("weak motorcycle proposals reject static, downward, expired, opposite-road and person hypotheses", () => {
  const size = { width: 960, height: 540 };
  for (const [first, second, delay] of [
    [weakMotor(400, 240), weakMotor(400, 240), .3],
    [weakMotor(400, 240), weakMotor(405, 251), .3],
    [weakMotor(400, 240), weakMotor(395, 229), 1.3],
    [weakMotor(900, 80), weakMotor(895, 69), .3],
    [{ ...weakMotor(400, 240), label: "person", classId: 0 }, { ...weakMotor(395, 229), label: "person", classId: 0 }, .3],
    [weakMotor(400, 240), weakMotor(395, 229, .09), .3],
    [weakMotor(400, 240), { ...weakMotor(395, 229), bbox: [395, 229, 60, 120] }, .3],
  ]) {
    const tracker = new ByteTracker();
    tracker.update([first], 0, size);
    assert.equal(tracker.update([second], delay, size).length, 0);
  }
  const tracker = new ByteTracker(); tracker.update([weakMotor(400, 240)], 0, size); tracker.reset();
  assert.equal(tracker.update([weakMotor(395, 229)], .3, size).length, 0);
});

test("proposal parse floor retains weak motorcycles without lowering car or explicit thresholds", () => {
  const data = new Float32Array(1800); data.set([100, 100, 120, 140, .11, 3]);
  data.set([200, 100, 240, 140, .11, 2], 6);
  const options = { srcW: 640, srcH: 640, lb: letterboxParams(640, 640), timestamp: 0 };
  const parsed = parseYolo26nOutput(data, { ...options, confidenceThreshold: .12 });
  assert.equal(parsed.length, 1); assert.equal(parsed[0].label, "motor");
  assert.equal(parseYolo26nOutput(data, { ...options, confidenceThreshold: .4 }).length, 0);
});

test("observed anchors use the actual model box, without Kalman lag", () => {
  const tracker = new ByteTracker();
  tracker.update([det(100)], 0);
  const measured = det(170);
  const [track] = tracker.update([measured], 0.435);
  assert.equal(track.trackId, 1);
  assert.deepEqual(track.bbox, measured.bbox);
});

test("a recently lost confirmed track recovers through a weak observation", () => {
  const tracker = new ByteTracker();
  let first;
  for (let i = 0; i < 6; i++) [first] = tracker.update([det(100 + i * 20)], i * 0.435);
  tracker.update([], 6 * 0.435); tracker.update([], 7 * 0.435);
  const result = tracker.update([det(260, 100, 0.22)], 8 * 0.435);
  const recovered = result.find((track) => !track.stale);
  assert.equal(recovered?.trackId, first.trackId);
  assert.equal(recovered?.lastSeenPts, 8 * 0.435);
});

class FakeVideo { readyState = 4; videoWidth = 1920; videoHeight = 1080; currentTime = 10; }
class FakeWorker {
  static current;
  requests = [];
  terminated = false;
  constructor() { FakeWorker.current = this; }
  postMessage(message) {
    this.requests.push(message);
    if (message.type === "init") queueMicrotask(() => this.reply({ type: "ready", modelUrl: "model", provider: "wasm" }));
  }
  reply(data) { this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;
globalThis.HTMLVideoElement = FakeVideo;
globalThis.window = globalThis;
let releaseCapture;
globalThis.createImageBitmap = () => new Promise((resolve) => {
  releaseCapture = () => resolve({ width: 960, height: 540, close() {} });
});
const init = async () => {
  const detector = new WorkerVehicleDetector();
  await detector.init({ modelUrl: "model", labels: [], fallbackUrl: "", wasmBase: "" });
  return detector;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const result = (id, x = 10) => ({ type: "result", requestId: id, frame: {
  cameraId: "", framePts: 10, wallTime: 0, inferMs: 5,
  detections: [{ ...det(x), vx: 5, vy: 6, framePts: 10, lastSeenPts: 10 }],
} });
test("skipped calls never unlock an active capture or inference", async () => {
  const detector = await init();
  const video = new FakeVideo();
  const first = detector.detectFrame(video);
  assert.equal(await detector.detectFrame(video), null);
  assert.equal(await detector.detectFrame(video), null);
  releaseCapture(); await tick();
  const worker = FakeWorker.current;
  const requests = worker.requests.filter((m) => m.type === "detect");
  assert.equal(requests.length, 1);
  assert.equal(await detector.detectFrame(video), null);
  worker.reply(result(requests[0].requestId));
  const frame = await first;
  assert.deepEqual(frame.detections[0].bbox, [20, 200, 60, 60]);
  assert.equal(frame.detections[0].vx, 10);
  await detector.dispose();
});

test("rejected capture-time boxes are scaled with accepted detections", async () => {
  const detector = await init(), video = new FakeVideo();
  const pending = detector.detectFrame(video);
  releaseCapture(); await tick();
  const worker = FakeWorker.current, response = result(worker.requests.find(m => m.type === "detect").requestId);
  response.frame.rejectedDetections = [{ ...det(20), label: "motor", classId: 3 }];
  worker.reply(response);
  const frame = await pending;
  assert.deepEqual(frame.rejectedDetections[0].bbox, [40, 200, 60, 60]);
  await detector.dispose();
});
test("capture PTS is frozen before bitmap extraction and unrelated responses are ignored", async () => {
  const detector = await init(), video = new FakeVideo();
  const first = detector.detectFrame(video);
  video.currentTime = 11;
  releaseCapture(); await tick();
  const worker = FakeWorker.current;
  const request = worker.requests.find((m) => m.type === "detect");
  assert.equal(request.framePts, 10);
  worker.reply(result(request.requestId + 1));
  let done = false; first.then(() => { done = true; }); await tick();
  assert.equal(done, false);
  worker.reply(result(request.requestId)); await first; await detector.dispose();
});
test("seek invalidates results and disposing settles an outstanding promise", async () => {
  const detector = await init(), video = new FakeVideo();
  const pending = detector.detectFrame(video);
  releaseCapture(); await tick();
  detector.reset();
  const worker = FakeWorker.current;
  worker.reply(result(worker.requests.find((m) => m.type === "detect").requestId));
  assert.equal(await pending, null);
  const next = detector.detectFrame(video);
  releaseCapture(); await tick();
  await detector.dispose();
  assert.equal(await next, null); assert.equal(worker.terminated, true);
});
