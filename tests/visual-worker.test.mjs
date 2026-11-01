import { test } from "node:test";
import assert from "node:assert/strict";
import { VisualTracker } from "../dashboard/src/detection/visualTracker.ts";

class FakeWorker {
  static latest;
  requests = [];
  terminated = false;
  constructor() { FakeWorker.latest = this; }
  postMessage(message) { this.requests.push(message); }
  reply(data) { this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;
globalThis.window = globalThis;
const captures = [];
globalThis.createImageBitmap = () => new Promise((resolve) => captures.push(resolve));
const video = { videoWidth: 1920, videoHeight: 1080 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const bitmap = () => ({ width: 640, height: 360, closed: false, close() { this.closed = true; } });

test("visual worker receives negative evidence at the original capture timestamp", () => {
  const tracker = new VisualTracker(() => {}, assert.fail), worker = FakeWorker.latest;
  const rejected = [{ label: "motor", classId: 3, bbox: [90, 110, 40, 65], confidence: .3, timestamp: 0 }];
  tracker.anchor({ framePts: 4, detections: [], rejectedDetections: rejected }, video);
  assert.equal(worker.requests[0].pts, 4);
  assert.deepEqual(worker.requests[0].rejectedDetections, rejected);
  tracker.dispose();
});

test("visual capture has its own bounded lock and only a frame ack releases it", async () => {
  const snapshots = [], errors = [];
  const tracker = new VisualTracker((s) => snapshots.push(s), (e) => errors.push(e));
  const worker = FakeWorker.latest;
  assert.equal(tracker.capture(video, 1), true);
  assert.equal(tracker.capture(video, 1.04), false);
  captures.shift()(bitmap()); await tick();
  assert.equal(worker.requests[0].pts, 1);
  worker.reply({ type: "motion", generation: 0, ack: false, snapshot: { framePts: 1, detections: [] } });
  assert.equal(tracker.capture(video, 1.08), false);
  worker.reply({ type: "motion", generation: 0, ack: true, snapshot: { framePts: 1, detections: [] } });
  assert.equal(tracker.capture(video, 1.12), true);
  captures.shift()(bitmap()); await tick();
  assert.equal(snapshots.length, 2); assert.deepEqual(errors, []);
  tracker.dispose();
});

test("seek discards both a pending bitmap and old-generation worker snapshots", async () => {
  const snapshots = [];
  const tracker = new VisualTracker((s) => snapshots.push(s), assert.fail);
  const worker = FakeWorker.latest;
  tracker.capture(video, 8);
  tracker.reset();
  const old = bitmap(); captures.shift()(old); await tick();
  assert.equal(old.closed, true);
  assert.equal(worker.requests.filter((m) => m.type === "frame").length, 0);
  worker.reply({ type: "motion", generation: 0, ack: true, snapshot: { framePts: 8, detections: [] } });
  assert.equal(snapshots.length, 0);
  assert.equal(tracker.capture(video, 2), true);
  captures.shift()(bitmap()); await tick();
  assert.equal(worker.requests.at(-1).generation, 1);
  tracker.dispose(); assert.equal(worker.terminated, true);
});
