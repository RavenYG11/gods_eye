import { advanceBox, pyramid, selectFeatures, type Box, type GrayImage, type Point, type Pyramid } from "./opticalFlow";
import type { TrackedDetection } from "./tracker";
import { canAnchor, motionCoast, observationCoast, MotionHeading } from "./motionPolicy";
import { onTargetRoad } from "./targetRoad";

interface Frame { pts: number; image: Pyramid }
interface VisualTrack {
  det: TrackedDetection;
  detectorId: number;
  box: Box;
  points: Point[];
  pts: number;
  lastGoodPts: number;
  heading: MotionHeading;
  path: { pts: number; box: Box }[];
  modelOnly: boolean;
  flowDy: number;
  motionSamples: number;
  startedPts: number;
  counted: boolean;
  edgeClipped: boolean;
}
export interface VehicleEntries { mobil: number; motor: number }
export interface MotionSnapshot { framePts: number; detections: TrackedDetection[]; entries?: VehicleEntries }

function overlap(a: Box, b: Box): number {
  const area = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return area / Math.max(1, a[2] * a[3] + b[2] * b[3] - area);
}

function correctBox(box: Box, measured: Box, observed: Box, revealingEdge = false): Box {
  const dx = (observed[0] + observed[2] / 2 - measured[0] - measured[2] / 2) * box[2] / measured[2];
  const dy = (observed[1] + observed[3] / 2 - measured[1] - measured[3] / 2) * box[3] / measured[3];
  const w = box[2] * (revealingEdge ? observed[2] / measured[2]
    : 1 + Math.max(-0.15, Math.min(0.15, observed[2] / measured[2] - 1)) * 0.3);
  const h = box[3] * (revealingEdge ? observed[3] / measured[3]
    : 1 + Math.max(-0.15, Math.min(0.15, observed[3] / measured[3] - 1)) * 0.3);
  const gain = revealingEdge ? 1 : 0.3;
  return [box[0] + dx * gain + (box[2] - w) / 2, box[1] + dy * gain + (box[3] - h) / 2, w, h];
}

function touchesFrame(box: Box, width: number, height: number): boolean {
  return box[0] <= 2 || box[1] <= 2 || box[0] + box[2] >= width - 2 || box[1] + box[3] >= height - 2;
}

/** Visual tracking runs independently from YOLO. All coordinates here are in
 * the small motion image; snapshots are scaled to the video by the worker. */
export class MotionTracker {
  private history: Frame[] = [];
  private tracks: VisualTrack[] = [];
  private nextId = 1;
  private width = 0;
  private height = 0;
  private interval = 1 / 15;
  private entries: VehicleEntries = { mobil: 0, motor: 0 };

  constructor(private options: { targetRoadOnly?: boolean } = {}) {}

  reset(): void {
    this.history = []; this.tracks = []; this.nextId = 1; this.interval = 1 / 15;
    this.entries = { mobil: 0, motor: 0 };
  }

  push(image: GrayImage, pts: number): MotionSnapshot {
    const previous = this.history[this.history.length - 1];
    if (!Number.isFinite(pts)) return this.snapshot();
    if (image.width !== this.width || image.height !== this.height ||
      (previous && (pts <= previous.pts || pts - previous.pts > 1))) this.reset();
    const last = this.history[this.history.length - 1];
    if (last) this.interval += 0.3 * (Math.max(0.02, Math.min(0.25, pts - last.pts)) - this.interval);
    this.width = image.width; this.height = image.height;
    const frame: Frame = { pts, image: pyramid(image) };
    const prev = this.history[this.history.length - 1];
    if (prev) for (const track of this.tracks) {
      const origin = track.pts === prev.pts ? prev : this.history.find((f) => f.pts === track.pts);
      // A single blurred/compressed frame must not destroy a good feature set.
      // Recovery covers three measured motion intervals, with a strict cap.
      if (origin && (track.pts === prev.pts || pts - origin.pts <= motionCoast(this.interval) + 1e-6)) this.advance(track, origin, frame);
    }
    this.history.push(frame);
    while (this.history.length > 80 || this.history[0].pts < pts - 2.8) this.history.shift();
    this.tracks = this.tracks.filter((track) => this.remember(track, pts));
    return this.snapshot();
  }

  /** Replay late model anchors through real intervening frames. Never use a
   * Kalman-predicted/missed detection as a fresh visual measurement. */
  anchor(detections: TrackedDetection[], pts: number): MotionSnapshot {
    const work = this.anchorSteps(detections, pts);
    let next = work.next();
    while (!next.done) next = work.next();
    return next.value;
  }

  /** Yield after each replay frame so live motion frames can preempt anchors. */
  *anchorSteps(detections: TrackedDetection[], pts: number): Generator<void, MotionSnapshot> {
    let index = -1, distance = Infinity;
    for (let i = 0; i < this.history.length; i++) {
      const delta = Math.abs(this.history[i].pts - pts);
      if (delta < distance) { distance = delta; index = i; }
    }
    if (index < 0 || distance > 0.045) return this.snapshot();
    const first = this.history[index];
    let now = this.history[this.history.length - 1]!;
    const claimed = new Set<VisualTrack>();
    for (const det of detections) {
      if (!canAnchor(det)) continue;
      if (this.options.targetRoadOnly && !onTargetRoad(det.bbox, this.width, this.height)) continue;
      // Most vehicles are already locked to pixels. Verify the model box
      // against the measured position AT CAPTURE TIME, then refresh metadata.
      // Replaying their whole optical-flow history again wastes the worker's
      // frame budget and eventually causes a global tracking blackout.
      let matched: VisualTrack | undefined, matchScore = 0;
      let measured: Box | undefined;
      for (const track of this.tracks) {
        if (claimed.has(track) || track.det.label !== det.label || now.pts - track.lastGoodPts > motionCoast(this.interval)) continue;
        const sample = track.path.find((p) => Math.abs(p.pts - first.pts) < 0.001);
        if (!sample) continue;
        const iou = overlap(sample.box, det.bbox);
        const sameId = track.detectorId === det.trackId;
        const score = iou + (sameId ? 0.3 : 0);
        if (iou > (sameId ? 0.25 : 0.55) && score > matchScore) {
          matched = track; measured = sample.box; matchScore = score;
        }
      }
      if (matched && measured) {
        if (pts >= matched.det.lastSeenPts) {
          // A half-body birth must expand as the rest enters. The usual 4.5%
          // size correction would otherwise keep a tiny box long after entry.
          const clipped = touchesFrame(det.bbox, this.width, this.height);
          const revealingEdge = matched.edgeClipped || clipped;
          matched.box = correctBox(matched.box, measured, det.bbox, revealingEdge);
          // Correct subsequent history too: several delayed results must not
          // repeatedly apply the same old error and make the box oscillate.
          for (const sample of matched.path) if (sample.pts >= pts) sample.box = correctBox(sample.box, measured, det.bbox, revealingEdge);
          matched.edgeClipped = clipped;
          matched.det.lastSeenPts = det.lastSeenPts;
          matched.det.confidence = det.confidence;
          matched.det.observations = Math.max(matched.det.observations, det.observations);
          matched.det.reliable ||= det.reliable;
          matched.det.timestamp = det.timestamp;
          matched.det.sampleIntervalSec = det.sampleIntervalSec;
          matched.detectorId = det.trackId;
        }
        claimed.add(matched);
        continue;
      }
      const box: Box = [...det.bbox];
      const points = selectFeatures(first.image[0], box);
      const candidate: VisualTrack = { det: { ...det }, detectorId: det.trackId, box,
        points, pts: first.pts, lastGoodPts: first.pts,
        heading: new MotionHeading(), path: [{ pts: first.pts, box: [...box] }],
        modelOnly: points.length < 3, flowDy: 0, motionSamples: 0, startedPts: first.pts, counted: false,
        edgeClipped: touchesFrame(box, this.width, this.height) };
      candidate.heading.observe(box, first.pts);
      let origin = first, cursor = first.pts, steps = 0;
      while (!candidate.modelOnly && steps++ < 80) {
        const current = this.history.find((frame) => frame.pts > cursor);
        if (!current) break;
        cursor = current.pts;
        if (this.advance(candidate, origin, current)) origin = current;
        else if (current.pts - origin.pts > motionCoast(this.interval)) break;
        yield;
      }
      now = this.history[this.history.length - 1]!;
      // A failed replay cannot leave an old box sitting on the road.
      if (!this.hasEvidence(candidate, now.pts)) continue;
      let existing = this.tracks.find((t) => !claimed.has(t) && t.detectorId === det.trackId &&
        t.det.label === det.label && overlap(this.project(t, now.pts), candidate.box) > 0.15);
      if (!existing) {
        let best = 0.45;
        for (const track of this.tracks) {
          if (claimed.has(track) || track.det.label !== det.label) continue;
          const iou = overlap(this.project(track, now.pts), candidate.box);
          if (iou > best) { best = iou; existing = track; }
        }
      }
      // Birth was validated by ByteTrack. Direction and repeated observations
      // are counting evidence, never prerequisites for showing a vehicle.
      if (existing) {
        // Keep the visual identity across a YOLO ID switch. Geometry comes from
        // replayed pixels rather than a slowly filtered Kalman position.
        candidate.det.trackId = existing.det.trackId;
        candidate.counted = existing.counted;
        if (candidate.heading.direction === "unknown") candidate.heading = existing.heading;
        if (now.pts - existing.lastGoodPts < 0.15 && overlap(existing.box, candidate.box) > 0.5) {
          // Damp detector box/scale jitter while keeping the measured optical
          // flow trajectory. Large corrections still snap to fresh evidence.
          candidate.box = candidate.box.map((v, i) => existing!.box[i] + (v - existing!.box[i]) * 0.4) as Box;
        }
        Object.assign(existing, candidate);
        claimed.add(existing);
      } else if (this.tracks.length < 40) {
        candidate.det.trackId = this.nextId++;
        this.tracks.push(candidate);
        claimed.add(candidate);
      }
    }
    // One visual object must not leave several predicted ghosts behind it.
    this.tracks = this.tracks.filter((track) => this.remember(track, now.pts) &&
      (claimed.has(track) || ![...claimed].some((other) => other.det.label === track.det.label && overlap(other.box, track.box) > 0.6)));
    return this.snapshot();
  }

  private advance(track: VisualTrack, previous: Frame, current: Frame): boolean {
    if (track.pts !== previous.pts || track.points.length < 3) return false;
    const dt = current.pts - previous.pts;
    const result = advanceBox(previous.image, current.image, track.box, track.points,
      [track.det.vx * dt, track.det.vy * dt]);
    if (!result) return false;
    const dx = result.box[0] + result.box[2] * 0.5 - track.box[0] - track.box[2] * 0.5;
    const dy = result.box[1] + result.box[3] * 0.5 - track.box[1] - track.box[3] * 0.5;
    const alpha = previous.pts === track.det.lastSeenPts ? 1 : 0.55;
    track.det.vx += alpha * (dx / dt - track.det.vx); track.det.vy += alpha * (dy / dt - track.det.vy);
    track.box = result.box; track.points = result.points;
    track.modelOnly = false; track.flowDy += dy; track.motionSamples++;
    track.pts = current.pts; track.lastGoodPts = current.pts;
    track.path.push({ pts: current.pts, box: [...track.box] });
    while (track.path.length > 80 || track.path[0].pts < current.pts - 2.8) track.path.shift();
    track.heading.move(dx, dy, current.pts, track.box[3]);
    if (track.heading.direction !== "unknown") track.det.direction = track.heading.direction;
    if (track.points.length < 6) {
      const additions = selectFeatures(current.image[0], track.box).filter(([x, y]) =>
        track.points.every(([px, py]) => Math.hypot(x - px, y - py) > 2.5));
      track.points = [...track.points, ...additions].slice(0, 12);
    }
    return true;
  }

  private project(track: VisualTrack, pts: number): Box {
    const dt = Math.max(0, Math.min(0.4, pts - track.pts));
    return [track.box[0] + track.det.vx * dt, track.box[1] + track.det.vy * dt, track.box[2], track.box[3]];
  }

  private remember(track: VisualTrack, pts: number): boolean {
    const [x, y, w, h] = track.box;
    const modelAge = track.heading.direction === "atas" && track.det.observations >= 3 ? 4 : 2.2;
    return pts - track.lastGoodPts <= 0.8 && pts - track.det.lastSeenPts <= modelAge &&
      (!this.options.targetRoadOnly || (track.heading.direction !== "bawah" && onTargetRoad(track.box, this.width, this.height))) &&
      w >= 4 && h >= 5 && x + w > 0 && y + h > 0 && x < this.width && y < this.height;
  }

  private hasEvidence(track: VisualTrack, pts: number): boolean {
    return track.modelOnly
      ? pts - track.det.lastSeenPts <= observationCoast(track.det.sampleIntervalSec)
      : pts - track.lastGoodPts <= motionCoast(this.interval);
  }

  snapshot(): MotionSnapshot {
    const pts = this.history[this.history.length - 1]?.pts ?? -1;
    const visible = this.tracks.filter((t) => this.remember(t, pts) && this.hasEvidence(t, pts));
    for (const track of visible) {
      // Count each visual identity once, using real accumulated pixel motion.
      // Detector jitter, a model direction flag, parked vehicles and downward
      // traffic cannot increment entries on their own.
      if (!track.counted && track.heading.direction === "atas" && track.motionSamples >= 3 &&
        track.pts - track.startedPts >= 0.3 && track.flowDy < -Math.max(4, track.box[3] * 0.12) &&
        (track.det.label === "mobil" || track.det.label === "motor")) {
        track.counted = true; this.entries[track.det.label]++;
      }
    }
    return { framePts: pts, entries: { ...this.entries }, detections: visible.map((t) =>
      ({ ...t.det, bbox: [...t.box], framePts: t.pts, stale: false,
        direction: t.heading.direction,
        motionIntervalSec: this.interval, coastSec: t.modelOnly ? observationCoast(t.det.sampleIntervalSec) : motionCoast(this.interval) })) };
  }
}
