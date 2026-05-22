// frontend/src/utils/worker-weapon.js
// Web Worker for knife/weapon detection using knife_yolov8n.onnx.
import * as ort from "onnxruntime-web";

const modelUrl = import.meta.env.DEV
  ? "/knife_yolov8n.onnx"
  : new URL("../knife_yolov8n.onnx", import.meta.url).href;

const wasmDir = import.meta.env.DEV
  ? "/assets/ort/"
  : new URL("./ort/", import.meta.url).href;
ort.env.wasm.wasmPaths = wasmDir;
ort.env.wasm.simd = true;
ort.env.wasm.numThreads = 1;

console.log("[weapon-worker] Loading model:", modelUrl);

let sessionPromise = null;

function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] })
      .then((s) => { console.log("[weapon-worker] knife_yolov8n ready"); return s; })
      .catch((err) => { console.error("[weapon-worker] knife_yolov8n failed:", err); sessionPromise = null; throw err; });
  }
  return sessionPromise;
}

self.onmessage = async (event) => {
  const { type, data, dims } = event.data || {};
  if (type !== "infer" || !data) return;

  try {
    const session = await getSession();
    const shape = dims || [1, 3, 640, 640];
    const tensor = new ort.Tensor(new Float32Array(data), shape);
    const t0 = performance.now();
    const inputName = session.inputNames[0] || "images";
    const out = await session.run({ [inputName]: tensor });
    const ms = (performance.now() - t0).toFixed(0);
    if (Math.random() < 0.05) console.log(`[weapon-worker] knife_yolov8n: ${ms}ms`);
    const newOut = out[Object.keys(out)[0]].data;
    self.postMessage({ newOut, legacyOut: new Float32Array(0) });
  } catch (err) {
    console.error("[weapon-worker] inference error:", err);
    self.postMessage({ newOut: new Float32Array(0), legacyOut: new Float32Array(0) });
  }
};
