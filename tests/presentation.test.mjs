import { test } from "node:test";
import assert from "node:assert/strict";
import { BoxPresenter } from "../dashboard/src/detection/boxPresenter.ts";
import { inferenceRegion, restoreRegion } from "../dashboard/src/detection/detectionRegions.ts";
import { compensateDelivery } from "../dashboard/src/detection/presentationTiming.ts";

const det = (pts, jitter = 0) => ({ classId: 2, label: "mobil", confidence: .8,
  bbox: [100 + pts * 40 + jitter, 250 - pts * 70, 60, 45], trackId: 1,
  timestamp: 0, framePts: pts, lastSeenPts: pts, observations: 5, reliable: true,
  stale: false, direction: "atas", vx: 40, vy: -70, motionIntervalSec: 1 / 12, coastSec: .25 });

test("60Hz presentation follows 12fps measurements without adding a tracking interval of lag", () => {
  const presenter = new BoxPresenter();
  let maxError = 0;
  for (let i = 20; i < 120; i++) {
    const pts = i / 60, captured = Math.floor((pts - .05) * 12) / 12;
    presenter.begin(pts, new Set([1]));
    const shown = presenter.present(det(captured), pts);
    assert.ok(shown);
    maxError = Math.max(maxError, Math.hypot(shown.bbox[0] - (100 + pts * 40), shown.bbox[1] - (250 - pts * 70)));
  }
  assert.ok(maxError < .1, `added lag/position error ${maxError}`);
});

test("detector jitter is damped without suppressing the real vehicle motion", () => {
  const presenter = new BoxPresenter();
  let sum = 0, samples = 0;
  for (let i = 20; i < 180; i++) {
    const pts = i / 60, frame = Math.floor((pts - .05) * 12), captured = frame / 12;
    const jitter = frame % 2 ? 2 : -2;
    presenter.begin(pts, new Set([1]));
    const shown = presenter.present(det(captured, jitter), pts);
    if (i > 30) { sum += (shown.bbox[0] - (100 + pts * 40)) ** 2; samples++; }
    assert.ok(Math.abs(shown.bbox[1] - (250 - pts * 70)) < .1);
  }
  const rms = Math.sqrt(sum / samples);
  assert.ok(rms < 1.5, `filtered jitter RMS ${rms}px; raw jitter 2px`);
});

test("stale pixel evidence expires and seeking immediately discards presentation history", () => {
  const presenter = new BoxPresenter();
  presenter.begin(1, new Set([1])); presenter.present(det(1), 1);
  assert.equal(presenter.present(det(1), 1.4), null);
  presenter.begin(.5, new Set([1]));
  assert.deepEqual(presenter.present(det(.5), .5).bbox, det(.5).bbox);
});

test("12fps delivery latency and one delayed result do not clear still-verified pixels between updates", () => {
  const presenter = new BoxPresenter();
  const results = Array.from({ length: 30 }, (_, i) => ({ capture: i / 12,
    delivered: i / 12 + .14 + (i % 5 === 3 ? .1 : 0) })).sort((a, b) => a.delivered - b.delivered);
  let cursor = 0, lag = .08, snapshot;
  for (let i = 10; i < 140; i++) {
    const pts = i / 60;
    while (cursor < results.length && results[cursor].delivered <= pts) {
      const raw = { framePts: results[cursor].capture, detections: [det(results[cursor].capture)] };
      // A superseded result cannot replace a newer snapshot.
      if (!snapshot || raw.framePts >= snapshot.framePts) {
        const next = compensateDelivery(raw, pts, lag); snapshot = next.snapshot; lag = next.lag;
      }
      cursor++;
    }
    presenter.begin(pts, new Set([1]));
    assert.ok(presenter.present(snapshot.detections[0], pts), `blanked at ${pts}`);
  }
});

test("delivery compensation never resurrects a worker-omitted track or extends a dead worker forever", () => {
  const presenter = new BoxPresenter();
  const compensated = compensateDelivery({ framePts: 1, detections: [det(1)] }, 1.2);
  assert.ok(compensated.snapshot.detections[0].coastSec <= .6);
  assert.equal(presenter.present(compensated.snapshot.detections[0], 1.8), null);
  const missing = compensateDelivery({ framePts: 1.3, detections: [] }, 1.5, compensated.lag);
  assert.deepEqual(missing.snapshot.detections, []);
});

test("detail views keep real frame-edge vehicles and reject only artificial crop seams", () => {
  const overview = inferenceRegion(960, 540, 3), detail = inferenceRegion(960, 540, 5);
  assert.equal(overview.width, 960); assert.equal(overview.height, 540);
  assert.ok(detail.width < 960); assert.equal(detail.height, 540);
  const d = { ...det(0), bbox: [50, 30, 80, 50] };
  assert.deepEqual(restoreRegion([d], overview)[0].bbox, d.bbox);
  assert.deepEqual(restoreRegion([d], detail)[0].bbox, [50 + detail.x, 30 + detail.y, 80, 50]);
  assert.equal(restoreRegion([{ ...d, bbox: [0, 30, 80, 50] }], detail).length, 1);
  assert.equal(restoreRegion([{ ...d, bbox: [50, detail.height - 30, 80, 30] }], detail).length, 1);
  assert.equal(restoreRegion([{ ...d, bbox: [50, 0, 80, 50] }], detail).length, 1);
  assert.deepEqual(restoreRegion([{ ...d, bbox: [detail.width - 30, 40, 30, 50] }], detail), []);
  const right = inferenceRegion(960, 540, 0), far = inferenceRegion(960, 540, 1);
  const edge = { ...d, bbox: [right.width - 40, 40, 40, 60] };
  assert.equal(restoreRegion([edge], right)[0].bbox[0], 920);
  assert.equal(restoreRegion([{ ...d, bbox: [20, 0, 25, 30] }], far).length, 1);
  for (let sequence = 0; sequence < 24; sequence += 2) {
    const entry = inferenceRegion(960, 540, sequence);
    assert.equal(entry.detail, true);
    assert.equal(entry.x + entry.width, 960);
    assert.equal(entry.y + entry.height, 540);
    assert.ok(entry.x > 0);
  }
});

test("motorcycle coverage is evenly spaced across full height without reducing right-entry car scale", () => {
  const regions = Array.from({ length: 6 }, (_, i) => inferenceRegion(960, 540, i));
  const includes = (r, x, y) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  for (const [x, y] of [[.26 * 960, .24 * 540], [.1 * 960, .98 * 540]]) {
    assert.deepEqual(regions.flatMap((r, i) => includes(r, x, y) ? [i] : []), [1, 3, 5]);
  }
  assert.deepEqual(regions.flatMap((r, i) => includes(r, .85 * 960, .75 * 540) ? [i] : []), [0, 2, 3, 4]);
  // On the 16:9 camera, extending the crop into padding does not change scale.
  const oldWidth = Math.round(960 * .68), oldHeight = 540 - Math.round(540 * .28);
  const oldScale = Math.min(640 / oldWidth, 640 / oldHeight);
  const current = regions[0];
  assert.equal(Math.min(640 / current.width, 640 / current.height), oldScale);
});
