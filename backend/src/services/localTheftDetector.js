import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { cfg } from "../config.js";
import pino from "pino";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ name: "local-theft-detector" });

// -------------------------------------------------------------------
// 🎯 ONNX Session Management (Singleton)
// -------------------------------------------------------------------
let sessionPromise = null;

function getSession() {
    if (!sessionPromise) {
        let modelPath;
        if (process.env.MODELS_DIR_OVERRIDE) {
            modelPath = path.join(process.env.MODELS_DIR_OVERRIDE, "theft.onnx");
        } else {
            modelPath = path.resolve(__dirname, "../../models/theft.onnx");
        }
        log.info({ modelPath }, "Loading Theft ONNX model...");

        sessionPromise = ort.InferenceSession.create(modelPath, {
            executionProviders: ["cpu"],
        }).then((session) => {
            log.info("✅ Theft ONNX session ready");
            log.info({ inputNames: session.inputNames, outputNames: session.outputNames }, "Model Metadata");
            return session;
        }).catch((err) => {
            log.error({ error: err.message }, "❌ Failed to load Theft ONNX model");
            sessionPromise = null;
            throw err;
        });
    }
    return sessionPromise;
}

// -------------------------------------------------------------------
// 🖼️ Frame Extraction via ffmpeg
// -------------------------------------------------------------------
function grabFrameOnce(srcUrl) {
    return new Promise((resolve, reject) => {
        const isRtsp = srcUrl.startsWith("rtsp://");
        const args = ["-y"];

        if (isRtsp) {
            args.push(
                "-rtsp_transport", "tcp",
                "-analyzeduration", "1000000",
                "-probesize", "1000000"
            );
        }

        args.push("-i", srcUrl, "-frames:v", "1", "-q:v", "2", "-f", "image2", "-");

        const ff = spawn(cfg.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [];
        let err = "";

        ff.stdout.on("data", (d) => chunks.push(d));
        ff.stderr.on("data", (d) => (err += d.toString()));
        ff.on("error", reject);
        ff.on("close", (code) => {
            if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
            else reject(new Error(`ffmpeg exit ${code}: ${err.split("\n").slice(-3).join(" ")}`));
        });
    });
}

// -------------------------------------------------------------------
// 🔄 Image Preprocessing (FIXED: returns original dimensions + letterbox info)
// -------------------------------------------------------------------
async function prepareInput(jpegBuffer, modelInputSize = 640) {
    try {
        const metadata = await sharp(jpegBuffer).metadata();
        const origW = metadata.width;
        const origH = metadata.height;

        // Calculate letterbox parameters
        const scale = Math.min(modelInputSize / origW, modelInputSize / origH);
        const newW = Math.round(origW * scale);
        const newH = Math.round(origH * scale);
        const padX = (modelInputSize - newW) / 2;  // Left padding
        const padY = (modelInputSize - newH) / 2;  // Top padding

        const { data } = await sharp(jpegBuffer)
            .resize(modelInputSize, modelInputSize, {
                fit: "contain",
                background: { r: 114, g: 114, b: 114 }
            })
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

        return {
            tensor: arr,
            originalWidth: origW,
            originalHeight: origH,
            scale,      // The scale factor used
            padX,       // Horizontal padding (left)
            padY        // Vertical padding (top)
        };
    } catch (e) {
        log.error({ error: e.message }, "Failed to preprocess image");
        throw e;
    }
}

// -------------------------------------------------------------------
// 🧠 ONNX Inference
// -------------------------------------------------------------------
async function runInference(inputTensor) {
    try {
        const session = await getSession();

        const tensor = new ort.Tensor(
            "float32",
            inputTensor,
            [1, 3, 640, 640]
        );

        const inputName = session.inputNames[0];
        const feeds = {};
        feeds[inputName] = tensor;

        const outputs = await session.run(feeds);
        return outputs;
    } catch (e) {
        log.error({ error: e.message }, "Inference failed");
        throw e;
    }
}

// -------------------------------------------------------------------
// 📊 NMS Helper Functions
// -------------------------------------------------------------------
function computeIoU(boxA, boxB) {
    const [ax1, ay1, ax2, ay2] = boxA;
    const [bx1, by1, bx2, by2] = boxB;

    const ix1 = Math.max(ax1, bx1);
    const iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);

    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const intersection = iw * ih;

    const areaA = (ax2 - ax1) * (ay2 - ay1);
    const areaB = (bx2 - bx1) * (by2 - by1);
    const union = areaA + areaB - intersection;

    return union > 0 ? intersection / union : 0;
}

function applyNMS(boxes, iouThreshold = 0.5) {
    if (boxes.length === 0) return [];

    const result = [];
    const used = new Set();

    for (let i = 0; i < boxes.length; i++) {
        if (used.has(i)) continue;

        result.push(boxes[i]);
        used.add(i);

        for (let j = i + 1; j < boxes.length; j++) {
            if (used.has(j)) continue;
            if (computeIoU(boxes[i], boxes[j]) > iouThreshold) {
                used.add(j);
            }
        }
    }
    return result;
}

// -------------------------------------------------------------------
// 📊 Process YOLOv8 Output (FIXED: Column-Major Layout + letterbox compensation)
// -------------------------------------------------------------------
function processOutput(outputs, originalWidth, originalHeight, scale, padX, padY) {
    let boxes = [];
    const keys = Object.keys(outputs);

    let combined = null;
    if (keys.length === 1) {
        combined = outputs[keys[0]].data;
    } else {
        log.warn({ keys }, "Unexpected output format");
        return { boxes: [], detected: false };
    }

    // YOLOv8 output shape: [1, 6, 8400] → flattened = 50400
    // 6 = [cx, cy, w, h, class0_score, class1_score]
    // Layout is COLUMN-MAJOR (all cx first, then all cy, etc.)

    const numChannels = 6;  // 4 box coords + 2 classes
    const numDetections = combined.length / numChannels;  // Should be 8400

    log.info({
        dataLength: combined.length,
        calculatedDetections: numDetections,
        expectedDetections: 8400
    }, "🕵️ THEFT: Output shape analysis");

    if (numDetections !== 8400) {
        log.warn({ numDetections }, "Unexpected number of detections - model may have different output");
    }

    const probThreshold = 0.5;

    // Column-major accessors
    // Data layout: [all_cx, all_cy, all_w, all_h, all_class0, all_class1]
    const getCx = (i) => combined[i];
    const getCy = (i) => combined[numDetections + i];
    const getW = (i) => combined[2 * numDetections + i];
    const getH = (i) => combined[3 * numDetections + i];
    const getClass0Score = (i) => combined[4 * numDetections + i];  // theft-action
    const getClass1Score = (i) => combined[5 * numDetections + i];  // normal

    // DEBUG: Log top 5 theft-action scores
    const allScores = [];
    for (let i = 0; i < numDetections; i++) {
        const s0 = getClass0Score(i);  // theft-action
        const s1 = getClass1Score(i);  // normal
        allScores.push({
            theftScore: s0,
            normalScore: s1,
            index: i,
            cx: getCx(i),
            cy: getCy(i)
        });
    }

    // Sort by theft-action score (class 0)
    allScores.sort((a, b) => b.theftScore - a.theftScore);

    const top5 = allScores.slice(0, 5).map(s => ({
        theftScore: s.theftScore.toFixed(4),
        normalScore: s.normalScore.toFixed(4),
        position: `(${s.cx.toFixed(0)}, ${s.cy.toFixed(0)})`
    }));
    log.info({ top5, letterbox: { scale, padX, padY } }, "🕵️ THEFT: Top 5 Theft-Action Scores (class 0)");

    for (let i = 0; i < numDetections; i++) {
        const theftScore = getClass0Score(i);  // Class 0 = theft-action

        // Only detect theft-action (class 0), ignore normal (class 1)
        if (theftScore < probThreshold) continue;

        const cx = getCx(i);
        const cy = getCy(i);
        const w = getW(i);
        const h = getH(i);

        // Convert center format to corner format (still in 640x640 space)
        const x1_640 = cx - w / 2;
        const y1_640 = cy - h / 2;
        const x2_640 = cx + w / 2;
        const y2_640 = cy + h / 2;

        // Remove letterbox padding, then scale to original image coordinates
        const x1 = (x1_640 - padX) / scale;
        const y1 = (y1_640 - padY) / scale;
        const x2 = (x2_640 - padX) / scale;
        const y2 = (y2_640 - padY) / scale;

        // Clamp to image bounds
        const x1_clamped = Math.max(0, Math.min(originalWidth, x1));
        const y1_clamped = Math.max(0, Math.min(originalHeight, y1));
        const x2_clamped = Math.max(0, Math.min(originalWidth, x2));
        const y2_clamped = Math.max(0, Math.min(originalHeight, y2));

        boxes.push([x1_clamped, y1_clamped, x2_clamped, y2_clamped, "Theft", theftScore]);
    }

    // Sort by confidence
    boxes.sort((a, b) => b[5] - a[5]);

    // Apply NMS (YOLOv8 produces many overlapping detections)
    boxes = applyNMS(boxes, 0.5);

    log.info({
        beforeNMS: allScores.filter(s => s.theftScore >= probThreshold).length,
        afterNMS: boxes.length,
        threshold: probThreshold
    }, "🕵️ THEFT: Detection summary");

    return {
        boxes,
        detected: boxes.length > 0
    };
}

// -------------------------------------------------------------------
// 🕵️ Main Theft Detection Function
// -------------------------------------------------------------------
export async function detectTheft(cameraUrl, cameraName) {
    try {
        const jpegBuffer = await grabFrameOnce(cameraUrl);
        const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer, 640);
        const outputs = await runInference(tensor);

        const debugShapes = {};
        for (const key in outputs) {
            debugShapes[key] = outputs[key].dims;
        }
        log.info({
            camera: cameraName,
            outputShapes: debugShapes,
            originalSize: `${originalWidth}x${originalHeight}`,
            letterbox: { scale: scale.toFixed(4), padX: padX.toFixed(1), padY: padY.toFixed(1) }
        }, "🕵️ THEFT: Inference Output");

        const result = processOutput(outputs, originalWidth, originalHeight, scale, padX, padY);

        log.info({
            camera: cameraName,
            detected: result.detected,
            boxCount: result.boxes.length,
        }, "🕵️ THEFT: Detection complete");

        return {
            isTheft: result.detected,
            confidence: result.boxes.length > 0 ? result.boxes[0][5] : 0,
            boxes: result.boxes,
            frameBuffer: jpegBuffer,
        };
    } catch (error) {
        log.error({
            camera: cameraName,
            error: error.message,
        }, "🕵️ THEFT: Detection failed");

        return {
            isTheft: false,
            confidence: 0,
            boxes: [],
            error: error.message,
            frameBuffer: null,
        };
    }
}
