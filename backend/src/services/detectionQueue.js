import pino from "pino";
import { detectFire, detectFireMultiFrame, buildCameraUrl, grabFrameOnce } from "./localDetector.js";
import { detectFireCloud } from "./cloudDetector.js";
import { detectWeapon, detectWeaponMultiFrame } from "./localWeaponDetector.js";
import { detectFireMultiFrameYolo, detectWeaponYolo } from "./localYoloDetector.js";
import livenessValidator from "./livenessValidator.js";
import {
  startCameraStream,
  stopCameraStream,
  isStreamActive,
} from "./streamManager.js";
import { sanitizePathName } from "./mediamtxConfigGenerator.js";
import { sendFireAlert } from "./snsService.js";
import { uploadFireFrame } from "./s3Service.js";

const log = pino({ name: "detection-queue" });

// -------------------------------------------------------------------
// 📋 Configuration Constants
// -------------------------------------------------------------------
// -------------------------------------------------------------------
// 📋 Queue State
// -------------------------------------------------------------------
let cameraQueue = [];
let currentIndex = 0;
let isRunning = false;
let loopInterval = null;
let loopGeneration = 0;
let broadcastFireDetection = null;
let currentUserId = null;

// Track detection state per camera
// id -> { isFire, lastChecked, consecutiveStatic }
const cameraStates = new Map();

// Track cameras being watched by frontend YOLO
// cameraId -> lastTimestamp (Date.now())
const frontendWatchedCameras = new Map();

// Alert cooldown: prevent repeated SNS alerts for the same camera
// cameraId -> lastAlertTimestamp (Date.now())
const lastAlertSent = new Map();
const ALERT_COOLDOWN_MS = 10 * 1000; // 10 seconds between alerts per camera

function normalizeAiType(aiType = "FIRE") {
  const upper = aiType.toUpperCase();
  if (upper === "FIRE_SMALL") return "FIRE_SMALL";
  if (upper === "FIRE_YOLO") return "FIRE_YOLO";
  if (upper === "FIRE_DETECTRON") return "FIRE";
  if (upper === "WEAPON_YOLO") return "WEAPON_YOLO";
  if (upper === "WEAPON_DETECTRON") return "WEAPON";
  if (upper === "BOTH_DETECTRON") return "BOTH";
  return upper;
}

function fireModelForAiType(aiType = "FIRE") {
  const upper = aiType.toUpperCase();
  if (upper === "FIRE_SMALL") return "best_s.onnx";
  if (upper === "FIRE_YOLO") return "yolov11n_bestFire.onnx";
  return "best.onnx";
}

function pickBestFrame(frames = []) {
  return frames.reduce((best, frame) => {
    const confidence = frame?.boxes?.[0]?.[5] || 0;
    const bestConfidence = best?.boxes?.[0]?.[5] || 0;
    return confidence > bestConfidence ? frame : best;
  }, frames[0] || null);
}

// -------------------------------------------------------------------
// 🔧 Configuration - Multi-Frame Detection (Drone Method)
// -------------------------------------------------------------------
const FRAMES_PER_CHECK = 3; // Extract 3 frames per camera turn
const BOX_IOU_THRESHOLD = 0.90; // Similar boxes at/above this must pass pixel motion before we call it real fire.
const FIRE_MOTION_RESCUE_THRESHOLD = 0.02;
const STATIC_THRESHOLD = 2; // currently not used to short-circuit, but we track it
const MIN_FRAME_INTERVAL = 500; // Minimum 500ms between frames
const DEMO_CONTINUOUS_CAMERA_INTERVAL = 3000; // Sampling rate is ignored in demo-style queue mode.
const DEMO_CONTINUOUS_NEXT_DELAY = 1000;

// -------------------------------------------------------------------
// 🧮 Dynamic Sampling Rate Calculation
// -------------------------------------------------------------------

/**
 * Calculate the interval between frame extractions for a camera.
 * Example:
 *   Camera gets 10s, 3 frames → 3.33s per frame
 */
function calculateFrameInterval(cameraInterval) {
  const interval = Math.floor(cameraInterval / FRAMES_PER_CHECK);
  return Math.max(MIN_FRAME_INTERVAL, interval);
}

// -------------------------------------------------------------------
// 📊 IoU Calculation (Drone Method)
// -------------------------------------------------------------------

function computeIoU(box1, box2) {
  const [x1, y1, x2, y2] = box1;
  const [x1b, y1b, x2b, y2b] = box2;

  // Intersection
  const xi1 = Math.max(x1, x1b);
  const yi1 = Math.max(y1, y1b);
  const xi2 = Math.min(x2, x2b);
  const yi2 = Math.min(y2, y2b);

  const inter = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);

  // Union
  const area1 = (x2 - x1) * (y2 - y1);
  const area2 = (x2b - x1b) * (y2b - y1b);
  const union = area1 + area2 - inter;

  return union > 0 ? inter / union : 0;
}

/**
 * Analyze multiple frames using IoU method.
 * Returns whether detection is static (false positive) or moving (real).
 */
function analyzeBoxes(frames) {
  if (frames.length < 2) {
    return {
      isStatic: false,
      reason: "insufficient_frames",
      framesAnalyzed: frames.length,
    };
  }

  // Get the largest box from each frame
  const boxes = frames
    .map((frame) => {
      if (!frame.boxes || frame.boxes.length === 0) {
        return null;
      }
      return frame.boxes[0]; // Highest confidence box
    })
    .filter((box) => box !== null);

  if (boxes.length < 2) {
    return {
      isStatic: false,
      reason: "insufficient_boxes",
      framesAnalyzed: frames.length,
    };
  }

  // Compare consecutive pairs
  const ious = [];
  for (let i = 1; i < boxes.length; i++) {
    const iou = computeIoU(boxes[i - 1], boxes[i]);
    ious.push(iou);
  }

  const avgIoU = ious.reduce((sum, iou) => sum + iou, 0) / ious.length;
  const isStatic = avgIoU >= BOX_IOU_THRESHOLD;

  return {
    isStatic,
    avgIoU: avgIoU.toFixed(3),
    ious: ious.map((iou) => iou.toFixed(3)),
    reason: isStatic ? "static_box" : "moving_box",
    framesAnalyzed: frames.length,
    boxesCompared: boxes.length,
  };
}

// -------------------------------------------------------------------
// 🎬 Extract Multiple Frames from Camera (Local / Smart Source)
// -------------------------------------------------------------------
async function extractMultipleFramesLocal(camera, currentFrameInterval) {
  const frames = [];
  const frameInterval = Math.floor(currentFrameInterval / FRAMES_PER_CHECK);

  // Use MediaMTX's local RTSP path so detection and the preview share one
  // upstream camera connection instead of repeatedly opening direct RTSP.
  const directCameraUrl = buildCameraUrl(camera);
  let cameraUrl = directCameraUrl;
  let sourceLog = "DIRECT_RTSP";

  try {
    const streamName = sanitizePathName(camera.streamName || camera.name);
    if (streamName) {
      cameraUrl = `rtsp://127.0.0.1:8554/${streamName}`;
      sourceLog = "LOCAL_MEDIAMTX_PROXY";
    }
  } catch (err) {
    log.warn({ err: err.message }, "Failed to build MediaMTX proxy URL, falling back to direct RTSP");
  }

  // aiType determines WHAT to detect (FIRE, WEAPON, BOTH)
  const aiType = (camera.aiType || "FIRE").toUpperCase();
  const normalizedAiType = normalizeAiType(aiType);
  const fireModelFile = fireModelForAiType(aiType);

  log.info(
    {
      id: camera.id,
      name: camera.name,
      frameCount: FRAMES_PER_CHECK,
      intervalMs: frameInterval,
      aiType: normalizedAiType,
      requestedAiType: aiType,
      fireModelFile,
      source: sourceLog,
      url: cameraUrl,
      directUrl: directCameraUrl,
    },
    `📸 Extracting ${FRAMES_PER_CHECK} frames for LOCAL ${aiType} analysis...`
  );

  // ---------------------------------------------------------------
  // 🔥 FIRE or BOTH: Use single-connection multi-frame extraction
  // This fixes the keyframe/GOP problem where cameras with long GOP
  // intervals return the same I-frame on every separate connection,
  // causing false "static" detections.
  // ---------------------------------------------------------------
  if (normalizedAiType === "FIRE" || normalizedAiType === "FIRE_SMALL" || normalizedAiType === "FIRE_YOLO" || normalizedAiType === "BOTH") {
    try {
      const fireResults = normalizedAiType === "FIRE_YOLO"
        ? await detectFireMultiFrameYolo(cameraUrl, camera.name, FRAMES_PER_CHECK)
        : await detectFireMultiFrame(cameraUrl, camera.name, FRAMES_PER_CHECK, {
            modelFile: fireModelFile,
          });

      for (let i = 0; i < fireResults.length; i++) {
        const result = fireResults[i];
        if (result.transientReadError || result.error) {
          frames._detectionReadError = result.error || "frame_read_failed";
          log.warn(
            { id: camera.id, name: camera.name, frameNumber: i + 1, error: frames._detectionReadError },
            "⚠️ FIRE frame read failed; preserving previous detection state"
          );
          continue;
        }
        if (result.isFire) {
          frames.push({
            timestamp: new Date().toISOString(),
            boxes: result.boxes.map((b) => [b[0], b[1], b[2], b[3], b[4], b[5]]),
            fireCount: result.fireCount || 0,
            smokeCount: result.smokeCount || 0,
            confidence: result.confidence,
            frameBuffer: result.frameBuffer,
            aiType: "FIRE"
          });
          log.info(
            { id: camera.id, name: camera.name, frameNumber: i + 1, boxes: result.boxes.length },
            `🔥 ${normalizedAiType === "FIRE_YOLO" ? "YOLO" : "LOCAL"} Frame ${i + 1}/${fireResults.length}: Fire detected`
          );
        } else {
          log.info(
            { id: camera.id, name: camera.name, frameNumber: i + 1 },
            `✅ ${normalizedAiType === "FIRE_YOLO" ? "YOLO" : "LOCAL"} Frame ${i + 1}/${fireResults.length}: No fire`
          );
        }
      }
    } catch (error) {
      log.error(
        { id: camera.id, name: camera.name, error: error.message },
        `❌ FIRE multi-frame detection error`
      );
    }
  }

  // ---------------------------------------------------------------
  // 🔫 WEAPON or BOTH: Weapon detection (separate connections OK -
  // weapon detection doesn't rely on motion between frames as much)
  // ---------------------------------------------------------------
  if (normalizedAiType === "WEAPON" || normalizedAiType === "WEAPON_YOLO" || normalizedAiType === "BOTH") {
    const weaponResults = normalizedAiType === "WEAPON_YOLO"
      ? null
      : await detectWeaponMultiFrame(cameraUrl, camera.name, FRAMES_PER_CHECK);

    for (let i = 0; i < FRAMES_PER_CHECK; i++) {
      try {
        const result = weaponResults
          ? weaponResults[i] || { isWeapon: false, boxes: [] }
          : normalizedAiType === "WEAPON_YOLO"
          ? await detectWeaponYolo(cameraUrl, camera.name)
          : await detectWeapon(cameraUrl, camera.name);
        if (result.transientReadError || result.error) {
          frames._detectionReadError = result.error || "weapon_frame_read_failed";
          log.warn(
            { id: camera.id, name: camera.name, frameNumber: i + 1, error: frames._detectionReadError },
            "⚠️ WEAPON frame read failed; preserving previous detection state"
          );
          break;
        }
        if (result.isWeapon) {
          frames.push({
            timestamp: new Date().toISOString(),
            boxes: result.boxes.map((b) => [b[0], b[1], b[2], b[3], b[4], b[5]]),
            fireCount: 0,
            smokeCount: 0,
            confidence: result.confidence,
            frameBuffer: result.frameBuffer,
            aiType: "WEAPON"
          });
          log.info(
            { id: camera.id, name: camera.name, frameNumber: i + 1, boxes: result.boxes.length },
            `🔫 ${normalizedAiType === "WEAPON_YOLO" ? "WEAPON YOLO" : "WEAPON"} Frame ${i + 1}/${FRAMES_PER_CHECK}: Weapon detected`
          );
        } else {
          log.info(
            { id: camera.id, name: camera.name, frameNumber: i + 1 },
            `✅ ${normalizedAiType === "WEAPON_YOLO" ? "WEAPON YOLO" : "WEAPON"} Frame ${i + 1}/${FRAMES_PER_CHECK}: No weapon`
          );
        }
        if (!weaponResults && i < FRAMES_PER_CHECK - 1) {
          await new Promise((r) => setTimeout(r, frameInterval));
        }
      } catch (error) {
        log.error(
          { id: camera.id, name: camera.name, error: error.message },
          `❌ WEAPON Detection error - skipping frame`
        );
      }
    }
  }

  return frames;
}

// -------------------------------------------------------------------
// 🌥️ CLOUD Detection Wrapper
// -------------------------------------------------------------------
async function extractMultipleFramesCloud(camera) {
  const cameraUrl = buildCameraUrl(camera);

  log.info(
    {
      id: camera.id,
      name: camera.name,
      frameCount: FRAMES_PER_CHECK,
    },
    `📸 Running CLOUD detection (multi-frame with IoU in cloud)...`
  );

  try {
    const result = await detectFireCloud(cameraUrl, camera.name);

    if (!result || !result.isFire) {
      log.info(
        { id: camera.id, name: camera.name, reason: result?.reason },
        "✅ CLOUD: No fire detected"
      );
      return [];
    }

    // Map to a "frame-like" structure so the rest of the code can handle it uniformly
    return [
      {
        timestamp: new Date().toISOString(),
        boxes: [],
        fireCount: 1,
        smokeCount: 0,
        confidence: result.confidence ?? 1.0,
        frameBuffer: null,
        cloudResult: result,
        detectionType: "CLOUD"
      },
    ];
  } catch (error) {
    log.error(
      {
        id: camera.id,
        name: camera.name,
        error: error.message,
      },
      "❌ CLOUD detection failed"
    );
    return [];
  }
}

// -------------------------------------------------------------------
// 📡 Handle Frontend Detection Events
// -------------------------------------------------------------------
export async function handleFrontendDetection(userId, msg) {
  const { cameraId, cameraName, boxes, timestamp } = msg;

  // Mark this camera as frontend-watched
  frontendWatchedCameras.set(cameraId, Date.now());

  // Log only - do NOT alert, do NOT upload to S3, do NOT stop backend
  log.info({
    userId,
    cameraId,
    cameraName,
    boxCount: boxes?.length,
    timestamp,
  }, "📡 Frontend detection received (logging only)");

  // Broadcast fire status to all WebSocket clients (for UI sync)
  if (broadcastFireDetection && boxes && boxes.length > 0) {
    broadcastFireDetection(userId, cameraId, cameraName, true, {
      boxes: boxes,
      alertType: "Fire", // Frontend YOLO is primarily Fire
      confidence: boxes[0]?.[5] || 0.9,
      source: "frontend-yolo",
    });
  }
}

// -------------------------------------------------------------------
// 🔌 Set Broadcast Function
// -------------------------------------------------------------------
export function setBroadcastFunction(fn) {
  broadcastFireDetection = fn;
  log.info("✅ Broadcast function registered");
}

// -------------------------------------------------------------------
// 🔄 Update Sampling Rate
// -------------------------------------------------------------------
export async function updateSamplingRate(userId) {
  if (!userId || userId !== currentUserId) {
    log.warn(
      { userId, currentUserId },
      "⚠️ Cannot update sampling rate - user mismatch or no active user"
    );
    return;
  }

  log.info(
    { userId },
    "ℹ️ Sampling rate update saved, but ignored by demo-style backend detection queue"
  );
}

// -------------------------------------------------------------------
// ➕ Add Camera to Queue
// -------------------------------------------------------------------
export function addCameraToQueue(camera) {
  const exists = cameraQueue.find((c) => c.id === camera.id);
  if (exists) {
    log.warn({ id: camera.id, name: camera.name }, "Camera already in queue");
    return;
  }

  cameraQueue.push(camera);

  if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= cameraQueue.length) {
    currentIndex = 0;
  }

  // Initialize camera state
  cameraStates.set(camera.id, {
    isFire: false,
    lastChecked: null,
    consecutiveStatic: 0,
  });

  log.info(
    {
      id: camera.id,
      name: camera.name,
      aiType: camera.aiType,        // DEBUG: Show what aiType camera has
      detection: camera.detection,  // DEBUG: Show detection field
      queueSize: cameraQueue.length,
      intervalPerCamera: DEMO_CONTINUOUS_CAMERA_INTERVAL,
      samplingIgnored: true,
    },
    "📹 Camera added to demo-style detection queue"
  );

  if (!isRunning) {
    startQueueLoop();
  }
}

// -------------------------------------------------------------------
// ➖ Remove Camera from Queue
// -------------------------------------------------------------------
export function removeCameraFromQueue(id) {
  const index = cameraQueue.findIndex((c) => c.id === id);

  if (index === -1) {
    log.warn({ id }, "Camera not found in queue");
    return;
  }

  const camera = cameraQueue[index];
  cameraQueue.splice(index, 1);

  // Stop stream if active
  if (isStreamActive(id)) {
    stopCameraStream(camera);
  }

  cameraStates.delete(id);

  log.info(
    {
      id,
      name: camera.name,
      queueSize: cameraQueue.length,
      intervalPerCamera: DEMO_CONTINUOUS_CAMERA_INTERVAL,
      samplingIgnored: true,
    },
    "🗑️ Camera removed from demo-style detection queue"
  );

  if (cameraQueue.length === 0 || !Number.isFinite(currentIndex) || currentIndex >= cameraQueue.length) {
    currentIndex = 0;
  }

  if (cameraQueue.length === 0 && isRunning) {
    stopQueueLoop();
  }
}

// -------------------------------------------------------------------
// ▶️ Start Detection Queue Loop
// -------------------------------------------------------------------
async function startQueueLoop() {
  if (isRunning) {
    log.warn("Detection queue already running");
    return;
  }

  isRunning = true;
  const generation = ++loopGeneration;

  if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= cameraQueue.length) {
    currentIndex = 0;
  }

  const initialInterval = DEMO_CONTINUOUS_CAMERA_INTERVAL;
  const initialFrameInterval = calculateFrameInterval(initialInterval);

  log.info(
    {
      queueSize: cameraQueue.length,
      intervalPerCamera: initialInterval,
      framesPerCheck: FRAMES_PER_CHECK,
      frameInterval: initialFrameInterval,
      iouThreshold: BOX_IOU_THRESHOLD,
      samplingIgnored: true,
    },
    "▶️ Starting demo-style continuous detection queue"
  );

  async function loop() {
    if (!isRunning || generation !== loopGeneration || cameraQueue.length === 0) {
      return;
    }

    const camera = cameraQueue[currentIndex];

    if (!camera) {
      log.warn({ currentIndex }, "No camera at current index");
      currentIndex = 0;
      loopInterval = setTimeout(loop, DEMO_CONTINUOUS_NEXT_DELAY);
      return;
    }

    const state = cameraStates.get(camera.id);

    // SKIP LOGIC REMOVED: Backend detection now runs regardless of frontend state
    // We want the backend to be the source of truth for alerts.

    try {
      const currentCameraInterval = DEMO_CONTINUOUS_CAMERA_INTERVAL;
      const currentFrameInterval = calculateFrameInterval(currentCameraInterval);
      // aiType = WHAT to detect (FIRE, WEAPON, BOTH)
      // detection = HOW to detect for FIRE (LOCAL, CLOUD)
      const rawAiType = (camera.aiType || "FIRE").toUpperCase();
      const aiType = normalizeAiType(rawAiType);
      const detectionMethod = (camera.detection || "LOCAL").toUpperCase();

      // For FIRE, check if using CLOUD or LOCAL method
      // For WEAPON/BOTH, always use local (they don't have cloud endpoints)
      let detectionType;
      if ((aiType === "FIRE" || aiType === "FIRE_SMALL") && detectionMethod === "CLOUD") {
        detectionType = "CLOUD";
      } else if (aiType === "WEAPON" || aiType === "WEAPON_YOLO") {
        detectionType = "WEAPON";
      } else if (aiType === "BOTH") {
        detectionType = "BOTH";
      } else {
        // Default: LOCAL fire detection
        detectionType = "LOCAL";
      }

      log.info(
        {
          id: camera.id,
          name: camera.name,
          aiType: aiType,
          detectionMethod: detectionMethod,
          resolvedType: detectionType,
          position: `${currentIndex + 1}/${cameraQueue.length}`,
          cameraInterval: currentCameraInterval,
          frameInterval: currentFrameInterval,
        },
        `🔍 Starting ${detectionType} detection...`
      );

      // ✅ EXTRACT MULTIPLE FRAMES
      let frames = [];
      if (detectionType === "CLOUD") {
        // Cloud detection - IoU is handled in the cloud endpoint
        frames = await extractMultipleFramesCloud(camera);
      } else {
        // LOCAL, WEAPON, or BOTH
        frames = await extractMultipleFramesLocal(camera, currentFrameInterval);
      }

      state.lastChecked = new Date().toISOString();

      if (frames._detectionReadError) {
        log.warn(
          {
            id: camera.id,
            name: camera.name,
            error: frames._detectionReadError,
            previousState: state.isFire ? "DETECTED" : "CLEAR",
          },
          "⚠️ Detection read failed; skipping this cycle without changing UI/alert state"
        );
        const transientError = new Error(frames._detectionReadError);
        transientError.code = "TRANSIENT_DETECTION_READ_ERROR";
        throw transientError;
      }

      if (frames.length === 0) {
        // No detection
        log.info(
          {
            id: camera.id,
            name: camera.name,
          },
          `✅ ${detectionType}: No detection in any frame`
        );

        // Clear status if transitioning from detection → no detection.
        // Weapon demo flow should auto-hide again once the knife/weapon is gone.
        if (state.isFire && broadcastFireDetection) {
          broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
            reason: detectionType === "WEAPON" ? "weapon_clear" : "clear",
            detectionType,
          });
        }

        state.isFire = false;
        state.consecutiveStatic = 0;
        // Clear alert cooldown so next real detection triggers immediately
        lastAlertSent.delete(camera.id);
      } else {
        // Detection found!
        log.warn(
          {
            id: camera.id,
            name: camera.name,
            framesWithDetection: frames.length,
          },
          `🚨 ${detectionType} detected in ${frames.length}/${FRAMES_PER_CHECK} frames - analyzing IoU...`
        );

        // -------------------------------------------------------------------
        // 🧠 IoU Analysis (Static vs Real Fire)
        // -------------------------------------------------------------------

        let isRealDetection = false;
        let iouAnalysis = null;

        if (detectionType === "CLOUD") {
          // 🌥️ CLOUD: IoU/static detection already handled by cloud endpoint
          const cloudResult = frames[0]?.cloudResult;
          if (cloudResult && cloudResult.isFire) {
            isRealDetection = true;
            iouAnalysis = cloudResult.iouAnalysis || null;
            log.info(
              { reason: cloudResult.reason, confidence: cloudResult.confidence },
              "🌥️ CLOUD: Fire confirmed by cloud endpoint"
            );
          }
        } else if (detectionType === "WEAPON") {
          // 🔫 WEAPON: confirm the object has depth so flat photos/screens are rejected.
          const framesWithBoxes = frames.filter(f => f.boxes && f.boxes.length > 0);

          if (framesWithBoxes.length >= 1) {
            const bestFrame = framesWithBoxes.reduce((best, frame) => {
              const confidence = frame.boxes[0]?.[5] || 0;
              return confidence > (best?.boxes[0]?.[5] || 0) ? frame : best;
            }, framesWithBoxes[0]);
            const bestBox = bestFrame.boxes[0];
            const label = bestBox?.[4] || "Weapon";
            const confidence = bestBox?.[5] || 0;

            log.info({
              framesDetected: framesWithBoxes.length,
              label,
              confidence: confidence.toFixed(3),
            }, "🔫 WEAPON: Running 3D depth check");

            let is3D = false;
            try {
              is3D = await livenessValidator.isWeapon3D(bestFrame.frameBuffer, bestBox);
            } catch (err) {
              log.error({ err: err.message }, "❌ Weapon 3D depth check failed");
            }

            if (is3D) {
              isRealDetection = true;
              log.info({ label, confidence: confidence.toFixed(3) }, "🔫 WEAPON: PASSED — 3D real object");
            } else {
              log.info({ label, confidence: confidence.toFixed(3) }, "🔫 WEAPON: REJECTED — 2D flat object/photo/screen");
            }
          } else {
            log.warn({ framesDetected: framesWithBoxes.length }, "⚠️ WEAPON: No frames with detection");
          }
        } else if (detectionType === "BOTH") {
          // 🔥🔫 BOTH
          const fireFrames = frames.filter(f => f.aiType === "FIRE");
          const weaponFrames = frames.filter(f => f.aiType === "WEAPON");

          if (fireFrames.length >= 2) {
            const fireIou = analyzeBoxes(fireFrames);

            // Check pixel motion if static
            let isFireReal = !fireIou.isStatic;
            if (!isFireReal && fireFrames.length >= 3) {
              const fireBoxes = fireFrames.map(f => f.boxes[0]).filter(b => b);
              if (fireBoxes.length > 0) {
                const pixelMotion = await livenessValidator.isFireMoving(
                  fireFrames.map(f => f.frameBuffer),
                  fireFrames.map(f => f.boxes[0])
                );
                if (pixelMotion > FIRE_MOTION_RESCUE_THRESHOLD) {
                  isFireReal = true;
                  fireIou.reason = "pixel_motion_rescue";
                  log.warn({ pixelMotion }, "🔥 BOTH/FIRE: RESCUED by pixel motion test!");
                }
              }
            }

            if (isFireReal) {
              isRealDetection = true;
              iouAnalysis = fireIou;
              frames._fireConfirmed = true;
              frames._fireConfirmedFrame = pickBestFrame(fireFrames);
              log.info({ ...fireIou }, "🔥 BOTH/FIRE: REAL — confirmed");
            } else {
              log.warn({ ...fireIou }, "⚠️ BOTH/FIRE: REJECTED — static boxes");
            }
          }

          if (weaponFrames.length >= 1) {
            // Dual-Threshold for BOTH mode too
            const WEAK_THRESHOLD = 0.40;
            const STRONG_THRESHOLD = 0.75;

            const weakFrames = weaponFrames.filter(f => f.boxes && f.boxes.length > 0 && f.boxes[0][5] >= WEAK_THRESHOLD);
            const strongFrames = weakFrames.filter(f => f.boxes[0][5] >= STRONG_THRESHOLD);

            if (strongFrames.length >= 1 && weakFrames.length >= 1) {
              // In BOTH mode, we might only catch 1 or 2 frames total because we only grab 3?
              // Actually extractMultipleFramesLocal grabs 3 for fire + 3 for weapon = 6 frames?
              // No, wait. "if (aiType === "BOTH")" -> loop 3 times for weapon, then calls detectFireMultiFrame...
              // It's sequential. So we DO have 3 weapon frames.
              // So we should enforce "weakFrames.length >= 2" ideally, OR just 1 strong + 1 weak?
              // Let's stick to the same logic: Strong >= 1 AND Weak >= 2.

              if (weakFrames.length >= 2) {
                const bestFrame = strongFrames.reduce((best, f) => {
                  const conf = f.boxes[0]?.[5] || 0;
                  return conf > (best?.boxes[0]?.[5] || 0) ? f : best;
                }, strongFrames[0]);

                const bbox = bestFrame.boxes[0];
                const is3D = await livenessValidator.isWeapon3D(bestFrame.frameBuffer, bbox);

                if (is3D) {
                  isRealDetection = true;
                  frames._weaponConfirmed = true;
                  frames._weaponConfirmedFrame = bestFrame;
                  log.info({ label: bbox[4], confidence: bbox[5]?.toFixed(3) },
                    "🔫 BOTH/WEAPON: PASSED — 3D real object");
                } else {
                  log.info("🔫 BOTH/WEAPON: REJECTED — 2D flat object (photo/screen)");
                }
              }
            }
          }
        } else {
          // 🔥 FIRE detection logic
          if (frames.length < 2) {
            iouAnalysis = {
              isStatic: true,
              reason: "insufficient_fire_frames",
              framesAnalyzed: frames.length,
            };
            log.warn(
              { ...iouAnalysis },
              "⚠️ FIRE: REJECTED. Need at least 2 detected frames before treating fire as real"
            );
          } else {
            iouAnalysis = analyzeBoxes(frames);

            if (!iouAnalysis.isStatic) {
              isRealDetection = true;
              log.info({ ...iouAnalysis },
                `🔥 FIRE: REAL — boxes moving (IoU ${iouAnalysis.avgIoU} < ${BOX_IOU_THRESHOLD})`);
            } else {
              log.warn({ ...iouAnalysis },
                `⚠️ FIRE STATIC: Checking pixel motion for rescue...`);

              if (frames.length >= 3) {
                const bestBox = frames[0].boxes[0];
                if (bestBox) {
                  const pixelRatio = await livenessValidator.isFireMoving(
                    frames.map(f => f.frameBuffer),
                    frames.map(f => f.boxes[0])
                  );

                  if (pixelRatio > FIRE_MOTION_RESCUE_THRESHOLD) {
                    isRealDetection = true;
                    iouAnalysis.reason = "pixel_motion_rescue";
                    iouAnalysis.pixelRatio = pixelRatio;
                    log.warn({ pixelRatio }, "🔥 FIRE: RESCUED! Boxes static but pixels are moving (real video/fire)");
                  } else {
                    log.warn({ pixelRatio }, "⚠️ FIRE: REJECTED. Pixel motion too low (photo/poster)");
                  }
                }
              }
            }
          }
        }

        if (isRealDetection) {
          // Determine the specific alert type. Only Knife is considered a weapon here.
          const fireFrame = frames._fireConfirmedFrame || null;
          const weaponFrame = frames._weaponConfirmedFrame || null;
          const lastFrameForLabel = weaponFrame || fireFrame || frames[frames.length - 1];
          const topBoxLabel = lastFrameForLabel?.boxes?.[0]?.[4] || null;
          let alertType;
          if (detectionType === "BOTH") {
            alertType = frames._fireConfirmed ? "Fire" : (topBoxLabel || "Weapon");
          } else if (detectionType === "WEAPON") {
            alertType = topBoxLabel || "Weapon";
          } else {
            alertType = "Fire";
          }

          log.error(
            {
              id: camera.id,
              name: camera.name,
              detectionType,
              alertType
            },
            `🚨 REAL ${alertType} DETECTED - Broadcasting alert`
          );

          state.isFire = true; // Used for UI status (red border)
          state.consecutiveStatic = 0;

          // Pick the frame/boxes that caused the alert. In BOTH mode, combine
          // confirmed fire and knife boxes so one detection type does not hide
          // the other on the overlay.
          const lastFrame = fireFrame || weaponFrame || frames[frames.length - 1];
          const broadcastBoxes = detectionType === "BOTH"
            ? [
                ...(fireFrame?.boxes || []),
                ...(weaponFrame?.boxes || []),
              ]
            : (lastFrame?.boxes || []);

          log.info({
            id: camera.id,
            boxes: broadcastBoxes,
            frameBufferSize: lastFrame.frameBuffer?.length,
          }, "📦 Box coordinates being sent");

          // Broadcast to WebSocket
          if (broadcastFireDetection) {
            broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
              boxes: broadcastBoxes,
              alertType,
              confidence: lastFrame.confidence,
              fireConfirmed: !!frames._fireConfirmed,
              weaponConfirmed: !!frames._weaponConfirmed,
            });
          }

          // Send SNS Alert with Frame (cooldown: max once per 5 minutes per camera)
          if (lastFrame && lastFrame.frameBuffer) {
            const now = Date.now();
            const lastAlert = lastAlertSent.get(camera.id) || 0;
            if (now - lastAlert > ALERT_COOLDOWN_MS) {
              lastAlertSent.set(camera.id, now);
              try {
                const imageUrl = await uploadFireFrame(
                  camera.id,
                  lastFrame.frameBuffer,
                  broadcastBoxes
                );

                await sendFireAlert(
                  camera.userId,
                  camera.id,
                  camera.name,
                  {
                    isFire: true,
                    detectionType: alertType,
                    confidence: lastFrame.confidence,
                    fireCount: lastFrame.fireCount,
                    smokeCount: lastFrame.smokeCount,
                    iouAnalysis,
                  },
                  imageUrl
                );

                log.info(`✅ SNS ${alertType} alert with image sent successfully`);
              } catch (error) {
                log.error(
                  {
                    userId: camera.userId,
                    cameraId: camera.id,
                    error: error.message,
                  },
                  "❌ SNS alert with image failed"
                );
              }
            } else {
              log.info({
                cameraId: camera.id,
                alertType,
                cooldownRemaining: `${((ALERT_COOLDOWN_MS - (now - lastAlert)) / 1000).toFixed(0)}s`
              }, "⏳ SNS alert suppressed — cooldown active");
            }
          }
        } else {
          // Static/liveness failed — not a real detection
          state.consecutiveStatic++;
          if (state.isFire && broadcastFireDetection) {
            broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
              reason: "static_fire",
              detectionType,
              framesWithDetection: frames.length,
            });
          }
          state.isFire = false;
          log.info({
            id: camera.id,
            name: camera.name,
            detectionType,
            framesWithDetection: frames.length,
          }, "🚫 Alert suppressed — liveness/depth check failed");
        }
      }
    } catch (error) {
      log.error(
        {
          id: camera.id,
          name: camera.name,
          error: error.message,
          stack: error.stack?.split('\n').slice(0, 3).join(' | '),
        },
        "❌ Detection error"
      );
    }

    const nextIndex = cameraQueue.length > 0 ? (currentIndex + 1) % cameraQueue.length : 0;

    log.info({
      id: camera.id,
      name: camera.name,
      result: state.isFire ? "🔴 FIRE/WEAPON" : "🟢 CLEAR",
      nextCamera: cameraQueue[nextIndex]?.name,
    }, `━━━ Detection cycle complete for ${camera.name} ━━━`);

    if (!isRunning || generation !== loopGeneration || cameraQueue.length === 0) {
      currentIndex = 0;
      return;
    }

    currentIndex = nextIndex;

    loopInterval = setTimeout(loop, DEMO_CONTINUOUS_NEXT_DELAY);
  }

  loop();
}

// -------------------------------------------------------------------
// ⏸️ Stop Detection Queue Loop
// -------------------------------------------------------------------
function stopQueueLoop() {
  if (!isRunning) {
    return;
  }

  isRunning = false;
  loopGeneration++;

  if (loopInterval) {
    clearTimeout(loopInterval);
    loopInterval = null;
  }

  log.info("⏸️ Detection queue stopped");
}

// -------------------------------------------------------------------
// 📊 Get Queue Status
// -------------------------------------------------------------------
export function getQueueStatus() {
  const fireDetections = {};
  const lastChecked = {};
  const streamingCameras = new Set();

  for (const [id, state] of cameraStates.entries()) {
    fireDetections[id] = state.isFire;
    lastChecked[id] = state.lastChecked;

    if (state.isFire) {
      streamingCameras.add(id);
    }
  }

  return {
    isRunning,
    cameras: cameraQueue,
    currentIndex,
    queueSize: cameraQueue.length,
    fireDetections,
    lastChecked,
    streamingCameras,
  };
}

// -------------------------------------------------------------------
// 🚀 Start Queue with Initial Cameras
// -------------------------------------------------------------------
export async function startDetectionQueue(cameras) {
  if (cameras.length > 0 && cameras[0].userId) {
    currentUserId = cameras[0].userId;

    // Demo behavior: samplingRate remains a saved user setting, but backend
    // detection cycles continuously instead of pacing by that setting.
    log.info(
      { userId: currentUserId },
      "ℹ️ Sampling rate ignored in demo-style backend detection queue"
    );
  }

  const interval = DEMO_CONTINUOUS_CAMERA_INTERVAL;

  log.info(
    {
      count: cameras.length,
      intervalPerCamera: interval,
      framesPerCheck: FRAMES_PER_CHECK,
      iouThreshold: BOX_IOU_THRESHOLD,
      method: "demo_continuous_iou",
      samplingIgnored: true,
    },
    "🚀 Initializing demo-style continuous detection queue"
  );

  for (const camera of cameras) {
    addCameraToQueue(camera);
  }

  if (cameras.length > 0 && !isRunning) {
    startQueueLoop();
  }
}

// -------------------------------------------------------------------
// 🛑 Stop Queue and Clean Up
// -------------------------------------------------------------------
export async function stopDetectionQueue() {
  log.info("🛑 Stopping detection queue");

  stopQueueLoop();

  for (const camera of cameraQueue) {
    const state = cameraStates.get(camera.id);
    if (state && state.isFire) {
      await stopCameraStream(camera);
    }
  }

  cameraQueue = [];
  cameraStates.clear();
  lastAlertSent.clear();
  frontendWatchedCameras.clear();
  currentIndex = 0;
  currentUserId = null;
}

// -------------------------------------------------------------------
// 🔄 Update Camera In Queue
// -------------------------------------------------------------------
export function updateCameraInQueue(id, updates) {
  const cam = cameraQueue.find((c) => c.id === id);
  if (!cam) {
    log.warn(
      { id },
      "⚠️ updateCameraInQueue: Camera not found in detection queue"
    );
    return;
  }

  // DEBUG: Log before and after
  const beforeAiType = cam.aiType;
  const beforeDetection = cam.detection;

  Object.assign(cam, updates);

  log.info(
    {
      id,
      updates,
      before: { aiType: beforeAiType, detection: beforeDetection },
      after: { aiType: cam.aiType, detection: cam.detection }
    },
    "🔄 Camera updated in detectionQueue memory"
  );
}
