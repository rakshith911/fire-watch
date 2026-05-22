import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { cfg } from "../config.js";
import { makeLogger } from "../logger.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = makeLogger("local-detector");
const FRAME_READ_RETRIES = 3;
const FRAME_READ_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------------
// 🎯 ONNX Session Management (Singleton)
// -------------------------------------------------------------------
const sessionPromises = new Map();

function getSession(modelFile = "best.onnx") {
  if (!sessionPromises.has(modelFile)) {
    let modelPath;
    if (process.env.MODELS_DIR_OVERRIDE) {
      modelPath = path.join(process.env.MODELS_DIR_OVERRIDE, modelFile);
    } else {
      modelPath = path.resolve(__dirname, "../../models", modelFile);
    }
    log.info({ modelPath, modelFile }, "Loading Fire ONNX model...");

    const sessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    }).then((session) => {
      log.info({ modelFile }, "✅ Fire ONNX session ready");
      log.info({ inputNames: session.inputNames, outputNames: session.outputNames }, "Model Metadata");
      return session;
    }).catch((err) => {
      log.error({ error: err.message, modelFile }, "❌ Failed to load Fire ONNX model");
      sessionPromises.delete(modelFile);
      throw err;
    });
    sessionPromises.set(modelFile, sessionPromise);
  }
  return sessionPromises.get(modelFile);
}

// -------------------------------------------------------------------
// 🖼️ Frame Extraction via ffmpeg
// -------------------------------------------------------------------
function grabFrameOnceAttempt(srcUrl) {
  return new Promise((resolve, reject) => {
    const isRtsp = srcUrl.startsWith("rtsp://");
    const args = ["-y"];

    if (isRtsp) {
      args.push(
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        "-rtsp_transport", "tcp",
        "-rtsp_flags", "prefer_tcp",
        "-use_wallclock_as_timestamps", "1",
        "-timeout", "5000000",
        "-analyzeduration", "5000000",
        "-probesize", "5000000"
      );
    }

    args.push("-i", srcUrl, "-an", "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", "-f", "image2", "-");

    log.debug({ ffmpegPath: cfg.ffmpeg, args }, "Spawning ffmpeg");

    const ff = spawn(cfg.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";

    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("error", (spawnError) => {
      if (spawnError.code === "ENOENT") {
        log.error({ ffmpegPath: cfg.ffmpeg }, "❌ FFMPEG NOT FOUND - Detection cannot work without ffmpeg");
        reject(new Error(`ffmpeg not found at: ${cfg.ffmpeg}. Please ensure ffmpeg is installed.`));
      } else {
        reject(spawnError);
      }
    });
    ff.on("close", (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${err.split("\n").slice(-3).join(" ")}`));
    });
  });
}

export async function grabFrameOnce(srcUrl, retries = FRAME_READ_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await grabFrameOnceAttempt(srcUrl);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        log.warn({ attempt, retries, error: error.message }, "Single-frame read failed; retrying");
        await sleep(FRAME_READ_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Grab multiple frames from a SINGLE ffmpeg connection.
 * This avoids the keyframe/GOP problem where separate connections
 * always start at the same I-frame, producing identical images.
 * Uses fps filter to space frames ~1s apart within a short capture window.
 */
function grabMultipleFramesAttempt(srcUrl, numFrames = 3) {
  return new Promise((resolve, reject) => {
    const isRtsp = srcUrl.startsWith("rtsp://");
    const args = ["-y"];

    if (isRtsp) {
      args.push(
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        "-rtsp_transport", "tcp",
        "-rtsp_flags", "prefer_tcp",
        "-timeout", "5000000",
        "-analyzeduration", "5000000",
        "-probesize", "5000000"
      );
    }

    // Read stream for a few seconds, output 1 frame per second
    const duration = numFrames + 1; // e.g. 4 seconds for 3 frames
    args.push(
      "-i", srcUrl,
      "-an",
      "-map", "0:v:0",
      "-t", String(duration),
      "-vf", `fps=1`,
      "-frames:v", String(numFrames),
      "-q:v", "2",
      "-f", "image2pipe",
      "pipe:1"
    );

    log.debug({ ffmpegPath: cfg.ffmpeg, numFrames, duration }, "Spawning ffmpeg (multi-frame)");

    const ff = spawn(cfg.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });

    // JPEG frames are concatenated in stdout - split by JPEG markers
    const allData = [];
    let err = "";

    ff.stdout.on("data", (d) => allData.push(d));
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("error", (spawnError) => {
      if (spawnError.code === "ENOENT") {
        log.error({ ffmpegPath: cfg.ffmpeg }, "❌ FFMPEG NOT FOUND");
        reject(new Error(`ffmpeg not found at: ${cfg.ffmpeg}. Please ensure ffmpeg is installed.`));
      } else {
        reject(spawnError);
      }
    });
    ff.on("close", (code) => {
      if (code !== 0 && allData.length === 0) {
        reject(new Error(`ffmpeg exit ${code}: ${err.split("\n").slice(-3).join(" ")}`));
        return;
      }

      const fullBuffer = Buffer.concat(allData);
      // Split concatenated JPEGs by SOI marker (FF D8)
      const frames = [];
      let start = 0;
      for (let i = 0; i < fullBuffer.length - 1; i++) {
        if (fullBuffer[i] === 0xFF && fullBuffer[i + 1] === 0xD8 && i > start) {
          frames.push(fullBuffer.subarray(start, i));
          start = i;
        }
      }
      if (start < fullBuffer.length) {
        frames.push(fullBuffer.subarray(start));
      }

      // Filter out any tiny/corrupt fragments
      const validFrames = frames.filter(f => f.length > 1000);

      if (validFrames.length === 0) {
        reject(new Error(`ffmpeg produced no valid JPEG frames: ${err.split("\n").slice(-3).join(" ")}`));
        return;
      }

      log.info({ requested: numFrames, extracted: validFrames.length }, "📸 Multi-frame extraction complete");
      resolve(validFrames);
    });
  });
}

export async function grabMultipleFrames(srcUrl, numFrames = 3, retries = FRAME_READ_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await grabMultipleFramesAttempt(srcUrl, numFrames);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        log.warn({ attempt, retries, error: error.message }, "Multi-frame read failed; retrying");
        await sleep(FRAME_READ_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

// -------------------------------------------------------------------
// 🔄 Image Preprocessing (Canvas → Sharp)
// -------------------------------------------------------------------
async function prepareInput(jpegBuffer, modelInputSize = 640) {
  try {
    // Get original dimensions for letterbox calculation
    const metadata = await sharp(jpegBuffer).metadata();
    const origW = metadata.width;
    const origH = metadata.height;

    // Calculate letterbox parameters
    const scale = Math.min(modelInputSize / origW, modelInputSize / origH);
    const newW = Math.round(origW * scale);
    const newH = Math.round(origH * scale);
    const padX = (modelInputSize - newW) / 2;
    const padY = (modelInputSize - newH) / 2;

    const { data, info } = await sharp(jpegBuffer)
      .resize(modelInputSize, modelInputSize, {
        fit: "contain",
        background: { r: 114, g: 114, b: 114 }
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const N = modelInputSize * modelInputSize;
    const arr = new Float32Array(N * 3);

    // Standard normalization (0-1)
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
      scale,
      padX,
      padY
    };
  } catch (e) {
    log.error({ error: e.message }, "Failed to preprocess image");
    throw e;
  }
}

// -------------------------------------------------------------------
// 🧠 ONNX Inference
// -------------------------------------------------------------------
async function runInference(inputTensor, modelFile = "best.onnx") {
  try {
    const session = await getSession(modelFile);

    // RT-DETR usually expects [1, 3, 640, 640]
    const tensor = new ort.Tensor(
      "float32",
      inputTensor,
      [1, 3, 640, 640]
    );

    // Run inference
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
// 📊 Process RT-DETR Output
// -------------------------------------------------------------------
function processOutput(outputs, originalWidth, originalHeight, scale, padX, padY) {
  let boxes = [];
  let fireCount = 0;
  let smokeCount = 0;
  let totalFireArea = 0;

  // Debug output keys
  const keys = Object.keys(outputs);

  let rawBoxes = null;
  let rawScores = null;
  let combined = null;

  if (keys.includes("boxes") && keys.includes("scores")) {
    rawBoxes = outputs["boxes"].data;
    rawScores = outputs["scores"].data;
  } else if (keys.length === 1) {
    combined = outputs[keys[0]].data;
  } else {
    log.warn({ keys }, "Unknown output format, trying to parse...");
  }

  const numQueries = 300; // Standard RT-DETR query count
  const numClasses = 3; // Fire, Other, Smoke (per model training spec)
  const fireProbThreshold = 0.5; // Confidence threshold (0.5 recommended for production)
  const smokeProbThreshold = 0.35; // Smoke scores lower in this model; logs show typical smoke confidence around 0.27-0.43

  // Helper to get box coordinates
  const getBox = (i) => {
    if (rawBoxes) {
      // rawBoxes is [1, 300, 4] flattened
      const offset = i * 4;
      return [
        rawBoxes[offset],
        rawBoxes[offset + 1],
        rawBoxes[offset + 2],
        rawBoxes[offset + 3]
      ];
    } else if (combined) {
      // combined is [1, 300, 4+classes] flattened
      // stride = 4 + numClasses
      const stride = 4 + numClasses;
      const offset = i * stride;
      return [
        combined[offset],
        combined[offset + 1],
        combined[offset + 2],
        combined[offset + 3]
      ];
    }
    return [0, 0, 0, 0];
  };

  // Helper to get max score and class
  const getScore = (i) => {
    let maxScore = 0;
    let maxClass = -1;

    if (rawScores) {
      // rawScores is [1, 300, numClasses] flattened
      const offset = i * numClasses;
      for (let c = 0; c < numClasses; c++) {
        const s = rawScores[offset + c];
        if (s > maxScore) {
          maxScore = s;
          maxClass = c;
        }
      }
    } else if (combined) {
      // combined is [1, 300, 4+classes] flattened
      const stride = 4 + numClasses;
      const offset = i * stride + 4; // Skip 4 box coords
      for (let c = 0; c < numClasses; c++) {
        const s = combined[offset + c];
        if (s > maxScore) {
          maxScore = s;
          maxClass = c;
        }
      }
    }
    return { maxScore, maxClass };
  };

  // DEBUG: Log top 5 scores regardless of threshold
  const allScores = [];
  for (let i = 0; i < numQueries; i++) {
    const { maxScore, maxClass } = getScore(i);
    allScores.push({ score: maxScore, class: maxClass });
  }
  allScores.sort((a, b) => b.score - a.score);
  // Class order per model spec: fire=0, other=1, smoke=2
  const CLASS_NAMES = ["Fire", "Other", "Smoke"];

  const top5 = allScores.slice(0, 5).map(s => ({
    score: s.score.toFixed(4),
    label: CLASS_NAMES[s.class] || "Unknown"
  }));
  log.info({ top5 }, "🔥 LOCAL: Top 5 Raw Scores");

  for (let i = 0; i < numQueries; i++) {
    const { maxScore, maxClass } = getScore(i);

    if (maxClass === 1) continue; // Skip "Other" class (index 1) - only care about Fire/Smoke
    const minScore = maxClass === 2 ? smokeProbThreshold : fireProbThreshold;
    if (maxScore < minScore) continue;

    const [cx, cy, w, h] = getBox(i);

    // Convert cx, cy, w, h (normalized 0-1) to corner format in 640x640 space
    const x1_640 = (cx - w / 2) * 640;
    const y1_640 = (cy - h / 2) * 640;
    const x2_640 = (cx + w / 2) * 640;
    const y2_640 = (cy + h / 2) * 640;

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

    const label = CLASS_NAMES[maxClass] || "Unknown";

    // Store in format expected by detectionQueue: [x1, y1, x2, y2, label, confidence]
    boxes.push([x1_clamped, y1_clamped, x2_clamped, y2_clamped, label, maxScore]);

    const area = Math.max(0, x2_clamped - x1_clamped) * Math.max(0, y2_clamped - y1_clamped);
    if (label === "Fire") {
      fireCount++;
      totalFireArea += area;
    }
    if (label === "Smoke") {
      smokeCount++;
      totalFireArea += area;
    }
  }

  // Sort by confidence
  boxes.sort((a, b) => b[5] - a[5]);

  const detected = fireCount > 0 || smokeCount > 0;

  return {
    boxes,
    detected,
    fireCount,
    smokeCount,
    totalFireArea,
  };
}

// -------------------------------------------------------------------
// 🔥 Main Detection Function
// -------------------------------------------------------------------
export async function detectFire(cameraUrl, cameraName, options = {}) {
  try {
    const modelFile = options.modelFile || "best.onnx";
    const jpegBuffer = await grabFrameOnce(cameraUrl);
    const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer, 640);
    const outputs = await runInference(tensor, modelFile);

    // Log output shape for debugging
    const debugShapes = {};
    for (const key in outputs) {
      debugShapes[key] = outputs[key].dims;
    }
    log.info({
      camera: cameraName,
      modelFile,
      outputShapes: debugShapes,
      originalSize: `${originalWidth}x${originalHeight}`,
      letterbox: { scale: scale.toFixed(4), padX: padX.toFixed(1), padY: padY.toFixed(1) }
    }, "🔥 LOCAL: RT-DETR Inference Output");

    const result = processOutput(outputs, originalWidth, originalHeight, scale, padX, padY);

    log.info({
      camera: cameraName,
      detected: result.detected,
      fireCount: result.fireCount,
      smokeCount: result.smokeCount,
      boxCount: result.boxes.length,
    }, "🔥 LOCAL: Detection complete");

    return {
      isFire: result.detected,
      confidence: result.boxes.length > 0 ? result.boxes[0][5] : 0,
      boxes: result.boxes,
      fireCount: result.fireCount,
      smokeCount: result.smokeCount,
      frameBuffer: jpegBuffer,
    };
  } catch (error) {
    log.error({
      camera: cameraName,
      error: error.message,
    }, "🔥 LOCAL: Detection failed");

    return {
      isFire: false,
      confidence: 0,
      boxes: [],
      error: error.message,
      frameBuffer: null,
    };
  }
}

/**
 * Detect fire across multiple frames from a SINGLE ffmpeg connection.
 * Solves the keyframe/GOP problem where cameras with long GOP intervals
 * return the same frame on every separate connection.
 */
export async function detectFireMultiFrame(cameraUrl, cameraName, numFrames = 3, options = {}) {
  try {
    const modelFile = options.modelFile || "best.onnx";
    const jpegBuffers = await grabMultipleFrames(cameraUrl, numFrames);

    const results = [];
    for (let i = 0; i < jpegBuffers.length; i++) {
      const jpegBuffer = jpegBuffers[i];
      const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer, 640);
      const outputs = await runInference(tensor, modelFile);
      const result = processOutput(outputs, originalWidth, originalHeight, scale, padX, padY);

      log.info({
        camera: cameraName,
        modelFile,
        frame: `${i + 1}/${jpegBuffers.length}`,
        jpegSize: `${(jpegBuffer.length / 1024).toFixed(1)}KB`,
        resolution: `${originalWidth}x${originalHeight}`,
        detected: result.detected,
        fireCount: result.fireCount,
        smokeCount: result.smokeCount,
        topScore: result.boxes.length > 0 ? result.boxes[0][5].toFixed(4) : "none",
      }, `🔥 LOCAL: Multi-frame ${i + 1} inference result`);

      results.push({
        isFire: result.detected,
        confidence: result.boxes.length > 0 ? result.boxes[0][5] : 0,
        boxes: result.boxes,
        fireCount: result.fireCount,
        smokeCount: result.smokeCount,
        frameBuffer: jpegBuffer,
      });
    }

    log.info({
      camera: cameraName,
      framesExtracted: jpegBuffers.length,
      framesWithFire: results.filter(r => r.isFire).length,
    }, "🔥 LOCAL: Multi-frame detection complete");

    return results;
  } catch (error) {
    log.error({ camera: cameraName, error: error.message }, "🔥 LOCAL: Multi-frame detection failed");
    return [{
      isFire: false,
      confidence: 0,
      boxes: [],
      error: error.message,
      transientReadError: true,
      frameBuffer: null,
    }];
  }
}

/**
 * Detect fire across multiple frames with multiple fire models using the same
 * grabbed frames. A frame is fire-positive when any model reports fire/smoke.
 */
export async function detectFireMultiModelFrame(cameraUrl, cameraName, numFrames = 3, modelFiles = ["best.onnx"]) {
  try {
    const jpegBuffers = await grabMultipleFrames(cameraUrl, numFrames);
    const results = [];

    for (let i = 0; i < jpegBuffers.length; i++) {
      const jpegBuffer = jpegBuffers[i];
      const { tensor, originalWidth, originalHeight, scale, padX, padY } = await prepareInput(jpegBuffer, 640);
      const modelResults = [];

      for (const modelFile of modelFiles) {
        const outputs = await runInference(tensor, modelFile);
        const result = processOutput(outputs, originalWidth, originalHeight, scale, padX, padY);
        modelResults.push({ modelFile, result });

        log.info({
          camera: cameraName,
          modelFile,
          frame: `${i + 1}/${jpegBuffers.length}`,
          jpegSize: `${(jpegBuffer.length / 1024).toFixed(1)}KB`,
          resolution: `${originalWidth}x${originalHeight}`,
          detected: result.detected,
          fireCount: result.fireCount,
          smokeCount: result.smokeCount,
          topScore: result.boxes.length > 0 ? result.boxes[0][5].toFixed(4) : "none",
        }, `🔥 LOCAL: Multi-model frame ${i + 1} inference result`);
      }

      const boxes = modelResults
        .flatMap(({ modelFile, result }) =>
          result.boxes.map((box) => [...box.slice(0, 6), modelFile])
        )
        .sort((a, b) => (b[5] || 0) - (a[5] || 0));

      results.push({
        isFire: boxes.length > 0,
        confidence: boxes.length > 0 ? boxes[0][5] : 0,
        boxes,
        fireCount: modelResults.reduce((sum, r) => sum + r.result.fireCount, 0),
        smokeCount: modelResults.reduce((sum, r) => sum + r.result.smokeCount, 0),
        frameBuffer: jpegBuffer,
        modelFiles,
      });
    }

    log.info({
      camera: cameraName,
      modelFiles,
      framesExtracted: jpegBuffers.length,
      framesWithFire: results.filter(r => r.isFire).length,
    }, "🔥 LOCAL: Multi-model detection complete");

    return results;
  } catch (error) {
    log.error({ camera: cameraName, modelFiles, error: error.message }, "🔥 LOCAL: Multi-model detection failed");
    return [{
      isFire: false,
      confidence: 0,
      boxes: [],
      error: error.message,
      transientReadError: true,
      frameBuffer: null,
    }];
  }
}

// -------------------------------------------------------------------
// 🎥 Build Camera Input URL
// -------------------------------------------------------------------
export function buildCameraUrl(cam) {
  // ✅ PRIORITY 1: RTSP camera with IP address (YOUR REAL CAMERA)
  if (cam.ip && cam.ip.trim() !== '') {
    const protocol = "rtsp://";
    const auth = cam.username && cam.password
      ? `${encodeURIComponent(cam.username)}:${encodeURIComponent(cam.password)}@`
      : "";
    const addr = cam.port ? `${cam.ip}:${cam.port}` : cam.ip;
    const path = cam.streamPath || "/live";
    const url = `${protocol}${auth}${addr}${path}`;

    log.debug({ cameraId: cam.id, url: url.replace(/:([^:@]+)@/, ":****@") }, "Built RTSP URL for detection");
    return url;
  }

  // ✅ PRIORITY 2: HLS stream URL
  if (cam.hlsUrl && cam.hlsUrl.trim() !== '') {
    log.debug({ cameraId: cam.id, url: cam.hlsUrl }, "Using HLS URL for detection");
    return cam.hlsUrl;
  }

  // ❌ Don't use MediaMTX as source - that's the destination!
  const errorMsg = `Cannot build camera URL for ${cam.name}. ` +
    `Camera needs either: (1) ip+port for RTSP, or (2) hlsUrl for HLS. ` +
    `Current: ip=${cam.ip || 'null'}, hlsUrl=${cam.hlsUrl || 'null'}`;

  log.error({ cameraId: cam.id, name: cam.name }, errorMsg);
  throw new Error(errorMsg);
}
