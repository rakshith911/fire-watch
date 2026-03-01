// frontend/src/utils/worker-weapon.js
// Web Worker for RT-DETR weapon detection model (Knife/Pistol)
import * as ort from "onnxruntime-web";

// Models live in publicDir (models/), served at root.
const modelUrl = import.meta.env.DEV
  ? "/weapons_yolo.onnx"
  : new URL("../weapons_yolo.onnx", import.meta.url).href;

// WASM files: .wasm served from publicDir at /assets/ort/
// .mjs loaders redirected to node_modules by vite plugin (see vite.config.js)
// Production: WASM files are next to the compiled worker at ./ort/
const wasmDir = import.meta.env.DEV
  ? "/assets/ort/"
  : new URL("./ort/", import.meta.url).href;
ort.env.wasm.wasmPaths = wasmDir;
ort.env.wasm.simd = true;
ort.env.wasm.numThreads = 1;

console.log("[weapon-worker] Loading model from:", modelUrl, "WASM from:", wasmDir);

let sessionPromise;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
    }).then((s) => {
      console.log("[weapon-worker] ONNX session ready", {
        inputNames: s.inputNames,
        outputNames: s.outputNames,
      });
      return s;
    }).catch((err) => {
      console.error("[weapon-worker] ONNX session FAILED to load:", err);
      sessionPromise = null; // Allow retry
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
    if (Math.random() < 0.05) console.log(`[weapon-worker] inference: ${(t1 - t0).toFixed(0)}ms`);

    const firstKey = Object.keys(outputs)[0];
    const first = outputs[firstKey];

    // Debug output shape once
    if (!self._loggedDims) {
      console.log(`[weapon-worker] Model Output Dims (${firstKey}):`, first.dims);
      self._loggedDims = true;
    }

    self.postMessage(
      { data: first.data, dims: first.dims },
      [first.data.buffer]
    );
  } catch (err) {
    console.error("[weapon-worker] inference error:", err);
    // Post empty result so main thread resets _busy flag and can retry
    self.postMessage(new Float32Array(0));
  }
};
