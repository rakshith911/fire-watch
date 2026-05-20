// vjepaSidecar.js — manages the Python V-JEPA inference process
// Spawns once, keeps alive, communicates via JSON lines on stdin/stdout.

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import pino from "pino";

const log = pino({ name: "vjepa-sidecar" });
const SIDECAR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../vjepa/sidecar.py"
);

let proc = null;
let ready = false;
let pendingResolvers = []; // queue of {resolve, reject} waiting for a response
let buffer = "";

function start() {
  if (proc) return;

  log.info("Spawning V-JEPA sidecar…");
  proc = spawn("python3", [SIDECAR_PATH], {
    stdio: ["pipe", "pipe", "inherit"], // stdin, stdout piped; stderr → parent stderr
  });

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === "ready") {
          ready = true;
          log.info({ device: msg.device }, "V-JEPA sidecar ready");
          return;
        }
        const next = pendingResolvers.shift();
        if (next) {
          msg.ok ? next.resolve(msg) : next.reject(new Error(msg.error || "sidecar error"));
        }
      } catch (e) {
        log.warn({ line }, "Failed to parse sidecar output");
      }
    }
  });

  proc.on("exit", (code) => {
    log.warn({ code }, "V-JEPA sidecar exited — will restart on next call");
    proc = null;
    ready = false;
    buffer = "";
    // Reject any pending
    for (const r of pendingResolvers) r.reject(new Error("sidecar exited"));
    pendingResolvers = [];
  });
}

function send(msg) {
  return new Promise((resolve, reject) => {
    if (!proc || !ready) {
      return reject(new Error("V-JEPA sidecar not ready"));
    }
    pendingResolvers.push({ resolve, reject });
    proc.stdin.write(JSON.stringify(msg) + "\n");
  });
}

function waitReady(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (ready) return resolve();
    const deadline = Date.now() + timeoutMs;
    const check = setInterval(() => {
      if (ready) { clearInterval(check); resolve(); }
      else if (Date.now() > deadline) { clearInterval(check); reject(new Error("V-JEPA sidecar startup timeout")); }
    }, 200);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startSidecar() {
  start();
}

export function waitSidecarReady(timeoutMs = 120000) {
  return waitReady(timeoutMs);
}

/**
 * Fire/smoke tier-2 temporal inference via VideoMAE.
 * @param {string[]} framesB64 - base64-encoded JPEG frames
 * @param {"B"|"H"} modelSize
 */
export async function inferClip(framesB64, modelSize = "B") {
  if (!proc) start();
  await waitReady();
  return send({ cmd: "infer", frames_b64: framesB64, model: modelSize });
}

/**
 * CLIP ViT-L/14 zero-shot classification on a single frame.
 * Returns { label, top_prompt, top_prob, probs, inference_ms }
 * label is null when the frame looks normal or confidence is below threshold.
 */
export async function classifyWithClip(imageB64, prompts = null, labels = null) {
  if (!proc) start();
  await waitReady();
  const msg = { cmd: "clip_classify", image_b64: imageB64 };
  if (prompts) msg.prompts = prompts;
  if (labels)  msg.labels  = labels;
  return send(msg);
}

/**
 * CLIP ViT-L/14 zero-shot classification on a sequence of frames.
 * Builds a 3-frame temporal composite (start/mid/end) so CLIP can observe
 * motion — much more reliable for actions like dancing, entering, carrying.
 * Returns { label, top_prompt, top_prob, probs, frame_count, inference_ms }
 */
export async function classifySequenceWithClip(framesB64, prompts = null, labels = null) {
  if (!proc) start();
  await waitReady();
  const msg = { cmd: "clip_classify_sequence", frames_b64: framesB64 };
  if (prompts) msg.prompts = prompts;
  if (labels)  msg.labels  = labels;
  return send(msg);
}

/**
 * V-JEPA ViT-H (VideoMAE-Large) anomaly score vs per-camera baseline.
 * Returns { anomaly_score, anomaly_trigger, baseline_ready, baseline_samples, inference_ms }
 *
 * @param {string[]} framesB64
 * @param {string|number} cameraId - used to key the per-camera baseline
 * @param {boolean} isThreat - if true, don't update the normal baseline
 */
export async function getAnomalyScore(framesB64, cameraId, isThreat = false) {
  if (!proc) start();
  await waitReady();
  return send({
    cmd:        "anomaly_score",
    frames_b64: framesB64,
    camera_id:  String(cameraId),
    is_threat:  isThreat,
  });
}

export async function runBenchmark() {
  if (!proc) start();
  await waitReady(120000);
  return send({ cmd: "benchmark" });
}

export async function ping() {
  if (!proc) start();
  await waitReady();
  return send({ cmd: "ping" });
}

export function stopSidecar() {
  if (proc) {
    proc.kill();
    proc = null;
    ready = false;
  }
}
