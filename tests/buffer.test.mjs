import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferedAt, safePlaybackPosition, bufferGoal } from "../dashboard/src/lib/bufferPolicy.ts";
const ranges = (...pairs) => ({ length: pairs.length, start: (i) => pairs[i][0], end: (i) => pairs[i][1] });
test("buffer ahead stops at the current contiguous range", () => {
  assert.deepEqual(bufferedAt(ranges([0, 10], [30, 60]), 5), { start: 0, end: 10 });
  assert.equal(bufferedAt(ranges([0, 10], [30, 60]), 20), null);
  assert.equal(bufferedAt(ranges(), 0), null);
});
test("startup target fits both the actual 40-second playlist and short playlists", () => {
  assert.equal(safePlaybackPosition(100, 140), 116);
  assert.equal(bufferGoal(100, 140, 116, true), 16);
  const pos = safePlaybackPosition(100, 106);
  assert.ok(pos > 100 && pos < 106);
  assert.ok(bufferGoal(100, 106, pos, true) < 6);
});
test("seek near live and recovery cannot wait for an impossible 30-second buffer", () => {
  assert.equal(bufferGoal(100, 140, 139, true), 1);
  assert.equal(bufferGoal(100, 140, 110, false), 10);
});
