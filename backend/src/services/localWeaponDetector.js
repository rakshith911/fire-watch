import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { cfg } from "../config.js";
import pino from "pino";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ name: "local-weapon-detector" });

// -------------------------------------------------------------------
// 🎯 ONNX Session Management (Singleton)
// -------------------------------------------------------------------
let sessionPromise = null;

function getSession() {
    if (!sessionPromise) {
        let modelPath;
        if (process.env.MODELS_DIR_OVERRIDE) {
            modelPath = path.join(process.env.MODELS_DIR_OVERRIDE, "weapons.onnx");
        } else {
            modelPath = path.resolve(__dirname, "../../models/weapons.onnx");
        }
        log.info({ modelPath }, "Loading Weapons ONNX model...");

        sessionPromise = ort.InferenceSession.create(modelPath, {
            executionProviders: ["cpu"],
        }).then((session) => {
            log.info("✅ Weapons ONNX session ready");
            log.info({ inputNames: session.inputNames, outputNames: session.outputNames }, "Model Metadata");
            return session;
        }).catch((err) => {
            log.error({ error: err.message }, "❌ Failed to load Weapons ONNX model");
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
// 📊 Process RT-DETR Output (FIXED: correct format + letterbox compensation)
// -------------------------------------------------------------------
function processOutput(outputs, originalWidth, originalHeight, scale, padX, padY) {
    let boxes = [];
    const keys = Object.keys(outputs);

    // RT-DETR outputs single tensor [1, 300, 6]
    let combined = null;
    if (keys.length === 1) {
        combined = outputs[keys[0]].data;
    } else {
        log.warn({ keys }, "Unexpected output format");
        return { boxes: [], detected: false };
    }

    const numQueries = 300;
    const stride = 6;  // RT-DETR format: [x1, y1, x2, y2, conf, class_id]
    const probThreshold = 0.5;  // Lowered from 0.65 for testing

    // Verify data length
    const expectedLength = numQueries * stride;
    if (combined.length !== expectedLength) {
        log.warn({
            expected: expectedLength,
            actual: combined.length,
            possibleFormat: `[1, ${combined.length / 6}, 6] or other`
        }, "Unexpected data length - model output may differ");
    }

    // DEBUG: Log top 5 scores
    const allScores = [];
    for (let i = 0; i < numQueries; i++) {
        const offset = i * stride;
        if (offset + 5 >= combined.length) break;

        const conf = combined[offset + 4];
        const classId = Math.round(combined[offset + 5]);
        allScores.push({
            score: conf,
            class: classId,
            index: i,
            rawBox: [
                combined[offset].toFixed(1),
                combined[offset + 1].toFixed(1),
                combined[offset + 2].toFixed(1),
                combined[offset + 3].toFixed(1)
            ]
        });
    }
    allScores.sort((a, b) => b.score - a.score);

    const top5 = allScores.slice(0, 5).map(s => ({
        score: s.score.toFixed(4),
        label: ["Knife", "Pistol"][s.class] ?? `Unknown(${s.class})`,
        classIndex: s.class,
        rawBox: s.rawBox
    }));
    log.info({ top5, letterbox: { scale, padX, padY } }, "🔫 WEAPON: Top 5 Raw Scores (RT-DETR format: x1,y1,x2,y2,conf,cls)");

    for (let i = 0; i < numQueries; i++) {
        const offset = i * stride;
        if (offset + 5 >= combined.length) break;

        // RT-DETR format: [x1, y1, x2, y2, confidence, class_id]
        // Coordinates are ABSOLUTE in 640x640 space (includes letterbox padding)
        const x1_640 = combined[offset + 0];
        const y1_640 = combined[offset + 1];
        const x2_640 = combined[offset + 2];
        const y2_640 = combined[offset + 3];
        const confidence = combined[offset + 4];
        const classId = Math.round(combined[offset + 5]);

        if (confidence < probThreshold) continue;
        if (classId < 0 || classId > 1) continue;

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

        const label = ["Knife", "Pistol"][classId];
        boxes.push([x1_clamped, y1_clamped, x2_clamped, y2_clamped, label, confidence]);
    }

    boxes.sort((a, b) => b[5] - a[5]);

    log.info({
        totalDetections: boxes.length,
        aboveThreshold: boxes.length,
        threshold: probThreshold
    }, "🔫 WEAPON: Detection summary");

    return {
        boxes,
        detected: boxes.length > 0,
    };
}

// -------------------------------------------------------------------
// 🔫 Main Weapon Detection Function
// -------------------------------------------------------------------
export async function detectWeapon(cameraUrl, cameraName) {
    try {
        const jpegBuffer = await grabFrameOnce(cameraUrl);
        const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer, 640);
        const outputs = await runInference(tensor);

        // Log output shape for debugging
        const debugShapes = {};
        for (const key in outputs) {
            debugShapes[key] = outputs[key].dims;
        }
        log.info({
            camera: cameraName,
            outputShapes: debugShapes,
            originalSize: `${originalWidth}x${originalHeight}`,
            letterbox: { scale: scale.toFixed(4), padX: padX.toFixed(1), padY: padY.toFixed(1) }
        }, "🔫 WEAPON: RT-DETR Inference Output");

        const result = processOutput(outputs, originalWidth, originalHeight, scale, padX, padY);

        log.info({
            camera: cameraName,
            detected: result.detected,
            boxCount: result.boxes.length,
        }, "🔫 WEAPON: Detection complete");

        return {
            isWeapon: result.detected,
            confidence: result.boxes.length > 0 ? result.boxes[0][5] : 0,
            boxes: result.boxes,
            frameBuffer: jpegBuffer,
        };
    } catch (error) {
        log.error({
            camera: cameraName,
            error: error.message,
        }, "🔫 WEAPON: Detection failed");

        return {
            isWeapon: false,
            confidence: 0,
            boxes: [],
            error: error.message,
            frameBuffer: null,
        };
    }
}
