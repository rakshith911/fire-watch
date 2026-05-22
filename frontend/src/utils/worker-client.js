// frontend/src/utils/worker-client.js
import * as ort from "onnxruntime-web";

// Models live in publicDir (models/), served at root.
// In dev: /yolov11n_bestFire.onnx  In build: ./yolov11n_bestFire.onnx
const modelUrl = import.meta.env.DEV
  ? "/yolov11n_bestFire.onnx"
  : new URL("../yolov11n_bestFire.onnx", import.meta.url).href;

// WASM files: .wasm served from publicDir at /assets/ort/
// .mjs loaders redirected to node_modules by vite plugin (see vite.config.js)
// Production: WASM files are next to the compiled worker at ./ort/
const wasmDir = import.meta.env.DEV
  ? "/assets/ort/"
  : new URL("./ort/", import.meta.url).href;
ort.env.wasm.wasmPaths = wasmDir;

ort.env.wasm.simd = true;
ort.env.wasm.numThreads = 1;

const sessionOptions = { executionProviders: ["wasm"] };

// In packaged Electron (file://) you usually won't have cross-origin isolation,
// so SharedArrayBuffer may be unavailable. Keep it adaptive.
// ort.env.wasm.simd = true; // harmless if unsupported
// if (typeof SharedArrayBuffer !== "undefined") {
//   ort.env.wasm.numThreads = 4;
//   console.log("[worker] Multithread enabled");
// } else {
//   console.warn(
//     "[worker] SharedArrayBuffer not available; running single-thread"
//   );
// }

console.log("[fire-worker] Loading model from:", modelUrl, "WASM from:", wasmDir);

let sessionPromise;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelUrl, sessionOptions).then(
      (s) => {
        console.log("[fire-worker] ONNX session ready");
        return s;
      }
    ).catch((err) => {
      console.error("[fire-worker] ONNX session FAILED to load:", err);
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
    const inputName = session.inputNames[0] || "images";
    const outputs = await session.run({ [inputName]: tensor });
    const t1 = performance.now();
    if (Math.random() < 0.05) console.log(`[fire-worker] inference: ${(t1-t0).toFixed(0)}ms`);
    // Prefer named "output" tensor; ScaledYOLOv4 has auxiliary scale-head outputs we must skip
    const first = outputs["output"] ?? outputs[Object.keys(outputs)[0]];
    const outputDims = Array.from(first.dims);
    if (Math.random() < 0.02) console.log(`[fire-worker] output dims: [${outputDims}]`);
    // Send both data and dims so the main thread knows exact tensor layout
    self.postMessage({ data: first.data, dims: outputDims });
  } catch (err) {
    console.error("[worker] inference error:", err);
    self.postMessage({ data: new Float32Array(0), dims: [] });
  }
};
