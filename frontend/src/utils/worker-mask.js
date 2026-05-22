// frontend/src/utils/worker-mask.js
// Web Worker for realtime face-mask detection.
import * as ort from "onnxruntime-web";

const modelUrl = import.meta.env.DEV
  ? "/mask_yolov5.onnx"
  : new URL("../mask_yolov5.onnx", import.meta.url).href;

const wasmDir = import.meta.env.DEV
  ? "/assets/ort/"
  : new URL("./ort/", import.meta.url).href;
ort.env.wasm.wasmPaths = wasmDir;
ort.env.wasm.simd = true;
ort.env.wasm.numThreads = 1;

console.log("[mask-worker] Loading model from:", modelUrl, "WASM from:", wasmDir);

let sessionPromise;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
    }).then((s) => {
      console.log("[mask-worker] ONNX session ready", {
        inputNames: s.inputNames,
        outputNames: s.outputNames,
      });
      return s;
    }).catch((err) => {
      console.error("[mask-worker] ONNX session FAILED to load:", err);
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

self.onmessage = async (event) => {
  const { type, data, dims } = event.data || {};
  if (type !== "infer" || !data) return;

  try {
    const session = await getSession();
    const tensor = new ort.Tensor(
      new Float32Array(data),
      dims || [1, 3, 640, 640]
    );
    const t0 = performance.now();
    const outputs = await session.run({ images: tensor });
    const t1 = performance.now();
    if (Math.random() < 0.05) console.log(`[mask-worker] inference: ${(t1 - t0).toFixed(0)}ms`);
    const first = outputs[Object.keys(outputs)[0]];
    self.postMessage(first.data);
  } catch (err) {
    console.error("[mask-worker] inference error:", err);
    self.postMessage(new Float32Array(0));
  }
};
