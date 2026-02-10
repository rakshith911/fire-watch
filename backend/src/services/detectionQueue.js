import pino from "pino";
import { detectFire, detectFireMultiFrame, buildCameraUrl, grabFrameOnce } from "./localDetector.js";
import { detectFireCloud } from "./cloudDetector.js";
import { detectWeapon } from "./localWeaponDetector.js";
import livenessValidator from "./livenessValidator.js";
import {
  startCameraStream,
  stopCameraStream,
  isStreamActive,
} from "./streamManager.js";
import { sanitizePathName } from "./mediamtxConfigGenerator.js";
import { sendFireAlert } from "./snsService.js";
import { uploadFireFrame } from "./s3Service.js";
import { getUserSamplingRate } from "../db/dynamodb.js";

const log = pino({ name: "detection-queue" });

// -------------------------------------------------------------------
// 📋 Configuration Constants
// -------------------------------------------------------------------
const DEFAULT_SAMPLING_WINDOW = 30000; // 30 seconds default

// -------------------------------------------------------------------
// 📋 Queue State
// -------------------------------------------------------------------
let cameraQueue = [];
let currentIndex = 0;
let isRunning = false;
let loopInterval = null;
let broadcastFireDetection = null;
let currentUserId = null; // Track current user for sampling rate
let samplingWindow = DEFAULT_SAMPLING_WINDOW; // User's sampling window (will be fetched from user settings)

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

// -------------------------------------------------------------------
// 🔧 Configuration - Multi-Frame Detection (Drone Method)
// -------------------------------------------------------------------
const FRAMES_PER_CHECK = 3; // Extract 3 frames per camera turn
const BOX_IOU_THRESHOLD = 0.92; // 92% overlap = static. High threshold means "very hard to be static", easier to be real.
const STATIC_THRESHOLD = 2; // currently not used to short-circuit, but we track it
const MIN_CAMERA_INTERVAL = 1000; // Minimum 1 second between cameras
const MIN_FRAME_INTERVAL = 500; // Minimum 500ms between frames

// -------------------------------------------------------------------
// 🧮 Dynamic Sampling Rate Calculation
// -------------------------------------------------------------------

/**
 * Calculate the interval between camera checks based on sampling
 * window and queue size by distributing cameras evenly.
 *
 * Example:
 *   window = 30000ms, 3 cameras → 10000ms per camera
 */
function calculateCameraInterval(windowDuration, numCameras) {
  if (numCameras === 0) {
    return windowDuration;
  }

  const interval = Math.floor(windowDuration / numCameras);
  return Math.max(MIN_CAMERA_INTERVAL, interval);
}

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
  const isStatic = avgIoU > BOX_IOU_THRESHOLD;

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

  // -----------------------------------------------------------------
  // 🧠 SMART SOURCE SELECTION (Fix for Stream Freeze)
  // -----------------------------------------------------------------
  // Default: Direct Connection (Background Mode)
  let cameraUrl = buildCameraUrl(camera);
  let sourceLog = "DIRECT_RTSP";

  // Smart Switch: If streaming, use Local Stream (Active Mode)
  // This prevents opening a 2nd connection to the camera, avoiding overload/freeze.
  if (isStreamActive(camera.id)) {
    try {
      const streamName = sanitizePathName(camera.streamName || camera.name);
      cameraUrl = `rtsp://localhost:8554/${streamName}-fire`;
      sourceLog = "LOCAL_PROXY";
    } catch (err) {
      log.warn({ err: err.message }, "Failed to build proxy URL, falling back to direct");
    }
  }

  // aiType determines WHAT to detect (FIRE, WEAPON, BOTH)
  const aiType = (camera.aiType || "FIRE").toUpperCase();

  log.info(
    {
      id: camera.id,
      name: camera.name,
      frameCount: FRAMES_PER_CHECK,
      intervalMs: frameInterval,
      aiType,
      source: sourceLog,
      url: cameraUrl
    },
    `📸 Extracting ${FRAMES_PER_CHECK} frames for LOCAL ${aiType} analysis...`
  );

  // ---------------------------------------------------------------
  // 🔥 FIRE or BOTH: Use single-connection multi-frame extraction
  // This fixes the keyframe/GOP problem where cameras with long GOP
  // intervals return the same I-frame on every separate connection,
  // causing false "static" detections.
  // ---------------------------------------------------------------
  if (aiType === "FIRE" || aiType === "BOTH") {
    try {
      const fireResults = await detectFireMultiFrame(cameraUrl, camera.name, FRAMES_PER_CHECK);

      for (let i = 0; i < fireResults.length; i++) {
        const result = fireResults[i];
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
            `🔥 LOCAL Frame ${i + 1}/${fireResults.length}: Fire detected`
          );
        } else {
          log.info(
            { id: camera.id, name: camera.name, frameNumber: i + 1 },
            `✅ LOCAL Frame ${i + 1}/${fireResults.length}: No fire`
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
  if (aiType === "WEAPON" || aiType === "BOTH") {
    for (let i = 0; i < FRAMES_PER_CHECK; i++) {
      try {
        const result = await detectWeapon(cameraUrl, camera.name);
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
            `🔫 WEAPON Frame ${i + 1}/${FRAMES_PER_CHECK}: Weapon detected`
          );
        } else {
          log.info(
            { id: camera.id, name: camera.name, frameNumber: i + 1 },
            `✅ WEAPON Frame ${i + 1}/${FRAMES_PER_CHECK}: No weapon`
          );
        }
        if (i < FRAMES_PER_CHECK - 1) {
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

  try {
    const newSamplingWindow = await getUserSamplingRate(userId, DEFAULT_SAMPLING_WINDOW);

    if (newSamplingWindow !== samplingWindow) {
      const oldWindow = samplingWindow;
      samplingWindow = newSamplingWindow;

      const newInterval = calculateCameraInterval(
        samplingWindow,
        cameraQueue.length
      );

      log.info(
        {
          userId,
          oldWindow,
          newWindow: samplingWindow,
          queueSize: cameraQueue.length,
          newInterval,
        },
        "✅ Sampling rate updated - intervals will adjust on next cycle"
      );
    }
  } catch (error) {
    log.error(
      { userId, error: error.message },
      "❌ Failed to update sampling rate"
    );
  }
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

  // Initialize camera state
  cameraStates.set(camera.id, {
    isFire: false,
    lastChecked: null,
    consecutiveStatic: 0,
  });

  const newInterval = calculateCameraInterval(
    samplingWindow,
    cameraQueue.length
  );

  log.info(
    {
      id: camera.id,
      name: camera.name,
      aiType: camera.aiType,        // DEBUG: Show what aiType camera has
      detection: camera.detection,  // DEBUG: Show detection field
      queueSize: cameraQueue.length,
      samplingWindow,
      newInterval,
    },
    "📹 Camera added to detection queue - intervals recalculated"
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

  const newInterval =
    cameraQueue.length > 0
      ? calculateCameraInterval(samplingWindow, cameraQueue.length)
      : 0;

  log.info(
    {
      id,
      name: camera.name,
      queueSize: cameraQueue.length,
      samplingWindow,
      newInterval,
    },
    "🗑️ Camera removed from detection queue - intervals recalculated"
  );

  if (currentIndex >= cameraQueue.length) {
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

  const initialInterval = calculateCameraInterval(
    samplingWindow,
    cameraQueue.length
  );

  const initialFrameInterval = calculateFrameInterval(initialInterval);

  log.info(
    {
      queueSize: cameraQueue.length,
      samplingWindow,
      intervalPerCamera: initialInterval,
      framesPerCheck: FRAMES_PER_CHECK,
      frameInterval: initialFrameInterval,
      iouThreshold: BOX_IOU_THRESHOLD,
    },
    "▶️ Starting dynamic sampling detection queue"
  );

  async function loop() {
    if (!isRunning || cameraQueue.length === 0) {
      return;
    }

    const camera = cameraQueue[currentIndex];

    if (!camera) {
      log.warn({ currentIndex }, "No camera at current index");
      currentIndex = 0;
      const fallbackInterval = calculateCameraInterval(
        samplingWindow,
        cameraQueue.length
      );
      loopInterval = setTimeout(loop, fallbackInterval);
      return;
    }

    const state = cameraStates.get(camera.id);

    // SKIP LOGIC REMOVED: Backend detection now runs regardless of frontend state
    // We want the backend to be the source of truth for alerts.

    try {
      const currentCameraInterval = calculateCameraInterval(
        samplingWindow,
        cameraQueue.length
      );
      const currentFrameInterval = calculateFrameInterval(currentCameraInterval);
      // aiType = WHAT to detect (FIRE, WEAPON, BOTH)
      // detection = HOW to detect for FIRE (LOCAL, CLOUD)
      const aiType = (camera.aiType || "FIRE").toUpperCase();
      const detectionMethod = (camera.detection || "LOCAL").toUpperCase();

      // For FIRE, check if using CLOUD or LOCAL method
      // For WEAPON/BOTH, always use local (they don't have cloud endpoints)
      let detectionType;
      if (aiType === "FIRE" && detectionMethod === "CLOUD") {
        detectionType = "CLOUD";
      } else if (aiType === "WEAPON") {
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

      if (frames.length === 0) {
        // No detection
        log.info(
          {
            id: camera.id,
            name: camera.name,
          },
          `✅ ${detectionType}: No detection in any frame`
        );

        // Broadcast clear if transitioning from fire → no fire
        if (state.isFire && broadcastFireDetection) {
          broadcastFireDetection(camera.userId, camera.id, camera.name, false);
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
          // 🔫 WEAPON: Multi-frame analysis for liveness
          // We rely on either movement (IoU) OR high confidence to allow static weapons
          const framesWithBoxes = frames.filter(f => f.boxes && f.boxes.length > 0);

          if (framesWithBoxes.length >= 2) {
            const iouResult = analyzeBoxes(framesWithBoxes);
            const avgIoU = parseFloat(iouResult.avgIoU || "0");
            const maxConfidence = framesWithBoxes.reduce((max, f) => Math.max(max, f.boxes[0]?.[5] || 0), 0);

            // Real weapon criteria:
            // - Some movement (IoU < 0.95) indicating it's not a static poster
            // - OR very high confidence (> 0.60) even if static (person holding still)
            const hasMovement = avgIoU < 0.95;
            const highConfidence = maxConfidence > 0.60;

            log.info({
              framesDetected: framesWithBoxes.length,
              avgIoU,
              maxConfidence: maxConfidence.toFixed(3),
              hasMovement,
              highConfidence
            }, "🔫 WEAPON: Multi-frame analysis");

            if (hasMovement || highConfidence) {
              isRealDetection = true;
              log.info(`🔫 WEAPON: Liveness PASSED (${hasMovement ? 'Movement detected' : 'High confidence'})`);
            } else {
              log.info("🔫 WEAPON: REJECTED — Static or low confidence");
            }
          } else {
            // Check if we have at least 1 very high confidence frame (> 0.8) to rescue?
            // User complained about "pause" not working (albeit for Fire). 
            // For weapons, if we only catch 1 frame but it's 0.9 confidence, should we alert?
            // "can you find out if its done?" -> "the weapons detection in the code is not working due to the liveliness check"
            // Let's stick to requiring 2 frames for now to avoid transient noise.
            log.warn({ framesDetected: framesWithBoxes.length }, "⚠️ WEAPON: Not enough frames with detection (>1 needed)");
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
                if (pixelMotion > 0.15) {
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
          iouAnalysis = analyzeBoxes(frames);

          if (!iouAnalysis.isStatic) {
            isRealDetection = true;
            log.info({ ...iouAnalysis },
              `🔥 FIRE: REAL — boxes moving (IoU ${iouAnalysis.avgIoU} < ${BOX_IOU_THRESHOLD})`);
          } else {
            // 🚨 RESCUE MISSION: Check pixel motion
            log.warn({ ...iouAnalysis },
              `⚠️ FIRE STATIC: Checking pixel motion for rescue...`);

            if (frames.length >= 3) {
              const bestBox = frames[0].boxes[0];
              if (bestBox) {
                const pixelRatio = await livenessValidator.isFireMoving(
                  frames.map(f => f.frameBuffer),
                  frames.map(f => f.boxes[0])
                );

                // Threshold > 0.15 = real fire/video
                if (pixelRatio > 0.15) {
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

        if (isRealDetection) {
          // Determine the specific alert type — use actual weapon label (Knife/Pistol) instead of generic "WEAPON"
          const lastFrameForLabel = frames[frames.length - 1];
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

          // Get the last frame for broadcast + SNS alert
          const lastFrame = frames[frames.length - 1];

          log.info({
            id: camera.id,
            boxes: lastFrame.boxes,
            frameBufferSize: lastFrame.frameBuffer?.length,
          }, "📦 Box coordinates being sent");

          // Broadcast to WebSocket
          if (broadcastFireDetection) {
            broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
              boxes: lastFrame.boxes, alertType, confidence: lastFrame.confidence
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
                  lastFrame.boxes
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
            broadcastFireDetection(camera.userId, camera.id, camera.name, false);
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

    log.info({
      id: camera.id,
      name: camera.name,
      result: state.isFire ? "🔴 FIRE/WEAPON" : "🟢 CLEAR",
      nextCamera: cameraQueue[(currentIndex + 1) % cameraQueue.length]?.name,
    }, `━━━ Detection cycle complete for ${camera.name} ━━━`);

    currentIndex = (currentIndex + 1) % cameraQueue.length;

    const nextInterval = calculateCameraInterval(
      samplingWindow,
      cameraQueue.length
    );

    loopInterval = setTimeout(loop, nextInterval);
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

    try {
      samplingWindow = await getUserSamplingRate(currentUserId, DEFAULT_SAMPLING_WINDOW);
      log.info(
        { userId: currentUserId, samplingWindow },
        "✅ User sampling rate loaded from DynamoDB"
      );
    } catch (error) {
      log.error(
        { userId: currentUserId, error: error.message },
        `❌ Failed to fetch sampling rate, using default ${DEFAULT_SAMPLING_WINDOW}ms`
      );
      samplingWindow = DEFAULT_SAMPLING_WINDOW;
    }
  }

  const interval = calculateCameraInterval(samplingWindow, cameras.length);

  log.info(
    {
      count: cameras.length,
      samplingWindow,
      intervalPerCamera: interval,
      framesPerCheck: FRAMES_PER_CHECK,
      iouThreshold: BOX_IOU_THRESHOLD,
      method: "dynamic_sampling_iou",
    },
    "🚀 Initializing dynamic sampling detection queue"
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
  samplingWindow = DEFAULT_SAMPLING_WINDOW;
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
