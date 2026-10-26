import { test } from "node:test";
import assert from "node:assert/strict";

test("new YOLO results cannot starve an unfinished vehicle replay; pending work stays bounded", async () => {
  const messages = [], timers = new Map();
  let nextTimer = 1;
  globalThis.self = {
    postMessage: m => messages.push(m),
    setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
  };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return {
      drawImage: bitmap => { this.bitmap = bitmap; }, getImageData: () => this.bitmap,
    }; }
  };
  await import("../dashboard/src/detection/motion.worker.ts");
  for (let i = 0; i <= 18; i++) {
    const width = 320, height = 200, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const tx = x - 70, ty = y - 130 + i * .6;
      const value = tx >= 0 && tx < 64 && ty >= 0 && ty < 48
        ? 125 + 35 * Math.sin(tx * .7 + ty * .27) + 32 * Math.sin(ty * .82 - tx * .23) + 28 * Math.cos(tx * .41 - ty * .59) : 22;
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
    self.onmessage({ data: { type: "frame", generation: 0, pts: i * .05, srcW: 320, srcH: 200,
      bitmap: { width, height, data, close() {} } } });
  }
  const anchor = pts => self.onmessage({ data: { type: "anchor", generation: 0, pts, srcW: 320, srcH: 200,
    detections: [{ classId: 2, label: "mobil", confidence: .4, bbox: [70, 130 - pts * 12, 64, 48],
      timestamp: 0, trackId: 1, direction: "unknown", stale: false, vx: 0, vy: -12,
      framePts: pts, lastSeenPts: pts, observations: 1, reliable: false, sampleIntervalSec: .3 }] } });
  anchor(0);
  let turns = 0;
  while (timers.size && !messages.some(m => m.ack === false && m.snapshot.detections.length)) {
    assert.equal(timers.size, 1, "only one replay timer, not an unbounded job queue");
    const [id, callback] = timers.entries().next().value;
    timers.delete(id); callback(); turns++;
    // Model results arriving between every worker slice used to cancel all
    // progress, so this first vehicle could never finish its latency replay.
    anchor(.05); anchor(.1); anchor(.15);
    assert.ok(turns < 30, "the first observation must eventually be delivered");
  }
  const delivered = messages.find(m => m.ack === false && m.snapshot.detections.length);
  assert.ok(delivered);
  assert.equal(delivered.snapshot.detections[0].lastSeenPts, 0, "original replay finished before pending replacement");
  assert.ok(Math.abs(delivered.snapshot.detections[0].bbox[1] - 119.2) < 1);
  self.onmessage({ data: { type: "reset", generation: 1 } });
  assert.equal(timers.size, 0, "reset cancels both active and pending work");
});
