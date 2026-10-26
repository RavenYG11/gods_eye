import { test } from "node:test";
import assert from "node:assert/strict";
import { onTargetRoad } from "../dashboard/src/detection/targetRoad.ts";

test("camera calibration keeps the white-car entry lane and half-visible border vehicles", () => {
  const boxes = [[.70, .45, .18, .17], [.94, .60, .06, .18], [.50, .92, .12, .08], [.07, .06, .035, .035]];
  for (const width of [640, 960, 1920]) {
    const height = width * 9 / 16;
    for (const box of boxes) assert.equal(onTargetRoad(box.map((v, i) => v * (i % 2 ? height : width)), width, height), true);
  }
});

test("opposite-road cars are rejected on the first observation, before their direction is known", () => {
  for (const box of [[.55, .14, .09, .10], [.85, .33, .10, .10], [.32, .06, .04, .06]])
    assert.equal(onTargetRoad(box.map((v, i) => v * (i % 2 ? 540 : 960)), 960, 540), false);
  assert.equal(onTargetRoad([NaN, 200, 30, 40], 960, 540), false);
  assert.equal(onTargetRoad([960, 400, 30, 40], 960, 540), false);
});
