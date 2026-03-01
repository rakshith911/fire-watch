import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { cfg } from "../config.js";
import pino from "pino";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ name: "local-yolo-detector" });

// -------------------------------------------------------------------
// 🎯 ONNX Session Management (Singleton)
// -------------------------------------------------------------------
// -------------------------------------------------------------------
// 🎯 ONNX Session Management (Singleton)
// -------------------------------------------------------------------
let fireSessionPromise = null;
let weaponSessionPromise = null;

function getModelsDir() {
    return process.env.MODELS_DIR_OVERRIDE
        ? process.env.MODELS_DIR_OVERRIDE
        : path.resolve(__dirname, "../../models");
}

function getFireSession() {
    if (!fireSessionPromise) {
        const modelsDir = getModelsDir();
        // User explicitly requested YOLO11 model as primary
        const primaryPath = path.join(modelsDir, "yolov11n_bestFire.onnx");
        const fallbackPath = path.join(modelsDir, "best.onnx");

        log.info({ primaryPath, fallbackPath }, "Attempting to load Fire YOLO model...");

        fireSessionPromise = (async () => {
            let modelPath = primaryPath;
            try {
                // Check if primary exists (fs is not imported but ort.InferenceSession.create fails if missing)
                log.info({ modelPath }, "Loading Fire YOLO (Primary: yolov11n_bestFire.onnx)...");
                return await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
            } catch (err) {
                log.warn({ error: err.message, modelPath }, "❌ Primary Fire model failed/missing. Trying fallback...");
                modelPath = fallbackPath;
                try {
                    log.info({ modelPath }, "Loading Fire YOLO (Fallback: best.onnx)...");
                    return await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
                } catch (fallbackErr) {
                    log.error({ error: fallbackErr.message, modelPath }, "❌ Fallback Fire model also failed");
                    throw fallbackErr;
                }
            }
        })().then((session) => {
            log.info("✅ Fire YOLO session ready");
            return session;
        }).catch((err) => {
            fireSessionPromise = null;
            throw err;
        });
    }
    return fireSessionPromise;
}

function getWeaponSession() {
    if (!weaponSessionPromise) {
        const modelsDir = getModelsDir();
        const modelPath = path.join(modelsDir, "weapons_yolo.onnx");

        log.info({ modelPath }, "Loading Weapon YOLO model...");
        weaponSessionPromise = ort.InferenceSession.create(modelPath, {
            executionProviders: ["cpu"],
        }).then((session) => {
            log.info("✅ Weapon YOLO session ready");
            return session;
        }).catch((err) => {
            log.error({ error: err.message }, "❌ Failed to load Weapon YOLO model");
            weaponSessionPromise = null;
            throw err;
        });
    }
    return weaponSessionPromise;
}

// -------------------------------------------------------------------
// 🖼️ Frame Extraction (Resued Logic)
// -------------------------------------------------------------------
// ... (Copied to be self-contained)
function grabFrameOnce(srcUrl) {
    return new Promise((resolve, reject) => {
        const isRtsp = srcUrl.startsWith("rtsp://");
        const args = ["-y"];
        if (isRtsp) {
            args.push(
                "-rtsp_transport", "tcp",
                "-timeout", "15000000",
                "-analyzeduration", "5000000",
                "-probesize", "10000000"
            );
        }
        args.push("-i", srcUrl, "-frames:v", "1", "-q:v", "2", "-f", "image2", "-");
        const ff = spawn(cfg.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [];
        let err = "";
        ff.stdout.on("data", (d) => chunks.push(d));
        ff.stderr.on("data", (d) => (err += d.toString()));
        ff.on("close", (code) => {
            if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
            else reject(new Error(`ffmpeg exit ${code}: ${err.split("\n").slice(-3).join(" ")}`));
        });
    });
}

function grabMultipleFrames(srcUrl, numFrames = 3) {
    return new Promise((resolve, reject) => {
        const args = ["-y"];
        if (srcUrl.startsWith("rtsp://")) {
            args.push(
                "-rtsp_transport", "tcp",
                "-timeout", "15000000",
                "-analyzeduration", "5000000",
                "-probesize", "10000000"
            );
        }
        const duration = numFrames + 2;
        args.push("-i", srcUrl, "-t", String(duration), "-vf", "fps=1", "-frames:v", String(numFrames), "-q:v", "2", "-f", "image2pipe", "pipe:1");

        const ff = spawn(cfg.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
        const allData = [];
        ff.stdout.on("data", (d) => allData.push(d));
        ff.on("close", (code) => {
            if (code !== 0 && allData.length === 0) {
                reject(new Error(`ffmpeg exit ${code}`));
                return;
            }
            const fullBuffer = Buffer.concat(allData);
            // Split JPEGs (FF D8)
            const frames = [];
            let start = 0;
            for (let i = 0; i < fullBuffer.length - 1; i++) {
                if (fullBuffer[i] === 0xFF && fullBuffer[i + 1] === 0xD8 && i > start) {
                    frames.push(fullBuffer.subarray(start, i));
                    start = i;
                }
            }
            if (start < fullBuffer.length) frames.push(fullBuffer.subarray(start));
            resolve(frames.filter(f => f.length > 1000));
        });
    });
}

// -------------------------------------------------------------------
// 🔄 Preprocessing
// -------------------------------------------------------------------
async function prepareInput(jpegBuffer, modelInputSize = 640) {
    const metadata = await sharp(jpegBuffer).metadata();
    const origW = metadata.width;
    const origH = metadata.height;
    const scale = Math.min(modelInputSize / origW, modelInputSize / origH);
    const newW = Math.round(origW * scale);
    const newH = Math.round(origH * scale);
    const padX = (modelInputSize - newW) / 2;
    const padY = (modelInputSize - newH) / 2;

    const { data } = await sharp(jpegBuffer)
        .resize(modelInputSize, modelInputSize, { fit: "contain", background: { r: 114, g: 114, b: 114 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

    const N = modelInputSize * modelInputSize;
    const arr = new Float32Array(N * 3);
    let r = 0, g = N, b = 2 * N;
    for (let i = 0; i < data.length; i += 3) {
        arr[r++] = data[i] / 255.0;
        arr[g++] = data[i + 1] / 255.0;
        arr[b++] = data[i + 2] / 255.0;
    }
    return { tensor: arr, originalWidth: origW, originalHeight: origH, scale, padX, padY };
}

// -------------------------------------------------------------------
// 🧠 NMS (Non-Maximum Suppression)
// -------------------------------------------------------------------
function iou(box1, box2) {
    const [x1, y1, w1, h1] = box1;
    const [x2, y2, w2, h2] = box2;
    const xi1 = Math.max(x1 - w1 / 2, x2 - w2 / 2);
    const yi1 = Math.max(y1 - h1 / 2, y2 - h2 / 2);
    const xi2 = Math.min(x1 + w1 / 2, x2 + w2 / 2);
    const yi2 = Math.min(y1 + h1 / 2, y2 + h2 / 2);
    const interArea = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
    const unionArea = w1 * h1 + w2 * h2 - interArea;
    return interArea / unionArea;
}

function nonMaxSuppression(boxes, confThreshold, iouThreshold) {
    // boxes: [cx, cy, w, h, score, classId]
    const candidates = boxes.filter(b => b[4] > confThreshold);
    candidates.sort((a, b) => b[4] - a[4]);

    const selected = [];
    while (candidates.length > 0) {
        const current = candidates.shift();
        selected.push(current);
        for (let i = candidates.length - 1; i >= 0; i--) {
            if (iou(current, candidates[i]) > iouThreshold) {
                candidates.splice(i, 1);
            }
        }
    }
    return selected;
}

// -------------------------------------------------------------------
// 📊 Post-Processing (YOLO specific)
// -------------------------------------------------------------------
function processYoloOutput(outputs, origW, origH, scale, padX, padY, classNames) {
    // Output shape: [1, 4 + numClasses, 8400]
    // We need to transpose to [8400, 4 + numClasses]
    const output = outputs[Object.keys(outputs)[0]]; // Assume single output
    const data = output.data;
    const dims = output.dims; // [1, channels, anchors]

    const numChannels = dims[1]; // 4 + numClasses
    const numAnchors = dims[2];  // 8400 usually
    const numClasses = numChannels - 4;

    const boxes = [];

    // Transpose loop: data is stored as [channel, anchor] (planar), NOT [anchor, channel]
    // channel 0..3 are cx, cy, w, h
    // channel 4.. are classes

    // We iterate over anchors
    const rawScores = []; // Debugging: Track top raw scores
    for (let i = 0; i < numAnchors; i++) {
        // Find best class score
        let maxScore = 0;
        let maxClass = -1;

        for (let c = 0; c < numClasses; c++) {
            const score = data[(4 + c) * numAnchors + i]; // (4+c) * stride + index
            if (score > maxScore) {
                maxScore = score;
                maxClass = c;
            }
        }

        // Debugging: Collect top scores
        if (maxScore > 0.10) {
            rawScores.push({ score: maxScore, cls: maxClass, label: classNames[maxClass] || "Unknown" });
        }

        if (maxScore > 0.25) { // Pre-filter for NMS speed
            const cx = data[0 * numAnchors + i];
            const cy = data[1 * numAnchors + i];
            const w = data[2 * numAnchors + i];
            const h = data[3 * numAnchors + i];

            boxes.push([cx, cy, w, h, maxScore, maxClass]);
        }
    }

    // Sort and log top 5 raw scores
    rawScores.sort((a, b) => b.score - a.score);
    const top5 = rawScores.slice(0, 5).map(s => ({ score: s.score.toFixed(4), label: s.label }));
    if (top5.length > 0) {
        log.info({ top5 }, "🔫 YOLO: Top 5 Raw Scores");
    }

    // Higher threshold for weapons to avoid false positives (e.g. laptop as knife)
    const nmsThreshold = classNames.includes("Knife") ? 0.50 : 0.40;
    const nmsBoxes = nonMaxSuppression(boxes, nmsThreshold, 0.45);


    const finalBoxes = nmsBoxes.map(b => {
        const [cx, cy, w, h, score, cls] = b;

        // Scale to 640x640 letterbox coordinates
        const x1_640 = cx - w / 2;
        const y1_640 = cy - h / 2;
        const x2_640 = cx + w / 2;
        const y2_640 = cy + h / 2;

        // Scale to original image
        const x1 = Math.max(0, Math.min(origW, (x1_640 - padX) / scale));
        const y1 = Math.max(0, Math.min(origH, (y1_640 - padY) / scale));
        const x2 = Math.max(0, Math.min(origW, (x2_640 - padX) / scale));
        const y2 = Math.max(0, Math.min(origH, (y2_640 - padY) / scale));

        return [x1, y1, x2, y2, classNames[cls] || "Unknown", score];
    });

    return finalBoxes;
}

// -------------------------------------------------------------------
// 🔥 Main Detect Functions
// -------------------------------------------------------------------
export async function detectFireYolo(cameraUrl, cameraName) {
    try {
        const session = await getFireSession();
        const jpegBuffer = await grabFrameOnce(cameraUrl);
        const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer);

        const feeds = {};
        feeds[session.inputNames[0]] = new ort.Tensor("float32", tensor, [1, 3, 640, 640]);
        const outputs = await session.run(feeds);

        // Fire Class Names (Assuming generic model structure)
        // Usually: 0: Fire, 1: Smoke, or similar.
        const boxes = processYoloOutput(outputs, originalWidth, originalHeight, scale, padX, padY, ["Fire", "Smoke", "Other"]);

        const fireBoxes = boxes.filter(b => b[4] === "Fire" || b[4] === "Smoke"); // only pass relevant
        fireBoxes.sort((a, b) => b[5] - a[5]);

        return {
            isFire: fireBoxes.length > 0,
            confidence: fireBoxes[0]?.[5] || 0,
            boxes: fireBoxes,
            frameBuffer: jpegBuffer
        };
    } catch (e) {
        log.error({ error: e.message }, "🔥 YOLO Fire Detection Failed");
        return { isFire: false, boxes: [], error: e.message };
    }
}

export async function detectWeaponYolo(cameraUrl, cameraName) {
    try {
        const session = await getWeaponSession();
        const jpegBuffer = await grabFrameOnce(cameraUrl);
        const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer);

        const feeds = {};
        feeds[session.inputNames[0]] = new ort.Tensor("float32", tensor, [1, 3, 640, 640]);
        const outputs = await session.run(feeds);

        // Weapon Class Names
        const boxes = processYoloOutput(outputs, originalWidth, originalHeight, scale, padX, padY, ["Knife", "Pistol", "Rifle"]);
        boxes.sort((a, b) => b[5] - a[5]);

        if (boxes.length > 0) {
            log.info({ topScore: boxes[0][5], label: boxes[0][4] }, "🔫 YOLO: Top detection");
        } else {
            // Log that we ran but found nothing (maybe add raw score logging inside processYoloOutput later?)
            log.info("🔫 YOLO: No weapons detected above threshold");
        }

        return {
            isWeapon: boxes.length > 0,
            confidence: boxes[0]?.[5] || 0,
            boxes: boxes,
            frameBuffer: jpegBuffer
        };
    } catch (e) {
        log.error({ error: e.message }, "🔫 YOLO Weapon Detection Failed");
        return { isWeapon: false, boxes: [], error: e.message };
    }
}

// Multi-frame support (wraps single frame logic for now or uses shared grabber)
export async function detectFireMultiFrameYolo(cameraUrl, cameraName, numFrames = 3) {
    // For simplicity, reuse single frame logic in loop or implement optimized multi-grab
    // Implementation of optimized multi-grab:
    try {
        const frames = await grabMultipleFrames(cameraUrl, numFrames);
        const session = await getFireSession();

        const results = [];
        for (const jpeg of frames) {
            const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpeg);
            const feeds = {};
            feeds[session.inputNames[0]] = new ort.Tensor("float32", tensor, [1, 3, 640, 640]);
            const outputs = await session.run(feeds);

            const boxes = processYoloOutput(outputs, originalWidth, originalHeight, scale, padX, padY, ["Fire", "Smoke"]);
            const fireBoxes = boxes.filter(b => b[4] === "Fire" || b[4] === "Smoke");

            results.push({
                isFire: fireBoxes.length > 0,
                boxes: fireBoxes,
                confidence: fireBoxes[0]?.[5] || 0,
                frameBuffer: jpeg,
                aiType: "FIRE" // or FIRE_YOLO
            });
        }
        return results;

    } catch (e) {
        log.error({ error: e.message }, "🔥 YOLO Multi-Frame Failed");
        return [];
    }
}
