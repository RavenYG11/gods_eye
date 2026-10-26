import type { Detection, Detector } from "./types";
import { inferenceRegion, restoreRegion } from "./detectionRegions";
import { onTargetRoad } from "./targetRoad";
import { imageDataToNchw, letterboxParams, parseYolo26nOutput } from "./yolo26n";
import { COCO_TO_VEHICLE, CONFIDENCE_THRESHOLD, MODEL_INPUT_SIZE,
  ORT_EXECUTION_PROVIDERS, ORT_NUM_THREADS } from "./vehicleConfig";

type OrtModule = typeof import("onnxruntime-web");
type Tensor = import("onnxruntime-web").Tensor;

/** Inference runs entirely in the worker, including preprocessing and tracking. */
export class OnnxVehicleDetector implements Detector {
  private ort: OrtModule | null = null;
  private session: import("onnxruntime-web").InferenceSession | null = null;
  private canvas: OffscreenCanvas | null = null;
  private context: OffscreenCanvasRenderingContext2D | null = null;
  private input: Tensor | null = null;
  private pixels = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
  private threshold = CONFIDENCE_THRESHOLD;
  private sequence = 0;
  private classMap: Record<number, "mobil" | "motor"> = COCO_TO_VEHICLE;
  public provider = "wasm";

  setThreshold(value: number): void {
    if (Number.isFinite(value)) this.threshold = Math.min(0.9, Math.max(0.1, value));
  }

  async initWithWasm(opts: { modelUrl: string; labels: string[] }, wasmBase: string): Promise<void> {
    await this.dispose();
    // Explicit entry point registers WebGPU; the default ORT bundle does not.
    const ort = await import("onnxruntime-web/webgpu");
    this.ort = ort;
    const hw = navigator.hardwareConcurrency || 2;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.max(1, Math.min(ORT_NUM_THREADS, hw - 1)) : 1;
    ort.env.wasm.proxy = false; // already inside our dedicated worker
    if (wasmBase) ort.env.wasm.wasmPaths = wasmBase;

    const classes = (import.meta.env.VITE_DETECTOR_CLASSES as string | undefined)?.split(",").map((s) => s.trim());
    if (import.meta.env.VITE_DETECTOR_MODEL && !classes) {
      throw new Error("Model custom perlu VITE_DETECTOR_CLASSES (urutan kelas saat training, misalnya mobil,motor).");
    }
    if (classes) {
      this.classMap = {};
      classes.forEach((label, id) => {
        if (label === "mobil" || label === "motor") this.classMap[id] = label;
      });
      if (!Object.keys(this.classMap).length) throw new Error("Daftar kelas model harus memuat mobil atau motor.");
    }

    this.input = new ort.Tensor("float32", this.pixels, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
    const errors: string[] = [];
    let bestMs = Infinity;
    for (const provider of ORT_EXECUTION_PROVIDERS) {
      if (provider.startsWith("webgpu") && !("gpu" in navigator)) continue;
      let session: import("onnxruntime-web").InferenceSession | null = null;
      let outputs: Record<string, Tensor> | null = null;
      try {
        session = await ort.InferenceSession.create(opts.modelUrl, {
          executionProviders: provider === "webgpu-nhwc"
            ? [{ name: "webgpu", preferredLayout: "NHWC" }] : [provider],
          graphOptimizationLevel: "all",
        });
        outputs = await session.run({ [session.inputNames[0]]: this.input });
        const dims = outputs[session.outputNames[0]]?.dims;
        if (!dims || dims.length !== 3 || dims[0] !== 1 || dims[1] !== 300 || dims[2] !== 6) {
          throw new Error(`Output model [${dims}] tidak cocok; perlu YOLO end-to-end [1,300,6].`);
        }
        // Some integrated/software GPUs are slower than WASM. Measure after
        // warmup rather than assuming that the GPU is the fastest provider.
        let elapsed = 0;
        for (let i = 0; i < 2; i++) {
          const started = performance.now();
          const measured = await session.run({ [session.inputNames[0]]: this.input });
          elapsed += performance.now() - started;
          Object.values(measured).forEach((tensor) => tensor.dispose());
        }
        if (elapsed < bestMs) {
          await this.session?.release();
          this.session = session;
          this.provider = provider;
          bestMs = elapsed;
        } else await session.release();
        if (bestMs / 2 < 50) break; // already comfortably above the capture target
      } catch (e) {
        errors.push(`${provider}: ${e instanceof Error ? e.message : String(e)}`);
        await session?.release().catch(() => undefined);
      } finally {
        if (outputs) Object.values(outputs).forEach((tensor) => tensor.dispose());
      }
    }
    if (!this.session) {
      await this.dispose();
      throw new Error(`Gagal memuat model ${opts.modelUrl}. ${errors.join("; ")}`);
    }
    this.canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!this.context) throw new Error("OffscreenCanvas 2D tidak tersedia.");
  }

  async init(opts: { modelUrl: string; labels: string[] }): Promise<void> {
    await this.initWithWasm(opts, "");
  }

  async inferFromBitmap(bitmap: ImageBitmap, srcW: number, srcH: number, timestamp: number): Promise<Detection[]> {
    const session = this.session, ctx = this.context;
    if (!session || !this.ort || !ctx || !this.input) throw new Error("Detector belum siap.");
    const region = inferenceRegion(srcW, srcH, this.sequence++);
    const lb = letterboxParams(region.width, region.height);
    // Match Ultralytics padding; black padding changes the input distribution.
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    ctx.drawImage(bitmap, region.x, region.y, region.width, region.height,
      lb.padX, lb.padY, region.width * lb.scale, region.height * lb.scale);
    imageDataToNchw(ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE), this.pixels);
    const outputs = await session.run({ [session.inputNames[0]]: this.input });
    try {
      const tensor = outputs[session.outputNames[0]];
      return restoreRegion(parseYolo26nOutput(tensor.data as ArrayLike<number>, {
        srcW: region.width, srcH: region.height, lb, timestamp,
        confidenceThreshold: this.threshold, classMap: this.classMap,
      }), region).filter((det) => onTargetRoad(det.bbox, srcW, srcH));
    } finally {
      Object.values(outputs).forEach((tensor) => tensor.dispose());
    }
  }

  async detect(_frame: ImageData | HTMLVideoElement): Promise<Detection[]> { return []; }
  async dispose(): Promise<void> {
    try { await this.session?.release(); } catch { /* best effort */ }
    this.input?.dispose();
    this.input = null; this.session = null; this.context = null;
    this.canvas = null; this.ort = null;
  }
}
