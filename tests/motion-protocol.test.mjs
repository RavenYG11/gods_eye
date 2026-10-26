import { test } from "node:test";
import assert from "node:assert/strict";

test("motion worker delivers session entries with scaled boxes and clears them on reset", async () => {
  const messages = [];
  globalThis.self = { postMessage: m => messages.push(m), setTimeout };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return {
      drawImage: bitmap => { this.bitmap = bitmap; },
      getImageData: () => ({ ...this.bitmap, data: this.bitmap.data }),
    }; }
  };
  await import("../dashboard/src/detection/motion.worker.ts");
  const frame = (i, generation = 0) => {
    const width = 320, height = 200, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const tx = x - 70, ty = y - 130 + i;
      const value = tx >= 0 && tx < 64 && ty >= 0 && ty < 48
        ? 125 + 35 * Math.sin(tx * .7 + ty * .27) + 32 * Math.sin(ty * .82 - tx * .23) + 28 * Math.cos(tx * .41 - ty * .59) : 22;
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
    self.onmessage({ data: { type: "frame", generation, pts: i * .05,
      srcW: 640, srcH: 400, bitmap: { width, height, data, close() {} } } });
  };
  frame(0);
  self.onmessage({ data: { type: "anchor", generation: 0, pts: 0, srcW: 640, srcH: 400,
    detections: [{ classId: 2, label: "mobil", confidence: .4, bbox: [140, 260, 128, 96],
      timestamp: 0, trackId: 1, direction: "unknown", stale: false, vx: 0, vy: 0,
      framePts: 0, lastSeenPts: 0, observations: 1, reliable: false, sampleIntervalSec: .4 }] } });
  for (let i = 0; i < 100 && !messages.some(m => m.ack === false); i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const first = messages.find(m => m.ack === false);
  assert.ok(first, "worker emitted initial model anchor");
  assert.deepEqual(first.snapshot.detections[0].bbox, [140, 260, 128, 96]);
  assert.deepEqual(first.snapshot.entries, { mobil: 0, motor: 0 });
  for (let i = 1; i <= 20; i++) frame(i);
  assert.deepEqual(messages.at(-1).snapshot.entries, { mobil: 1, motor: 0 });
  self.onmessage({ data: { type: "reset", generation: 1 } });
  frame(0, 1);
  assert.deepEqual(messages.at(-1).snapshot.entries, { mobil: 0, motor: 0 });
  assert.deepEqual(messages.at(-1).snapshot.detections, []);
});
