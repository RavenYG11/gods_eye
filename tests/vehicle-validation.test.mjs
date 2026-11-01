import { test } from "node:test";
import assert from "node:assert/strict";
import { validatedVehicles, vehicleBirthThreshold } from "../dashboard/src/detection/vehicleAcceptance.ts";
import { duplicateVehicle } from "../dashboard/src/detection/vehicleGeometry.ts";
import { ByteTracker } from "../dashboard/src/detection/tracker.ts";
import { letterboxParams, parseYolo26nOutput } from "../dashboard/src/detection/yolo26n.ts";
import { canAnchor } from "../dashboard/src/detection/motionPolicy.ts";

const d = (label, bbox, confidence = .8) => ({ label, bbox, confidence, timestamp: 0,
  classId: { person: 0, bicycle: 1, mobil: 2, motor: 3 }[label] });

test("person evidence blocks a walking human labelled motor, including weak upward proposals", () => {
  const size = { width: 960, height: 540 }, tracker = new ByteTracker();
  for (let i = 0; i < 4; i++) {
    const box = [390 - i * 2, 260 - i * 8, 24, 66];
    const person = d("person", box, .9), falseMotor = d("motor", box, i < 2 ? .115 : .5);
    assert.deepEqual(validatedVehicles([falseMotor, person], size), []);
    assert.deepEqual(tracker.update([falseMotor, person], i * .3, size), []);
    assert.deepEqual(tracker.rejectedDetections, [falseMotor]);
  }
});

test("a rider above the wheels and a nearby pedestrian do not veto a real motorcycle", () => {
  const motor = d("motor", [300, 220, 40, 80], .35);
  const rider = d("person", [305, 217, 30, 58], .95);
  const pedestrian = d("person", [337, 220, 25, 80], .95);
  assert.deepEqual(validatedVehicles([motor, rider, pedestrian]), [motor]);
  assert.equal(new ByteTracker().update([motor, rider], 0).length, 1);
});

test("a rejected person hypothesis clears its older weak motor proposal", () => {
  const tracker = new ByteTracker(), size = { width: 960, height: 540 };
  tracker.update([d("motor", [390, 260, 24, 66], .115)], 0, size);
  tracker.update([d("motor", [388, 252, 24, 66], .115), d("person", [388, 252, 24, 66], .9)], .3, size);
  assert.equal(tracker.update([d("motor", [386, 244, 24, 66], .115)], .6, size).length, 0);
});

test("cart/person-shaped cars and competing bicycles are rejected while normal cars survive", () => {
  const narrowCart = d("mobil", [200, 210, 25, 70], .9);
  const personCart = d("mobil", [250, 210, 48, 65], .4);
  const pedestrian = d("person", [252, 209, 46, 67], .85);
  const bicycle = d("bicycle", [350, 210, 45, 65], .9);
  const falseMotor = d("motor", [351, 211, 44, 64], .4);
  const car = d("mobil", [450, 220, 90, 65], .9);
  assert.deepEqual(validatedVehicles([narrowCart, personCart, pedestrian, bicycle, falseMotor, car]), [car]);
});

test("half-visible right-approach cars start on the first observation before touching the image border", () => {
  for (const width of [640, 960, 1920]) {
    const height = width * 9 / 16, size = { width, height };
    const box = [.79 * width, .65 * height, .15 * width, .15 * height];
    const car = d("mobil", box, .26);
    assert.equal(vehicleBirthThreshold("mobil", box, size), .24);
    const [born] = new ByteTracker().update([car], 0, size);
    assert.equal(born.observations, 1);
    assert.equal(canAnchor(born), true);
    assert.equal(new ByteTracker().update([d("mobil", [.4 * width, .4 * height, .1 * width, .1 * height], .26)], 0, size).length, 0);
    // Physical clipping can make a legitimate half-car extremely narrow.
    assert.equal(validatedVehicles([d("mobil", [width - 8, height * .75, 8, height * .2])], size).length, 1);
  }
});

test("duplicate and nested model boxes establish one ID without swallowing adjacent traffic", () => {
  for (const label of ["mobil", "motor"]) {
    const first = d(label, [200, 180, 50, 60], .9);
    const duplicate = d(label, [202, 182, 49, 59], .7);
    const nested = d(label, [206, 189, 36, 42], .6);
    const adjacent = d(label, [229, 180, 50, 60], .8);
    const tracker = new ByteTracker();
    const born = tracker.update([duplicate, nested, first, adjacent], 0);
    assert.equal(born.length, 2);
    const ids = born.map(t => t.trackId);
    const next = tracker.update([first, duplicate, nested, adjacent], .4);
    assert.deepEqual(next.map(t => t.trackId), ids);
    assert.equal(tracker.activeTracks, 2);
  }
  assert.equal(duplicateVehicle(d("mobil", [100, 100, 100, 80]), d("motor", [130, 100, 30, 80])), false);
  assert.equal(validatedVehicles([d("mobil", [100, 100, 50, 60], .9), d("motor", [101, 101, 50, 60], .5)]).length, 1);
});

test("context parsing is opt-in, uses custom class order and never invents a person from custom motor ID zero", () => {
  const data = new Float32Array(1800);
  data.set([100, 100, 130, 170, .9, 0]);
  data.set([200, 100, 250, 170, .8, 1], 6);
  const options = { srcW: 640, srcH: 640, lb: letterboxParams(640, 640), timestamp: 0, confidenceThreshold: .12 };
  assert.equal(parseYolo26nOutput(data, options).length, 0);
  assert.deepEqual(parseYolo26nOutput(data, { ...options, contextClassMap: { 0: "person", 1: "bicycle" } }).map(x => x.label), ["person", "bicycle"]);
  const custom = parseYolo26nOutput(data, { ...options, classMap: { 0: "motor", 1: "mobil" }, contextClassMap: {} });
  assert.deepEqual(custom.map(x => x.label), ["motor", "mobil"]);
});
