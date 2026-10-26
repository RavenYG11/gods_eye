/** Sparse pyramidal Lucas–Kanade, with forward/backward and residual checks.
 * Pure pixel math, also exercised against synthetic motion in Node tests.
 * Reference: https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html
 */
export type Box = [number, number, number, number];
export type Point = [number, number];
export interface GrayImage { width: number; height: number; data: Uint8Array }
export type Pyramid = GrayImage[];
const RADIUS = 3;

export function grayFromRgba(data: Uint8ClampedArray, width: number, height: number): GrayImage {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4)
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  return { width, height, data: gray };
}

export function pyramid(image: GrayImage): Pyramid {
  const levels = [image];
  for (let l = 1; l < 3; l++) {
    const prev = levels[l - 1];
    const width = prev.width >> 1, height = prev.height >> 1;
    const data = new Uint8Array(width * height);
    // A small low-pass filter before decimation avoids aliasing feature patches.
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const p = 2 * y * prev.width + 2 * x, a = prev.data, w = prev.width;
      data[y * width + x] = (a[p] * 4 +
        (a[p - 1] + a[p + 1] + a[p - w] + a[p + w]) * 2 +
        a[p - w - 1] + a[p - w + 1] + a[p + w - 1] + a[p + w + 1]) >> 4;
    }
    levels.push({ width, height, data });
  }
  return levels;
}

function sample(im: GrayImage, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), dx = x - ix, dy = y - iy;
  const p = iy * im.width + ix, a = im.data;
  return (1 - dy) * ((1 - dx) * a[p] + dx * a[p + 1]) +
    dy * ((1 - dx) * a[p + im.width] + dx * a[p + im.width + 1]);
}
function inside(im: GrayImage, x: number, y: number, margin = RADIUS + 2): boolean {
  return x >= margin && y >= margin && x < im.width - margin - 1 && y < im.height - margin - 1;
}

/** Shi–Tomasi score with spatial suppression, restricted to the vehicle interior. */
export function selectFeatures(im: GrayImage, box: Box, limit = 12): Point[] {
  const [x, y, w, h] = box;
  const left = Math.max(5, Math.ceil(x + w * 0.14));
  const top = Math.max(5, Math.ceil(y + h * 0.14));
  const right = Math.min(im.width - 6, Math.floor(x + w * 0.86));
  const bottom = Math.min(im.height - 6, Math.floor(y + h * 0.86));
  const candidates: { x: number; y: number; score: number }[] = [];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 12));
  for (let cy = top; cy <= bottom; cy += step) for (let cx = left; cx <= right; cx += step) {
    let xx = 0, xy = 0, yy = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const p = (cy + dy) * im.width + cx + dx, a = im.data;
      const gx = (a[p + 1] - a[p - 1]) * 0.5;
      const gy = (a[p + im.width] - a[p - im.width]) * 0.5;
      xx += gx * gx; xy += gx * gy; yy += gy * gy;
    }
    const score = (xx + yy - Math.hypot(xx - yy, 2 * xy)) * 0.5;
    if (score > 45) candidates.push({ x: cx, y: cy, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const points: Point[] = [], distance = Math.max(2.5, Math.min(w, h) / 6);
  const floor = (candidates[0]?.score ?? 0) * 0.015;
  for (const c of candidates) {
    if (c.score < floor) break;
    if (points.every(([px, py]) => Math.hypot(c.x - px, c.y - py) >= distance)) points.push([c.x, c.y]);
    if (points.length >= limit) break;
  }
  return points;
}

function follow(a: Pyramid, b: Pyramid, point: Point, maxLevel: number, guess: Point): Point | null {
  let dx = guess[0] / 2 ** maxLevel, dy = guess[1] / 2 ** maxLevel;
  let usedLevel = false;
  for (let level = maxLevel; level >= 0; level--) {
    if (usedLevel) { dx *= 2; dy *= 2; }
    const factor = 2 ** level, px = point[0] / factor, py = point[1] / factor;
    const prev = a[level], next = b[level];
    if (!inside(prev, px, py)) { usedLevel = false; dx = 0; dy = 0; continue; }
    if (!usedLevel) { dx = guess[0] / factor; dy = guess[1] / factor; }
    usedLevel = true;
    const values: number[] = [], gx: number[] = [], gy: number[] = [];
    let xx = 0, xy = 0, yy = 0;
    for (let y = -RADIUS; y <= RADIUS; y++) for (let x = -RADIUS; x <= RADIUS; x++) {
      const tx = px + x, ty = py + y;
      const ix = (sample(prev, tx + 1, ty) - sample(prev, tx - 1, ty)) * 0.5;
      const iy = (sample(prev, tx, ty + 1) - sample(prev, tx, ty - 1)) * 0.5;
      values.push(sample(prev, tx, ty)); gx.push(ix); gy.push(iy);
      xx += ix * ix; xy += ix * iy; yy += iy * iy;
    }
    const det = xx * yy - xy * xy;
    if (det < 1 || (xx + yy - Math.hypot(xx - yy, 2 * xy)) < 35) {
      if (level > 0) continue; // texture can disappear at a coarse level
      return null;
    }
    for (let iteration = 0; iteration < 9; iteration++) {
      const qx = px + dx, qy = py + dy;
      if (!inside(next, qx, qy)) return null;
      let ex = 0, ey = 0, i = 0;
      for (let y = -RADIUS; y <= RADIUS; y++) for (let x = -RADIUS; x <= RADIUS; x++, i++) {
        const error = values[i] - sample(next, qx + x, qy + y);
        ex += gx[i] * error; ey += gy[i] * error;
      }
      const ux = (yy * ex - xy * ey) / det, uy = (xx * ey - xy * ex) / det;
      if (!Number.isFinite(ux + uy) || Math.hypot(ux, uy) > 5) return null;
      dx += ux; dy += uy;
      if (ux * ux + uy * uy < 0.0009) break;
    }
  }
  const q: Point = [point[0] + dx, point[1] + dy];
  if (!usedLevel || !inside(b[0], ...q)) return null;
  let error = 0;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++)
    error += Math.abs(sample(a[0], point[0] + x, point[1] + y) - sample(b[0], q[0] + x, q[1] + y));
  return error / 25 <= 30 ? q : null;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) * 0.5;
}

export interface FlowResult { box: Box; points: Point[]; quality: number }
export function advanceBox(a: Pyramid, b: Pyramid, box: Box, features: Point[], guess: Point = [0, 0]): FlowResult | null {
  if (features.length < 3) return null;
  const maxLevel = Math.min(2, Math.max(0, Math.floor(Math.log2(Math.min(box[2], box[3]) / 10))));
  const pairs: { p: Point; q: Point }[] = [];
  for (const p of features) {
    const q = follow(a, b, p, maxLevel, guess);
    if (!q) continue;
    const back = follow(b, a, q, maxLevel, [-guess[0], -guess[1]]);
    if (back && Math.hypot(back[0] - p[0], back[1] - p[1]) < 1.5) pairs.push({ p, q });
  }
  if (pairs.length < Math.max(3, Math.ceil(features.length * 0.4))) return null;
  const dx = median(pairs.map(({ p, q }) => q[0] - p[0]));
  const dy = median(pairs.map(({ p, q }) => q[1] - p[1]));
  const residuals = pairs.map(({ p, q }) => Math.hypot(q[0] - p[0] - dx, q[1] - p[1] - dy));
  const gate = Math.max(0.8, Math.min(3, median([...residuals]) * 2.5));
  const inliers = pairs.filter((_, i) => residuals[i] <= gate);
  if (inliers.length < Math.max(3, features.length * 0.4)) return null;
  // Median pair-distance ratio captures perspective growth without allowing
  // rotation/shear noise to distort a vehicle box.
  const scales: number[] = [];
  for (let i = 0; i < inliers.length; i++) for (let j = i + 1; j < inliers.length; j++) {
    const distance = Math.hypot(inliers[i].p[0] - inliers[j].p[0], inliers[i].p[1] - inliers[j].p[1]);
    if (distance > Math.max(5, Math.min(box[2], box[3]) * 0.25))
      scales.push(Math.hypot(inliers[i].q[0] - inliers[j].q[0], inliers[i].q[1] - inliers[j].q[1]) / distance);
  }
  const scale = scales.length >= 3 ? Math.max(0.95, Math.min(1.05, median(scales))) : 1;
  const cx = box[0] + box[2] * 0.5, cy = box[1] + box[3] * 0.5;
  const tx = median(inliers.map(({ p, q }) => q[0] - cx - (p[0] - cx) * scale));
  const ty = median(inliers.map(({ p, q }) => q[1] - cy - (p[1] - cy) * scale));
  const w = box[2] * scale, h = box[3] * scale;
  return { box: [cx + tx - w * 0.5, cy + ty - h * 0.5, w, h],
    points: inliers.map(({ q }) => q), quality: inliers.length / features.length };
}
