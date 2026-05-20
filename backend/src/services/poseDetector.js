// poseDetector.js — YOLOv8n-pose keypoint detection
// Detects 17 COCO keypoints per person for use in behavioral classification.
// Output per person: [x1, y1, x2, y2, "Pose", score, keypoints]
// where keypoints = Float32Array of [x, y, visibility] * 17 in original coords.

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import pino from "pino";
import { ensureModel } from "./modelDownloader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ name: "pose-detector" });

const MODEL_FILE  = "yolov8n-pose.onnx";
const CONF_THRESH = 0.35;
const IOU_THRESH  = 0.45;

function getModelsDir() {
  return process.env.MODELS_DIR_OVERRIDE || path.resolve(__dirname, "../../models");
}

// ── Session ──────────────────────────────────────────────────────────────────
let _sessionPromise = null;

async function getSession() {
  if (_sessionPromise) return _sessionPromise;

  const modelPath = await ensureModel(MODEL_FILE, getModelsDir());

  _sessionPromise = ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
  }).then((s) => {
    log.info({ inputNames: s.inputNames, outputNames: s.outputNames }, "✅ Pose YOLO session ready");
    return s;
  }).catch((err) => {
    _sessionPromise = null;
    log.error({ error: err.message }, "❌ Failed to load pose YOLO model");
    throw err;
  });

  return _sessionPromise;
}

// ── Preprocessing (letterbox 640×640) ────────────────────────────────────────
async function prepareInput(jpegBuffer) {
  const meta  = await sharp(jpegBuffer).metadata();
  const origW = meta.width;
  const origH = meta.height;
  const scale = Math.min(640 / origW, 640 / origH);
  const newW  = Math.round(origW * scale);
  const newH  = Math.round(origH * scale);
  const padX  = (640 - newW) / 2;
  const padY  = (640 - newH) / 2;

  const { data } = await sharp(jpegBuffer)
    .resize(640, 640, { fit: "contain", background: { r: 114, g: 114, b: 114 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const N      = 640 * 640;
  const tensor = new Float32Array(N * 3);
  let r = 0, g = N, b = 2 * N;
  for (let i = 0; i < data.length; i += 3) {
    tensor[r++] = data[i]     / 255;
    tensor[g++] = data[i + 1] / 255;
    tensor[b++] = data[i + 2] / 255;
  }
  return { tensor, origW, origH, scale, padX, padY };
}

// ── NMS ──────────────────────────────────────────────────────────────────────
function iou([ax, ay, aw, ah], [bx, by, bw, bh]) {
  const [ax1, ay1, ax2, ay2] = [ax - aw/2, ay - ah/2, ax + aw/2, ay + ah/2];
  const [bx1, by1, bx2, by2] = [bx - bw/2, by - bh/2, bx + bw/2, by + bh/2];
  const inter = Math.max(0, Math.min(ax2,bx2) - Math.max(ax1,bx1)) *
                Math.max(0, Math.min(ay2,by2) - Math.max(ay1,by1));
  return inter / (aw*ah + bw*bh - inter || 1);
}

function nms(boxes) {
  const sorted = [...boxes].sort((a, b) => b[4] - a[4]);
  const kept   = [];
  while (sorted.length) {
    const cur = sorted.shift();
    kept.push(cur);
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(cur, sorted[i]) > IOU_THRESH) sorted.splice(i, 1);
    }
  }
  return kept;
}

// ── Decode YOLOv8-pose output [1, 56, 8400] ──────────────────────────────────
// Format: 4 bbox + 1 conf + 17*3 keypoints = 56 channels
function decode(outputs, origW, origH, scale, padX, padY) {
  const out     = outputs[Object.keys(outputs)[0]];
  const data    = out.data;
  const anchors = out.dims[2]; // 8400
  // channels: 4 (xywh) + 1 (conf) + 51 (17 kpts * 3)
  const KPT_OFFSET = 5;
  const NUM_KPT    = 17;

  const raw = [];
  for (let i = 0; i < anchors; i++) {
    const conf = data[4 * anchors + i];
    if (conf < CONF_THRESH) continue;
    const cx = data[0 * anchors + i];
    const cy = data[1 * anchors + i];
    const w  = data[2 * anchors + i];
    const h  = data[3 * anchors + i];

    // Extract 17 keypoints [kx, ky, kv] in letterboxed space
    const kpts = new Float32Array(NUM_KPT * 3);
    for (let k = 0; k < NUM_KPT; k++) {
      kpts[k * 3 + 0] = data[(KPT_OFFSET + k * 3 + 0) * anchors + i]; // kx
      kpts[k * 3 + 1] = data[(KPT_OFFSET + k * 3 + 1) * anchors + i]; // ky
      kpts[k * 3 + 2] = data[(KPT_OFFSET + k * 3 + 2) * anchors + i]; // visibility
    }
    raw.push([cx, cy, w, h, conf, kpts]);
  }

  return nms(raw).map(([cx, cy, w, h, score, kpts]) => {
    const x1 = Math.max(0, Math.min(origW, (cx - w/2 - padX) / scale));
    const y1 = Math.max(0, Math.min(origH, (cy - h/2 - padY) / scale));
    const x2 = Math.max(0, Math.min(origW, (cx + w/2 - padX) / scale));
    const y2 = Math.max(0, Math.min(origH, (cy + h/2 - padY) / scale));

    // Unproject keypoints to original image space
    const origKpts = new Float32Array(NUM_KPT * 3);
    for (let k = 0; k < NUM_KPT; k++) {
      origKpts[k * 3 + 0] = Math.max(0, (kpts[k * 3 + 0] - padX) / scale);
      origKpts[k * 3 + 1] = Math.max(0, (kpts[k * 3 + 1] - padY) / scale);
      origKpts[k * 3 + 2] = kpts[k * 3 + 2];
    }
    return [x1, y1, x2, y2, "Person", score, origKpts];
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect pose keypoints for all persons in a JPEG buffer.
 * Returns array of [x1, y1, x2, y2, "Person", score, Float32Array(51)] sorted by area desc.
 */
export async function detectPoses(jpegBuffer) {
  const session = await getSession();
  const { tensor, origW, origH, scale, padX, padY } = await prepareInput(jpegBuffer);
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", tensor, [1, 3, 640, 640]);
  const outputs = await session.run(feeds);
  const boxes = decode(outputs, origW, origH, scale, padX, padY);
  return boxes.sort((a, b) => (b[2]-b[0])*(b[3]-b[1]) - (a[2]-a[0])*(a[3]-a[1]));
}

/**
 * Get the largest person's pose keypoints.
 * Returns { box, keypoints, personCount } or null.
 * COCO keypoint order: 0=nose 1=left_eye 2=right_eye 3=left_ear 4=right_ear
 *   5=left_shoulder 6=right_shoulder 7=left_elbow 8=right_elbow
 *   9=left_wrist 10=right_wrist 11=left_hip 12=right_hip
 *   13=left_knee 14=right_knee 15=left_ankle 16=right_ankle
 */
export async function getLargestPersonPose(jpegBuffer) {
  const poses = await detectPoses(jpegBuffer);
  if (poses.length === 0) return null;
  const [x1, y1, x2, y2, , score, keypoints] = poses[0];
  return {
    box: [x1, y1, x2, y2, "Person", score],
    keypoints,
    personCount: poses.length,
  };
}
