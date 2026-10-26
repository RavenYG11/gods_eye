import { test } from "node:test";
import assert from "node:assert/strict";
import { MotionTracker } from "../dashboard/src/detection/motionTracker.ts";
import { ByteTracker } from "../dashboard/src/detection/tracker.ts";
import { advanceBox, pyramid, selectFeatures } from "../dashboard/src/detection/opticalFlow.ts";

const texture = (x, y) => 125 + 35 * Math.sin(x * 0.7 + y * 0.27) +
  32 * Math.sin(y * 0.82 - x * 0.23) + 28 * Math.cos(x * 0.41 - y * 0.59);
function image(boxes, width = 320, height = 200) {
  const data = new Uint8Array(width * height);
  data.fill(22);
  for (const [bx, by, bw, bh] of boxes) {
    for (let y = Math.max(0, Math.ceil(by)); y < Math.min(height, by + bh); y++) {
      for (let x = Math.max(0, Math.ceil(bx)); x < Math.min(width, bx + bw); x++) {
        data[y * width + x] = texture((x - bx) * 64 / bw, (y - by) * 48 / bh);
      }
    }
  }
  return { data, width, height };
}
const anchor = (box, pts = 0, id = 1, label = "mobil") => ({ classId: label === "mobil" ? 2 : 3,
  label, confidence: 0.9, bbox: box, timestamp: 0, trackId: id, direction: "unknown",
  stale: false, vx: 0, vy: 0, framePts: pts, lastSeenPts: pts, observations: 5,
  reliable: true, sampleIntervalSec: 0.4 });
const error = (a, b) => Math.hypot(a[0] + a[2] / 2 - b[0] - b[2] / 2,
  a[1] + a[3] / 2 - b[1] - b[3] / 2);

test("optical flow measures translation and perspective scale from pixels", () => {
  const box = [75, 65, 70, 48], next = [77.6, 66.2, 71.4, 48.96];
  const a = pyramid(image([box])), b = pyramid(image([next]));
  const points = selectFeatures(a[0], box);
  assert.ok(points.length >= 8);
  const result = advanceBox(a, b, box, points);
  assert.ok(result);
  assert.ok(error(result.box, next) < 0.6, `center error ${error(result.box, next)}`);
  assert.ok(Math.abs(result.box[2] - next[2]) < 1);
});

test("775ms late YOLO anchor replays real acceleration and then follows a stop/turn", () => {
  const tracker = new MotionTracker();
  const path = (i) => [45 + (i <= 16 ? i * 0.35 + i * i * 0.06 : 21 - (i - 16) * 1.3),
    60 + i * 0.6, 64, 48];
  for (let i = 0; i <= 16; i++) tracker.push(image([path(i)]), i * 0.05);
  let snapshot = tracker.anchor([anchor(path(0))], 0);
  assert.equal(snapshot.detections.length, 1);
  let maxError = error(snapshot.detections[0].bbox, path(16));
  for (let i = 17; i <= 30; i++) {
    snapshot = tracker.push(image([path(i)]), i * 0.05);
    assert.equal(snapshot.detections.length, 1, `lost at frame ${i}`);
    maxError = Math.max(maxError, error(snapshot.detections[0].bbox, path(i)));
  }
  assert.ok(maxError < 1.5, `max alignment error ${maxError.toFixed(2)}px`);
});

test("two vehicles moving in opposite directions stay attached and preserve visual IDs", () => {
  const tracker = new MotionTracker();
  const path = (i) => [[40 + i, 35 + i * 0.25, 48, 36], [210 - i * 1.2, 125 - i * 0.8, 35, 42]];
  tracker.push(image(path(0)), 0);
  const first = tracker.anchor(path(0).map((b, i) => anchor(b, 0, i + 1, i ? "motor" : "mobil")), 0);
  for (let i = 1; i <= 15; i++) tracker.push(image(path(i)), i * 0.05);
  const snapshot = tracker.anchor(path(10).map((b, i) => anchor(b, 0.5, i + 100, i ? "motor" : "mobil")), 0.5);
  assert.equal(snapshot.detections.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(snapshot.detections[i].trackId, first.detections[i].trackId);
    assert.ok(error(snapshot.detections[i].bbox, path(15)[i]) < 1);
  }
});

test("fast vehicles use velocity only to initialize pixel matching, not to invent the output", () => {
  const tracker = new MotionTracker();
  const path = (i) => [470 - i * 9, 210 - i * 2, 90, 60];
  for (let i = 0; i <= 10; i++) tracker.push(image([path(i)], 640, 360), i * 0.05);
  // Deliberately underestimate speed. The actual output must follow the pixels.
  const snapshot = tracker.anchor([{ ...anchor(path(0)), vx: -130, vy: -20 }], 0);
  assert.equal(snapshot.detections.length, 1);
  assert.ok(error(snapshot.detections[0].bbox, path(10)) < 1.5);
  assert.ok(Math.abs(snapshot.detections[0].vx + 180) < 10);
});

test("occlusion loses pixel evidence and removes boxes instead of inventing motion", () => {
  const tracker = new MotionTracker(), box = [70, 60, 64, 48];
  tracker.push(image([box]), 0); tracker.anchor([anchor(box)], 0);
  for (let i = 1; i <= 5; i++) tracker.push(image([]), i * 0.05);
  assert.equal(tracker.snapshot().detections.length, 0);
  // A Kalman coast must never be treated as a new measured anchor.
  tracker.anchor([{ ...anchor(box, 0.25), stale: true }], 0.25);
  assert.equal(tracker.snapshot().detections.length, 0);
});

test("one corrupted video frame recovers from the last measured pixels without changing identity", () => {
  const tracker = new MotionTracker(), box = [70, 60, 64, 48];
  tracker.push(image([box]), 0);
  const first = tracker.anchor([anchor(box)], 0).detections[0];
  tracker.push(image([]), 0.05);
  const nextBox = [72, 61, 64, 48];
  const [recovered] = tracker.push(image([nextBox]), 0.1).detections;
  assert.equal(recovered?.trackId, first.trackId);
  assert.ok(error(recovered.bbox, nextBox) < 0.5);
});

test("at 12fps one failed motion frame remains visible and recovers with the same ID", () => {
  const tracker = new MotionTracker(), box = [70, 80, 64, 48];
  tracker.push(image([box]), 0);
  const first = tracker.anchor([anchor(box)], 0).detections[0];
  assert.equal(tracker.push(image([]), 1 / 12).detections[0].trackId, first.trackId);
  const nextBox = [72, 79, 64, 48];
  const [recovered] = tracker.push(image([nextBox]), 2 / 12).detections;
  assert.equal(recovered.trackId, first.trackId);
  assert.ok(error(recovered.bbox, nextBox) < .5);
});

test("both directions appear from first sighting but only upward traffic increments entries", () => {
  const tracker = new MotionTracker();
  const path = (i) => [[60 + i * .3, 110 - i * 1.4, 48, 36], [210 - i * .2, 40 + i * 1.2, 35, 42]];
  tracker.push(image(path(0)), 0);
  const initial = tracker.anchor(path(0).map((b, i) => anchor(b, 0, i + 1)), 0);
  assert.equal(initial.detections.length, 2);
  assert.ok(initial.detections.every(d => d.direction === "unknown"));
  assert.deepEqual(initial.entries, { mobil: 0, motor: 0 });
  for (let i = 1; i <= 12; i++) tracker.push(image(path(i)), i * .05);
  const shown = tracker.snapshot().detections;
  assert.equal(shown.length, 2); assert.equal(shown[0].direction, "atas");
  assert.equal(shown[1].direction, "bawah");
  assert.deepEqual(tracker.snapshot().entries, { mobil: 1, motor: 0 });
  assert.ok(error(shown[0].bbox, path(12)[0]) < 1);
});

test("target-road mode immediately shows entering vehicles, excludes the other road and hides confirmed downward motion", () => {
  const tracker = new MotionTracker({ targetRoadOnly: true });
  const path = i => [[60, 130 - i * 1.2, 48, 36], [210, 85 + i * 1.2, 35, 42], [210, 5 + i, 35, 32]];
  tracker.push(image(path(0)), 0);
  const first = tracker.anchor(path(0).map((b, i) => ({ ...anchor(b, 0, i + 1), observations: 1, confidence: .4 })), 0);
  assert.equal(first.detections.length, 2);
  assert.ok(first.detections.every(d => d.direction === "unknown"));
  for (let i = 1; i <= 12; i++) tracker.push(image(path(i)), i * .05);
  const shown = tracker.snapshot();
  assert.equal(shown.detections.length, 1);
  assert.equal(shown.detections[0].direction, "atas");
  assert.deepEqual(shown.entries, { mobil: 1, motor: 0 });
});

test("a confirmed weak observation is not rejected by a second birth threshold", () => {
  const tracker = new MotionTracker(), box = [70, 80, 64, 48];
  tracker.push(image([box]), 0);
  assert.equal(tracker.anchor([{ ...anchor(box), confidence: .18, observations: 2 }], 0).detections.length, 1);
});

test("stationary cars and half-visible motorcycles render on the first accepted YOLO observation", () => {
  for (const [label, confidence, box] of [
    ["mobil", .36, [70, 80, 64, 48]],
    ["motor", .26, [0, 140, 22, 45]],
    ["motor", .26, [300, 160, 20, 40]],
  ]) {
    const tracker = new MotionTracker(), detector = new ByteTracker();
    tracker.push(image([box]), 0);
    const raw = { ...anchor(box, 0, 1, label), confidence };
    const first = tracker.anchor(detector.update([raw], 0), 0);
    assert.equal(first.detections.length, 1, `${label} at ${box}`);
    assert.equal(first.detections[0].observations, 1);
    assert.equal(first.detections[0].direction, "unknown");
    for (let i = 1; i <= 10; i++) tracker.push(image([box]), i * .05);
    assert.equal(tracker.snapshot().detections.length, 1);
    assert.deepEqual(tracker.snapshot().entries, { mobil: 0, motor: 0 });
  }
});

test("a clipped entry expands to the full observed car instead of retaining a tiny birth box", () => {
  const tracker = new MotionTracker();
  const path = i => [300 - i * 3, 100, 64, 48];
  const visible = i => { const b = path(i); return [b[0], b[1], Math.min(64, 320 - b[0]), 48]; };
  tracker.push(image([path(0)]), 0);
  const first = tracker.anchor([anchor(visible(0))], 0).detections[0];
  assert.ok(first);
  let snapshot;
  for (let i = 1; i <= 20; i++) {
    snapshot = tracker.push(image([path(i)]), i * .05);
    if (i % 4 === 0) snapshot = tracker.anchor([anchor(visible(i), i * .05)], i * .05);
  }
  assert.equal(snapshot.detections.length, 1);
  assert.equal(snapshot.detections[0].trackId, first.trackId);
  assert.ok(Math.abs(snapshot.detections[0].bbox[2] - 64) < 5);
  assert.ok(error(snapshot.detections[0].bbox, path(20)) < 3);
});

test("a textureless first observation is visible briefly without fabricating motion or counts", () => {
  const tracker = new MotionTracker(), box = [70, 80, 64, 48];
  const plain = () => ({ width: 320, height: 200, data: new Uint8Array(320 * 200).fill(80) });
  tracker.push(plain(), 0);
  const first = tracker.anchor([{ ...anchor(box), confidence: .36, observations: 1 }], 0);
  assert.equal(first.detections.length, 1);
  assert.deepEqual(first.entries, { mobil: 0, motor: 0 });
  tracker.push(plain(), .2);
  assert.equal(tracker.snapshot().detections.length, 1);
  tracker.push(plain(), .65);
  assert.equal(tracker.snapshot().detections.length, 0);
});

test("entries count cars and motorcycles once through stops, delayed anchors and detector ID changes", () => {
  const tracker = new MotionTracker();
  const path = i => [[50, 140 - Math.min(i, 15), 48, 36], [210, 140 - Math.min(i, 15), 35, 42]];
  tracker.push(image(path(0)), 0);
  const first = tracker.anchor(path(0).map((b, i) => anchor(b, 0, i + 1, i ? "motor" : "mobil")), 0);
  for (let i = 1; i <= 24; i++) {
    tracker.push(image(path(i)), i * .05);
    if (i === 20) tracker.anchor(path(12).map((b, j) => anchor(b, .6, j + 100, j ? "motor" : "mobil")), .6);
  }
  const end = tracker.snapshot();
  assert.deepEqual(end.entries, { mobil: 1, motor: 1 });
  assert.deepEqual(end.detections.map(d => d.trackId), first.detections.map(d => d.trackId));
  assert.deepEqual(tracker.snapshot().entries, end.entries);
  tracker.reset();
  assert.deepEqual(tracker.snapshot().entries, { mobil: 0, motor: 0 });
});

test("detector direction flags and stationary box jitter cannot increment entries", () => {
  const tracker = new MotionTracker(), box = [70, 80, 64, 48];
  tracker.push(image([box]), 0);
  tracker.anchor([{ ...anchor(box), direction: "atas" }], 0);
  for (let i = 1; i <= 20; i++) {
    tracker.push(image([box]), i * .05);
    if (i % 4 === 0) tracker.anchor([{ ...anchor([70, 80 - i % 3, 64, 48], i * .05), direction: "atas" }], i * .05);
  }
  assert.deepEqual(tracker.snapshot().entries, { mobil: 0, motor: 0 });
});

test("a strong first sighting can start after real upward pixel motion, but weak noise cannot", () => {
  const tracker = new MotionTracker();
  const path = (i) => [70, 120 - i, 48, 36];
  for (let i = 0; i <= 8; i++) tracker.push(image([path(i)]), i * .05);
  assert.equal(tracker.anchor([{ ...anchor(path(0)), observations: 1, confidence: .2 }], 0).detections.length, 0);
  const [first] = tracker.anchor([{ ...anchor(path(0)), observations: 1, confidence: .9 }], 0).detections;
  assert.equal(first?.direction, "atas");
  assert.ok(error(first.bbox, path(8)) < 1);
});

test("continuous upward pixel evidence bridges model misses, while the model deadline stays bounded", () => {
  const tracker = new MotionTracker();
  const path = (i) => [70, 150 - i, 48, 36];
  tracker.push(image([path(0)]), 0); tracker.anchor([anchor(path(0))], 0);
  for (let i = 1; i <= 70; i++) tracker.push(image([path(i)]), i * .05);
  assert.equal(tracker.snapshot().detections.length, 1);
  assert.equal(tracker.snapshot().detections[0].lastSeenPts, 0);
  for (let i = 71; i <= 83; i++) tracker.push(image([path(i)]), i * .05);
  assert.equal(tracker.snapshot().detections.length, 0);
});

test("a short compute gap does not reset all visual IDs", () => {
  const tracker = new MotionTracker();
  const boxes = [[40, 60, 48, 36], [180, 110, 48, 36]];
  tracker.push(image(boxes), 0);
  tracker.anchor(boxes.map((b, i) => anchor(b, 0, i + 10)), 0);
  tracker.push(image(boxes), .4);
  const recovered = tracker.anchor([anchor(boxes[1], .4, 11)], .4).detections;
  assert.equal(recovered.find(d => d.bbox[0] > 150)?.trackId, 2);
});

test("historical replay yields between frames and catches live frames without freezing existing tracks", () => {
  const tracker = new MotionTracker();
  const path = (i) => [[50 + i * .5, 120 - i * .5, 48, 36], [210 - i * .3, 60 + i * .3, 35, 42]];
  tracker.push(image(path(0)), 0);
  const old = tracker.anchor([anchor(path(0)[1], 0, 20)], 0).detections[0];
  for (let i = 1; i <= 8; i++) tracker.push(image(path(i)), i * .05);
  const replay = tracker.anchorSteps([anchor(path(0)[0], 0, 21)], 0);
  let step = replay.next(), count = 0, live = 8;
  assert.equal(step.done, false);
  assert.equal(tracker.snapshot().detections.length, 1);
  while (!step.done) {
    if (count % 2 === 0 && live < 12) {
      live++;
      const snapshot = tracker.push(image(path(live)), live * .05);
      assert.equal(snapshot.detections[0].trackId, old.trackId);
      assert.equal(snapshot.detections[0].framePts, live * .05);
    }
    count++;
    assert.ok(count < 80);
    step = replay.next();
  }
  assert.ok(count >= 12);
  assert.equal(step.value.detections.length, 2);
  assert.ok(error(step.value.detections.find(d => d.trackId !== old.trackId).bbox, path(live)[0]) < 1);
});

test("repeated delayed model corrections reduce an offset without accumulating the same old error", () => {
  const tracker = new MotionTracker();
  const path = (i) => [70 + i * .3, 140 - i * .8, 64, 48];
  tracker.push(image([path(0)]), 0);
  tracker.anchor([anchor([80, 140, 64, 48])], 0);
  let snapshot;
  for (let i = 1; i <= 60; i++) {
    snapshot = tracker.push(image([path(i)]), i * .05);
    if (i >= 12 && i % 4 === 0) snapshot = tracker.anchor([anchor(path(i - 12), (i - 12) * .05)], (i - 12) * .05);
    assert.equal(snapshot.detections.length, 1);
    const offset = snapshot.detections[0].bbox[0] - path(i)[0];
    assert.ok(offset > -1 && offset < 11, `correction oscillated: ${offset}`);
  }
  assert.ok(error(snapshot.detections[0].bbox, path(60)) < 2);
});

test("seek, resolution changes and expired model anchors cannot resurrect old vehicles", () => {
  const tracker = new MotionTracker(), box = [70, 60, 64, 48];
  tracker.push(image([box]), 10); tracker.anchor([anchor(box, 10)], 10);
  assert.equal(tracker.push(image([box]), 2).detections.length, 0);
  assert.equal(tracker.anchor([anchor(box, 10)], 10).detections.length, 0);
  tracker.anchor([anchor(box, 2)], 2);
  assert.equal(tracker.push(image([box], 640, 400), 2.05).detections.length, 0);
  tracker.anchor([anchor(box, 2.05)], 2.05);
  for (let i = 1; i < 50; i++) tracker.push(image([box], 640, 400), 2.05 + i * 0.05);
  assert.equal(tracker.snapshot().detections.length, 0);
});
