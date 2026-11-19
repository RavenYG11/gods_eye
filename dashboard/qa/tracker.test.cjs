// Uji Node untuk ByteTracker (#76) — logika murni, tanpa DOM.
// Menjalankan: node /tmp/ge-test/run.mjs  (setelah tsc emit ke /tmp/ge-test)
const { ByteTracker, DEFAULT_TRACKER_OPTIONS, predictBbox } = require("./tracker.js");
const { parseYolo26nOutput, letterboxParams } = require("./yolo26n.js");

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
function det(label, classId, conf, x, y, w, h) {
  return { classId, label, confidence: conf, bbox: [x, y, w, h], timestamp: Date.now() };
}

console.log("== Skenario A (#75 regresi): 12 frame @1fps, objek 250px/dtk ==");
{
  const tr = new ByteTracker();
  let ids = new Set();
  let last = null;
  for (let i = 0; i < 12; i++) {
    const x = 100 + i * 250; // 250 px/dtk, dt=1
    const out = tr.update([det("mobil", 2, 0.9, x, 300, 120, 80)], i);
    for (const t of out) ids.add(t.trackId);
    last = out;
  }
  ok("satu ID stabil (bukan 12)", ids.size === 1, `ids=${[...ids]}`);
  const t = last.find((d) => d.trackId === [...ids][0]);
  ok("velocity konvergen ~250px/dtk", Math.abs(t.vx - 250) < 60, `vx=${t.vx.toFixed(1)}`);
  ok("framePts = waktu update kini", t.framePts === 11, `framePts=${t.framePts}`);
}

console.log("== Bug C: track hilang — framePts kini, bukan observasi lama ==");
{
  const tr = new ByteTracker();
  tr.update([det("mobil", 2, 0.9, 100, 300, 120, 80)], 10.0);
  tr.update([det("mobil", 2, 0.9, 150, 300, 120, 80)], 10.25);
  // Hilang 3 update (0.75 dtk) — masih dalam graceSec=1.5 → tetap dirender (stale)
  let out = tr.update([], 10.5);
  out = tr.update([], 10.75);
  out = tr.update([], 11.0);
  const stale = out.find((d) => d.stale === true);
  ok("track hilang < graceSec tetap dirender (stale)", !!stale);
  if (stale) {
    ok("framePts stale = waktu update KINI (11.0), bukan lastSeen (10.25)",
      stale.framePts === 11.0, `framePts=${stale.framePts}`);
    // Prediksi tunggal: overlay mengekstrapolasi dari kini, bukan ganda.
    const boxNow = stale.bbox;
    const pred = predictBbox(boxNow, stale.vx, stale.vy, 0.5);
    ok("predictBbox maju searah velocity", Math.sign(pred[0] - boxNow[0]) === Math.sign(stale.vx) || stale.vx === 0);
  }
  // Hilang > graceSec (1.5 dtk) → tak dirender lagi
  out = tr.update([], 12.0); // 1.75 dtk sejak 10.25
  ok("track hilang > graceSec tak dirender", out.length === 0, `n=${out.length}`);
  // Hilang > maxTimeLostSec (8 dtk) → dihapus total
  out = tr.update([det("mobil", 2, 0.9, 900, 300, 120, 80)], 19.0);
  const ids = new Set(out.map((d) => d.trackId));
  ok("track lama dihapus → deteksi baru = ID baru", out.length === 1 && out[0].trackId !== 1, `ids=${[...ids]}`);
}

console.log("== Gate: dt dijepit 2 dtk (tak meledak setelah jeda panjang) ==");
{
  const tr = new ByteTracker();
  tr.update([det("mobil", 2, 0.9, 100, 300, 120, 80)], 0);
  // Jeda 30 dtk tanpa deteksi (mis. CPU macet) — lalu kendaraan MUNCUL JAUH
  // (bukan kelanjutan track lama). Gate dijepit → tak asosiasi liar.
  const out = tr.update([det("mobil", 2, 0.9, 900, 300, 120, 80)], 30);
  // Track lama: lost 30 dtk > maxTimeLostSec=8 → dihapus; deteksi = track baru.
  ok("track basi 30 dtk dihapus, bukan di-re-id liar", out.length === 1 && out[0].trackId === 2, `ids=${out.map(d=>d.trackId)}`);
}

console.log("== Gate relatif ukuran: objek kecil tak dapat gate raksasa ==");
{
  const tr = new ByteTracker({ ...DEFAULT_TRACKER_OPTIONS, distGateSizeFactor: 3 });
  // Objek kecil jauh (40×30, diagonal 50) bergerak 60px dalam 1 dtk
  tr.update([det("motor", 3, 0.9, 400, 200, 40, 30)], 0);
  const out = tr.update([det("motor", 3, 0.9, 460, 200, 40, 30)], 1.0);
  ok("objek kecil tetap terasosiasi (1 ID)", out.length === 1 && out[0].trackId === 1, `ids=${out.map(d=>d.trackId)}`);
  // ...tapi tetangga 500px jauhnya tak "menarik" track kecil itu
  const tr2 = new ByteTracker({ ...DEFAULT_TRACKER_OPTIONS, distGateSizeFactor: 3 });
  tr2.update([det("motor", 3, 0.9, 400, 200, 40, 30)], 0);
  const out2 = tr2.update([
    det("motor", 3, 0.9, 405, 202, 40, 30),  // yang benar (dekat)
    det("motor", 3, 0.9, 900, 200, 40, 30),  // pengecoh jauh
  ], 1.0);
  const t1 = out2.find((d) => d.trackId === 1);
  ok("track kecil ikut deteksi terdekat, bukan pengecoh",
    !!t1 && Math.abs(t1.bbox[0] - 405) < 60, `x=${t1?.bbox[0]}`);
}

console.log("== Arah: mobil ke atas ==");
{
  const tr = new ByteTracker();
  let dir = "unknown";
  for (let i = 0; i < 6; i++) {
    const out = tr.update([det("mobil", 2, 0.9, 300, 400 - i * 30, 120, 80)], i * 0.25);
    dir = out[0]?.direction ?? "unknown";
  }
  ok("gerak ke atas terklasifikasi", dir === "atas", `dir=${dir}`);
}

console.log("== parseYolo26nOutput: filter kelas COCO ==");
{
  const lb = letterboxParams(960, 540);
  const data = new Float32Array(300 * 6);
  const row = (i, x1, y1, x2, y2, s, c) => {
    data.set([x1, y1, x2, y2, s, c], i * 6);
  };
  row(0, 100, 100, 200, 200, 0.9, 2);   // car → mobil
  row(1, 300, 300, 360, 380, 0.8, 3);   // motorcycle → motor
  row(2, 500, 500, 600, 600, 0.95, 0);  // person → buang
  row(3, 100, 400, 200, 500, 0.95, 7);  // truck → buang (koreksi Rama #62)
  row(4, 100, 100, 200, 200, 0.05, 2);  // di bawah floor → buang
  const out = parseYolo26nOutput(data, { srcW: 960, srcH: 540, lb, timestamp: 1, confidenceThreshold: 0.15 });
  const labels = out.map((d) => d.label).sort();
  ok("hanya mobil+motor lolos", labels.join(",") === "mobil,motor", `labels=${labels}`);
  ok("classId dipertahankan (2,3)", out.every((d) => (d.label === "mobil") === (d.classId === 2)));
  ok("bbox dalam piksel sumber", out.every((d) => d.bbox[0] >= 0 && d.bbox[1] >= 0));
}

console.log(`\nHASIL: ${pass} lolos, ${fail} gagal`);
process.exit(fail > 0 ? 1 : 0);
