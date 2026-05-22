/**
 * personDetector.js — YOLOv8n (COCO) person detection
 *
 * Detects people in a JPEG frame and returns bounding boxes.
 * Used to crop person regions before CLIP zero-shot classification,
 * giving much better behavioral label accuracy than full-frame CLIP.
 *
 * Model: yolov8n.onnx (~6MB, auto-downloaded on first use)
 * Output: [x1, y1, x2, y2, "Person", score]
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import { makeLogger } from "../logger.js";
import { ensureModel } from "./modelDownloader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = makeLogger("person-detector");

const MODEL_FILE  = "yolov8n.onnx";
const CONF_THRESH      = 0.50;
const IOU_THRESH       = 0.45;
const PERSON_CLS       = 0;    // COCO class 0 = person
const MIN_HEIGHT_RATIO = 0.15; // bbox must be ≥15% of frame height
const MIN_ASPECT_RATIO = 0.50; // bbox height/width ≥ 0.5 (taller than wide)

function getModelsDir() {
  return process.env.MODELS_DIR_OVERRIDE || path.resolve(__dirname, "../../models");
}

// ── Session (lazy + auto-download) ─────────────────────────────────────────
let _sessionPromise = null;

async function getSession() {
  if (_sessionPromise) return _sessionPromise;

  const modelPath = await ensureModel(MODEL_FILE, getModelsDir());

  _sessionPromise = ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
  }).then((s) => {
    log.info({ inputNames: s.inputNames, outputNames: s.outputNames }, "✅ Person YOLO session ready");
    return s;
  }).catch((err) => {
    _sessionPromise = null;
    log.error({ error: err.message }, "❌ Failed to load person YOLO model");
    throw err;
  });

  return _sessionPromise;
}

// ── Image preprocessing (letterbox to 640×640) ──────────────────────────────
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

// ── Decode YOLOv8 output [1, 84, 8400] ────────────────────────────────────
function decode(outputs, origW, origH, scale, padX, padY) {
  const out     = outputs[Object.keys(outputs)[0]];
  const data    = out.data;
  const anchors = out.dims[2]; // 8400
  const classes = out.dims[1] - 4;

  const raw = [];
  for (let i = 0; i < anchors; i++) {
    const personScore = data[(4 + PERSON_CLS) * anchors + i];
    if (personScore < CONF_THRESH) continue;
    const cx = data[0 * anchors + i];
    const cy = data[1 * anchors + i];
    const w  = data[2 * anchors + i];
    const h  = data[3 * anchors + i];
    raw.push([cx, cy, w, h, personScore]);
  }

  return nms(raw).flatMap(([cx, cy, w, h, score]) => {
    const x1 = Math.max(0, Math.min(origW, (cx - w/2 - padX) / scale));
    const y1 = Math.max(0, Math.min(origH, (cy - h/2 - padY) / scale));
    const x2 = Math.max(0, Math.min(origW, (cx + w/2 - padX) / scale));
    const y2 = Math.max(0, Math.min(origH, (cy + h/2 - padY) / scale));
    const bboxH = y2 - y1;
    const bboxW = x2 - x1;
    if (bboxH / origH < MIN_HEIGHT_RATIO) return [];           // too small — likely partial limb
    if (bboxW > 0 && bboxH / bboxW < MIN_ASPECT_RATIO) return []; // wider than tall — not a person
    if (bboxW / origW > 0.85 && bboxH / origH > 0.85) return []; // near-full-frame — screen/wall FP
    return [[x1, y1, x2, y2, "Person", score]];
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect persons in a JPEG buffer.
 * Returns array of [x1, y1, x2, y2, "Person", score] sorted by area descending.
 */
export async function detectPersons(jpegBuffer) {
  const session = await getSession();
  const { tensor, origW, origH, scale, padX, padY } = await prepareInput(jpegBuffer);
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", tensor, [1, 3, 640, 640]);
  const outputs = await session.run(feeds);
  const boxes = decode(outputs, origW, origH, scale, padX, padY);
  // Sort by box area descending so largest person is first
  return boxes.sort((a, b) => (b[2]-b[0])*(b[3]-b[1]) - (a[2]-a[0])*(a[3]-a[1]));
}

/**
 * Crop the largest detected person from a JPEG buffer.
 * Returns { cropBuffer, box } or null if no person found.
 * Adds 15% padding around the crop for better CLIP context.
 */
export async function cropLargestPerson(jpegBuffer) {
  const persons = await detectPersons(jpegBuffer);
  if (persons.length === 0) return null;

  const [x1, y1, x2, y2] = persons[0];
  const meta = await sharp(jpegBuffer).metadata();
  const W = meta.width, H = meta.height;

  // Add 15% padding
  const pw = (x2 - x1) * 0.15;
  const ph = (y2 - y1) * 0.15;
  const left   = Math.max(0, Math.floor(x1 - pw));
  const top    = Math.max(0, Math.floor(y1 - ph));
  const right  = Math.min(W, Math.ceil(x2 + pw));
  const bottom = Math.min(H, Math.ceil(y2 + ph));
  const width  = right - left;
  const height = bottom - top;

  if (width < 16 || height < 16) return null;

  const cropBuffer = await sharp(jpegBuffer)
    .extract({ left, top, width, height })
    .toBuffer();

  return { cropBuffer, box: persons[0], personCount: persons.length };
}
