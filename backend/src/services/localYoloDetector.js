import * as ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { makeLogger } from "../logger.js";
import { grabFrameOnce, grabMultipleFrames } from "./localDetector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = makeLogger("local-yolo-detector");
const KNIFE_CONFIDENCE_THRESHOLD = 0.40;

let fireSessionPromise = null;
let weaponSessionPromise = null;
let weaponLegacySessionPromise = null;
let maskSessionPromise = null;

function getModelsDir() {
  return process.env.MODELS_DIR_OVERRIDE || path.resolve(__dirname, "../../models");
}

function resolveModelPath(modelFile) {
  const configuredPath = path.join(getModelsDir(), modelFile);
  if (fs.existsSync(configuredPath)) return configuredPath;

  const bundledPath = path.resolve(__dirname, "../../models", modelFile);
  if (configuredPath !== bundledPath && fs.existsSync(bundledPath)) {
    log.warn({ configuredPath, bundledPath, modelFile }, "Configured model missing — using bundled fallback");
    return bundledPath;
  }

  return configuredPath;
}

function getFireSession() {
  if (!fireSessionPromise) {
    const modelPath = resolveModelPath("scaled_yolov4_p5_fire.onnx");
    log.info({ modelPath }, "Loading Fire YOLO model...");
    fireSessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    }).then((session) => {
      log.info({ inputNames: session.inputNames, outputNames: session.outputNames }, "✅ Fire YOLO session ready");
      return session;
    }).catch((err) => {
      fireSessionPromise = null;
      log.error({ error: err.message, modelPath }, "❌ Failed to load Fire YOLO model");
      throw err;
    });
  }
  return fireSessionPromise;
}

function getWeaponSession() {
  if (!weaponSessionPromise) {
    const modelPath = resolveModelPath("knife_yolov8n.onnx");
    log.info({ modelPath }, "Loading Knife YOLOv8n model...");
    weaponSessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    }).then((session) => {
      log.info({ inputNames: session.inputNames, outputNames: session.outputNames }, "✅ Knife YOLOv8n session ready");
      return session;
    }).catch((err) => {
      weaponSessionPromise = null;
      log.error({ error: err.message, modelPath }, "❌ Failed to load Knife YOLOv8n model");
      throw err;
    });
  }
  return weaponSessionPromise;
}

function getWeaponLegacySession() {
  if (!weaponLegacySessionPromise) {
    const modelPath = resolveModelPath("weapons_yolo.onnx");
    log.info({ modelPath }, "Loading Knife legacy YOLO model...");
    weaponLegacySessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    }).then((session) => {
      log.info({ inputNames: session.inputNames, outputNames: session.outputNames }, "✅ Knife legacy session ready");
      return session;
    }).catch((err) => {
      weaponLegacySessionPromise = null;
      log.warn({ error: err.message, modelPath }, "⚠️ Failed to load Knife legacy model — skipping");
      return null;
    });
  }
  return weaponLegacySessionPromise;
}

function getMaskSession() {
  if (!maskSessionPromise) {
    const modelPath = resolveModelPath("mask_yolov5.onnx");
    log.info({ modelPath }, "Loading Mask YOLO model...");
    maskSessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    }).then((session) => {
      log.info({ inputNames: session.inputNames, outputNames: session.outputNames }, "✅ Mask YOLO session ready");
      return session;
    }).catch((err) => {
      maskSessionPromise = null;
      log.error({ error: err.message, modelPath }, "❌ Failed to load Mask YOLO model");
      throw err;
    });
  }
  return maskSessionPromise;
}

async function prepareInput(jpegBuffer, modelInputSize = 640) {
  const metadata = await sharp(jpegBuffer).metadata();
  const originalWidth = metadata.width;
  const originalHeight = metadata.height;
  const scale = Math.min(modelInputSize / originalWidth, modelInputSize / originalHeight);
  const newW = Math.round(originalWidth * scale);
  const newH = Math.round(originalHeight * scale);
  const padX = (modelInputSize - newW) / 2;
  const padY = (modelInputSize - newH) / 2;

  const { data } = await sharp(jpegBuffer)
    .resize(modelInputSize, modelInputSize, {
      fit: "contain",
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = modelInputSize * modelInputSize;
  const tensor = new Float32Array(pixels * 3);
  let r = 0;
  let g = pixels;
  let b = pixels * 2;
  for (let i = 0; i < data.length; i += 3) {
    tensor[r++] = data[i] / 255;
    tensor[g++] = data[i + 1] / 255;
    tensor[b++] = data[i + 2] / 255;
  }

  return { tensor, originalWidth, originalHeight, scale, padX, padY };
}

function boxIoU(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const ax1 = ax - aw / 2;
  const ay1 = ay - ah / 2;
  const ax2 = ax + aw / 2;
  const ay2 = ay + ah / 2;
  const bx1 = bx - bw / 2;
  const by1 = by - bh / 2;
  const bx2 = bx + bw / 2;
  const by2 = by + bh / 2;
  const x1 = Math.max(ax1, bx1);
  const y1 = Math.max(ay1, by1);
  const x2 = Math.min(ax2, bx2);
  const y2 = Math.min(ay2, by2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = aw * ah + bw * bh - intersection;
  return union > 0 ? intersection / union : 0;
}

function nms(boxes, threshold, iouThreshold = 0.45) {
  const candidates = boxes.filter((box) => box[4] >= threshold).sort((a, b) => b[4] - a[4]);
  const kept = [];
  while (candidates.length) {
    const current = candidates.shift();
    kept.push(current);
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (boxIoU(current, candidates[i]) > iouThreshold) {
        candidates.splice(i, 1);
      }
    }
  }
  return kept;
}

function processYoloOutput(outputs, originalWidth, originalHeight, scale, padX, padY, classNames, options = {}) {
  // Prefer the named "output" tensor; fall back to first key for other models
  const output = outputs["output"] ?? outputs[Object.keys(outputs)[0]];
  const data = output.data;
  const dims = output.dims;
  if (!Array.isArray(dims) || dims.length !== 3) {
    throw new Error(`Unsupported YOLO output shape: ${JSON.stringify(dims)}`);
  }

  const anchorFirst = dims[2] <= 128 && dims[1] > dims[2];
  const channels = anchorFirst ? dims[2] : dims[1];
  const anchors = anchorFirst ? dims[1] : dims[2];
  const hasObjectness = options.hasObjectness ?? (channels === classNames.length + 5);
  const classes = channels - (hasObjectness ? 5 : 4);
  const prefilter = options.prefilter ?? 0.10;
  const threshold = options.threshold ?? 0.35;
  const allowedLabels = options.allowedLabels || classNames;

  const valueAt = (channel, anchor) => anchorFirst
    ? data[anchor * channels + channel]
    : data[channel * anchors + anchor];

  const raw = [];
  const topScores = [];
  for (let i = 0; i < anchors; i++) {
    const objectness = hasObjectness ? valueAt(4, i) : 1;
    if (objectness < prefilter) continue;

    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < classes; c++) {
      const classOffset = hasObjectness ? 5 : 4;
      const score = objectness * valueAt(classOffset + c, i);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    const label = classes === 1 && options.singleClassLabel
      ? options.singleClassLabel
      : classNames[bestClass] || `Unknown(${bestClass})`;
    if (bestScore > 0.10) topScores.push({ score: bestScore, label });
    if (bestScore < prefilter || !allowedLabels.includes(label)) continue;

    raw.push([
      valueAt(0, i),
      valueAt(1, i),
      valueAt(2, i),
      valueAt(3, i),
      bestScore,
      bestClass,
    ]);
  }

  topScores.sort((a, b) => b.score - a.score);
  log.info({
    top5: topScores.slice(0, 5).map((s) => ({ score: s.score.toFixed(4), label: s.label })),
  }, "YOLO: Top 5 raw scores");

  return nms(raw, threshold).map(([cx, cy, w, h, score, cls]) => {
    const x1 = Math.max(0, Math.min(originalWidth, (cx - w / 2 - padX) / scale));
    const y1 = Math.max(0, Math.min(originalHeight, (cy - h / 2 - padY) / scale));
    const x2 = Math.max(0, Math.min(originalWidth, (cx + w / 2 - padX) / scale));
    const y2 = Math.max(0, Math.min(originalHeight, (cy + h / 2 - padY) / scale));
    return [x1, y1, x2, y2, classNames[cls] || `Unknown(${cls})`, score];
  }).sort((a, b) => b[5] - a[5]);
}

async function runYolo(session, jpegBuffer, classNames, options) {
  const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer);
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", tensor, [1, 3, 640, 640]);
  const outputs = await session.run(feeds);
  return processYoloOutput(outputs, originalWidth, originalHeight, scale, padX, padY, classNames, options);
}

export async function detectFireYolo(cameraUrl, cameraName) {
  try {
    const session = await getFireSession();
    const frameBuffer = await grabFrameOnce(cameraUrl);
    const boxes = await runYolo(session, frameBuffer, ["Fire", "Smoke"], {
      threshold: 0.25,
      allowedLabels: ["Fire", "Smoke"],
    });
    return {
      isFire: boxes.length > 0,
      confidence: boxes[0]?.[5] || 0,
      boxes,
      fireCount: boxes.filter((box) => box[4] === "Fire").length,
      smokeCount: boxes.filter((box) => box[4] === "Smoke").length,
      frameBuffer,
    };
  } catch (error) {
    log.error({ camera: cameraName, error: error.message }, "🔥 YOLO Fire detection failed");
    return {
      isFire: false,
      confidence: 0,
      boxes: [],
      frameBuffer: null,
      error: error.message,
      transientReadError: true,
    };
  }
}

export async function detectFireMultiFrameYolo(cameraUrl, cameraName, numFrames = 3) {
  try {
    const session = await getFireSession();
    const frames = await grabMultipleFrames(cameraUrl, numFrames);
    const results = [];
    for (let i = 0; i < frames.length; i++) {
      const frameBuffer = frames[i];
      const boxes = await runYolo(session, frameBuffer, ["Fire", "Smoke", "Other"], {
        threshold: 0.25,
        allowedLabels: ["Fire", "Smoke"],
      });
      results.push({
        isFire: boxes.length > 0,
        confidence: boxes[0]?.[5] || 0,
        boxes,
        fireCount: boxes.filter((box) => box[4] === "Fire").length,
        smokeCount: boxes.filter((box) => box[4] === "Smoke").length,
        frameBuffer,
      });
      log.info({
        camera: cameraName,
        frame: `${i + 1}/${frames.length}`,
        detected: boxes.length > 0,
        boxes: boxes.length,
        topScore: boxes[0]?.[5]?.toFixed?.(4) || "0",
      }, "🔥 YOLO Fire multi-frame result");
    }
    return results;
  } catch (error) {
    log.error({ camera: cameraName, error: error.message }, "🔥 YOLO Fire multi-frame failed");
    return [{
      isFire: false,
      confidence: 0,
      boxes: [],
      frameBuffer: null,
      error: error.message,
      transientReadError: true,
    }];
  }
}

export async function detectWeaponYolo(cameraUrl, cameraName) {
  try {
    const [session, legacySession, frameBuffer] = await Promise.all([
      getWeaponSession(),
      getWeaponLegacySession(),
      grabFrameOnce(cameraUrl),
    ]);

    const [newBoxes, legacyBoxes] = await Promise.all([
      runYolo(session, frameBuffer, ["Gun", "explosion", "grenade", "knife"], {
        threshold: KNIFE_CONFIDENCE_THRESHOLD,
        allowedLabels: ["knife"],
        singleClassLabel: "knife",
      }).then((boxes) => boxes.map((b) => [b[0], b[1], b[2], b[3], "knife", b[5]])),
      legacySession
        ? runYolo(legacySession, frameBuffer, ["Knife", "Pistol"], {
            threshold: KNIFE_CONFIDENCE_THRESHOLD,
            allowedLabels: ["Knife"],
            singleClassLabel: "Knife",
          }).then((boxes) => boxes.map((b) => [b[0], b[1], b[2], b[3], "Knife", b[5]]))
        : Promise.resolve([]),
    ]);

    log.info({
      camera: cameraName,
      "knife_yolov8n.detected": newBoxes.length,
      "knife_yolov8n.topConf": newBoxes[0]?.[5]?.toFixed(3) || "—",
      "weapons_yolo.detected": legacyBoxes.length,
      "weapons_yolo.topConf": legacyBoxes[0]?.[5]?.toFixed(3) || "—",
    }, "🔫 Knife dual-model comparison");

    // Merge boxes from both models — deduplicate overlapping ones via NMS
    const allBoxes = [...newBoxes, ...legacyBoxes];
    const best = allBoxes.length > 0 ? allBoxes.reduce((a, b) => (b[5] > a[5] ? b : a)) : null;

    return {
      isWeapon: allBoxes.length > 0,
      confidence: best?.[5] || 0,
      boxes: allBoxes,
      frameBuffer,
    };
  } catch (error) {
    log.error({ camera: cameraName, error: error.message }, "🔫 YOLO Weapon detection failed");
    return {
      isWeapon: false,
      confidence: 0,
      boxes: [],
      frameBuffer: null,
      error: error.message,
      transientReadError: true,
    };
  }
}

export async function detectMaskYolo(cameraUrl, cameraName, frameBuffer = null) {
  try {
    const session = await getMaskSession();
    const buffer = frameBuffer || await grabFrameOnce(cameraUrl);
    const boxes = await runYolo(session, buffer, ["with_mask", "without_mask", "mask_weared_incorrect"], {
      threshold: 0.75,
      prefilter: 0.20,
      hasObjectness: true,
      allowedLabels: ["with_mask", "mask_weared_incorrect"],
    });

    log.info({
      camera: cameraName,
      detected: boxes.length > 0,
      boxes: boxes.length,
      topScore: boxes[0]?.[5]?.toFixed?.(4) || "0",
      topLabel: boxes[0]?.[4] || null,
    }, "🎭 YOLO Mask result");

    return {
      isMask: boxes.length > 0,
      confidence: boxes[0]?.[5] || 0,
      boxes,
      frameBuffer: buffer,
    };
  } catch (error) {
    log.error({ camera: cameraName, error: error.message }, "🎭 YOLO Mask detection failed");
    return {
      isMask: false,
      confidence: 0,
      boxes: [],
      frameBuffer: null,
      error: error.message,
      transientReadError: true,
    };
  }
}
