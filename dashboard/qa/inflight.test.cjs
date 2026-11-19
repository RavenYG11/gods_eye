// Uji regresi Node untuk bug FATAL #76 di workerDetector.detect():
// `finally { inflight = false }` yang tak bersyarat — tick yang di-skip guard
// ikut me-reset inflight milik panggilan yang sedang inferensi → tick
// berikutnya lolos guard → slot pending tertimpa → SEMUA hasil jadi "basi".
//
// Mock: Worker (respon tertunda), createImageBitmap (instan), window.
// Menjalankan: dari dashboard/qa/ → ./run.sh  (atau: node inflight.test.cjs
// setelah tsc meng-emit workerDetector.js ke direktori yang sama)
const assert = require("node:assert");

// ---- Mock lingkungan browser minimal ----
const pendingPosts = []; // pesan yang dikirim ke "worker"
let workerHandler = null;
global.Worker = class {
  constructor() { this.onmessage = null; }
  postMessage(msg) { pendingPosts.push(msg); }
  terminate() {}
};
global.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
global.createImageBitmap = async () => ({ width: 960, height: 540, close() {} });
// HTMLVideoElement: instanceof check — buat kelas palsu.
global.HTMLVideoElement = class {};
// document.baseURI tidak dipakai di sini (init dipanggil manual).

const { WorkerVehicleDetector } = require("./workerDetector.js");

async function main() {
  const det = new WorkerVehicleDetector();
  // Simulasi init selesai: pasang worker + tandai ready.
  // (init() asli memuat model — di sini cukup suntik worker mock.)
  det.worker = new Worker();
  det.worker.onmessage = (e) => det.onWorkerMessage(e.data);
  det.disposed = false;

  const video = new HTMLVideoElement();
  video.readyState = 4;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.currentTime = 1.0;

  // Panggilan 1: lolos guard, kirim id=1 ke worker, menunggu hasil.
  const p1 = det.detect(video);
  await new Promise((r) => setTimeout(r, 10)); // beri waktu createImageBitmap (mock async)
  assert.strictEqual(det.stats.inferStarted, 1, "panggilan 1 mulai inferensi");
  assert.strictEqual(pendingPosts.length, 1, "1 pesan ke worker");
  assert.strictEqual(pendingPosts[0].id, 1);

  // Panggilan 2 (tick 100ms kemudian, worker belum membalas): HARUS di-skip.
  const out2 = await det.detect(video);
  assert.strictEqual(out2.skipped, true, "panggilan 2 di-skip (inflight)");

  // Panggilan 3: HARUS tetap di-skip — inflight milik panggilan 1
  // TIDAK BOLEH di-reset oleh finally panggilan 2 (bug #76).
  const out3 = await det.detect(video);
  assert.strictEqual(out3.skipped, true,
    "panggilan 3 tetap di-skip (inflight tidak bocor)");
  assert.strictEqual(pendingPosts.length, 1,
    "worker hanya terima 1 pesan (tidak ada timpa pending)");

  // Worker membalas id=1 → panggilan 1 selesai VALID (bukan basi).
  det.worker.onmessage({ data: {
    type: "result", id: 1,
    frame: { cameraId: "", framePts: 1.0, wallTime: Date.now(),
             detections: [], inferMs: 1200 },
  }});
  const out1 = await p1;
  assert.strictEqual(out1.skipped, false, "panggilan 1 tidak skipped");
  assert.strictEqual(out1.timedOut, false, "panggilan 1 tidak timeout");
  assert.strictEqual(det.stats.ok, 1, "hasil valid dihitung ok");

  // Setelah selesai, panggilan baru boleh jalan lagi.
  const p4 = det.detect(video);
  assert.strictEqual(det.stats.inferStarted, 2, "panggilan 4 mulai setelah 1 selesai");
  await det.dispose();

  console.log("OK   inflight tidak bocor via finally panggilan yang di-skip (#76)");
  console.log("OK   hasil worker cocok ID dan diterima (tidak basi)");
}

main().then(
  () => console.log("\nHASIL: semua uji inflight lolos"),
  (e) => { console.error("FAIL", e.message); process.exit(1); },
);
