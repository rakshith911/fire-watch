import pino from "pino";
import { detectFire, detectFireMultiFrame, buildCameraUrl, grabFrameOnce } from "./localDetector.js";
import { detectFireCloud } from "./cloudDetector.js";
import { detectWeapon } from "./localWeaponDetector.js";
import { detectFireYolo, detectWeaponYolo, detectFireMultiFrameYolo } from "./localYoloDetector.js"; // [NEW] Import YOLO
import livenessValidator from "./livenessValidator.js";
import {
  stopCameraStream,
  isStreamActive,
} from "./streamManager.js";
import { sanitizePathName } from "./mediamtxConfigGenerator.js";
import { sendFireAlert } from "./snsService.js";
import { uploadFireFrame } from "./s3Service.js";
import sharp from "sharp";

// Helper to draw boxes
async function drawBoxesOnFrame(buffer, boxes, alertType) {
  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Box format: [x1, y1, x2, y2, label, confidence] (coordinates are absolute)
    // Fire/Weapon colors
    const color = alertType === "Fire" ? "red" : "orange";

    const svgRects = boxes.map(box => {
      let [x1, y1, x2, y2, label, conf] = box;
      // Ensure coordinates are within bounds
      x1 = Math.max(0, x1); y1 = Math.max(0, y1);
      x2 = Math.min(width, x2); y2 = Math.min(height, y2);
      const w = x2 - x1;
      const h = y2 - y1;

      return `
        <rect x="${x1}" y="${y1}" width="${w}" height="${h}"
              style="fill:none;stroke:${color};stroke-width:5" />
        <text x="${x1}" y="${Math.max(30, y1 - 10)}" font-family="Arial" font-size="24" fill="${color}" style="font-weight:bold; stroke:black; stroke-width:0.5px">
          ${label || alertType} ${(conf * 100).toFixed(0)}%
        </text>
      `;
    }).join("\n");

    const svg = `
      <svg width="${width}" height="${height}">
        ${svgRects}
      </svg>
    `;

    return await image
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg()
      .toBuffer();
  } catch (err) {
    console.error("Error drawing boxes:", err);
    return buffer; // Return original if drawing fails
  }
}

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
let loopGeneration = 0; // Bumped on every startQueueLoop; stale loops self-terminate
let broadcastFireDetection = null;
let currentUserId = null; // Track current user

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
const BOX_IOU_THRESHOLD = 0.92; // 92% overlap = static. High threshold means "very hard to be static", easier to be real.

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
// 🎬 Single-Frame Detection (grab one frame, run detection, return)
// -------------------------------------------------------------------
async function detectSingleFrame(camera) {
  const frames = [];

  // -----------------------------------------------------------------
  // 🧠 SMART SOURCE SELECTION (Fix for Stream Freeze)
  // -----------------------------------------------------------------
  let cameraUrl = buildCameraUrl(camera);
  let sourceLog = "DIRECT_RTSP";

  if (isStreamActive(camera.id)) {
    try {
      const streamName = sanitizePathName(camera.streamName || camera.name);
      cameraUrl = `rtsp://localhost:8554/${streamName}-fire`;
      sourceLog = "LOCAL_PROXY";
    } catch (err) {
      log.warn({ err: err.message }, "Failed to build proxy URL, falling back to direct");
    }
  }

  const aiType = (camera.aiType || "FIRE").toUpperCase();

  // ---------------------------------------------------------------
  // 🧠 DETECTION ROUTER
  // Default (FIRE/WEAPON/BOTH) = Detectron on backend. YOLO suffix = YOLO on backend.
  // Frontend always runs YOLO in-browser regardless.
  // ---------------------------------------------------------------
  const runFireYolo = ["FIRE_YOLO", "BOTH_YOLO"].includes(aiType);
  const runFireDetectron = ["FIRE", "FIRE_DETECTRON", "BOTH", "BOTH_DETECTRON"].includes(aiType);
  const runWeaponYolo = ["WEAPON_YOLO", "BOTH_YOLO"].includes(aiType);
  const runWeaponDetectron = ["WEAPON", "WEAPON_DETECTRON", "BOTH", "BOTH_DETECTRON"].includes(aiType);

  // --- FIRE (YOLO) ---
  if (runFireYolo) {
    try {
      const fireResults = await detectFireMultiFrameYolo(cameraUrl, camera.name, 3);
      for (const result of fireResults) {
        if (result.isFire) {
          frames.push({
            timestamp: new Date().toISOString(),
            boxes: result.boxes,
            fireCount: result.boxes.filter(b => b[4] === "Fire").length,
            smokeCount: result.boxes.filter(b => b[4] === "Smoke").length,
            confidence: result.confidence,
            frameBuffer: result.frameBuffer,
            aiType: "FIRE"
          });
          log.info(
            { id: camera.id, name: camera.name, model: "YOLO", boxes: result.boxes.length },
            `🔥 [Fire-YOLO] Fire detected`
          );
        }
      }
    } catch (error) {
      log.error({ id: camera.id, model: "YOLO", error: error.message }, `❌ [Fire-YOLO] error`);
    }
  }

  // --- FIRE (Detectron) ---
  if (runFireDetectron) {
    try {
      const fireResults = await detectFireMultiFrame(cameraUrl, camera.name, 3);
      for (const result of fireResults) {
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
            { id: camera.id, name: camera.name, model: "Detectron", boxes: result.boxes.length },
            `🔥 [Fire-Detectron] Fire detected`
          );
        }
      }
    } catch (error) {
      log.error({ id: camera.id, model: "Detectron", error: error.message }, `❌ [Fire-Detectron] error`);
    }
  }

  // --- WEAPON (YOLO) ---
  if (runWeaponYolo) {
    try {
      const result = await detectWeaponYolo(cameraUrl, camera.name);
      if (result.isWeapon) {
        frames.push({
          timestamp: new Date().toISOString(),
          boxes: result.boxes,
          confidence: result.confidence,
          frameBuffer: result.frameBuffer,
          aiType: "WEAPON"
        });
        log.info(
          { id: camera.id, name: camera.name, model: "YOLO", label: result.boxes[0]?.[4], confidence: result.boxes[0]?.[5]?.toFixed(3) },
          `🔫 [Weapon-YOLO] ${result.boxes[0]?.[4]} detected (${(result.boxes[0]?.[5] * 100).toFixed(0)}%)`
        );
      }
    } catch (e) {
      log.error({ id: camera.id, model: "YOLO", error: e.message }, "❌ [Weapon-YOLO] error");
    }
  }

  // --- WEAPON (Detectron) ---
  if (runWeaponDetectron) {
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
          { id: camera.id, name: camera.name, model: "Detectron", label: result.boxes[0]?.[4], confidence: result.boxes[0]?.[5]?.toFixed(3) },
          `🔫 [Weapon-Detectron] ${result.boxes[0]?.[4]} detected (${(result.boxes[0]?.[5] * 100).toFixed(0)}%)`
        );
      }
    } catch (error) {
      log.error({ id: camera.id, model: "Detectron", error: error.message }, `❌ [Weapon-Detectron] error`);
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
    // Determine alertType from actual box labels
    const weaponLabels = ["Knife", "Pistol"];
    const hasWeapon = boxes.some(b => weaponLabels.includes(b[4]));
    const resolvedAlertType = hasWeapon ? (boxes.find(b => weaponLabels.includes(b[4]))?.[4] || "Weapon") : "Fire";

    broadcastFireDetection(userId, cameraId, cameraName, true, {
      boxes: boxes,
      alertType: resolvedAlertType,
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
// ➕ Add Camera to Queue
// -------------------------------------------------------------------
export function addCameraToQueue(camera) {
  const exists = cameraQueue.find((c) => c.id === camera.id);
  if (exists) {
    log.warn({ id: camera.id, name: camera.name }, "Camera already in queue");
    return;
  }

  cameraQueue.push(camera);

  // Set current user if not set
  if (!currentUserId && camera.userId) {
    currentUserId = camera.userId;
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
      aiType: camera.aiType,
      detection: camera.detection,
      queueSize: cameraQueue.length,
    },
    "📹 Camera added to detection queue"
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
    },
    "🗑️ Camera removed from detection queue"
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
  const gen = ++loopGeneration; // Capture generation; any older loop will bail when gen differs

  log.info(
    {
      queueSize: cameraQueue.length,
      iouThreshold: BOX_IOU_THRESHOLD,
      generation: gen,
    },
    "▶️ Starting detection queue (1 frame per camera, continuous cycle)"
  );

  // Single async while-loop — generation guard prevents stale loops from continuing after restart
  while (isRunning && cameraQueue.length > 0 && loopGeneration === gen) {
    const camera = cameraQueue[currentIndex];

    if (!camera) {
      log.warn({ currentIndex }, "No camera at current index");
      currentIndex = 0;
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    const state = cameraStates.get(camera.id);

    try {
      // aiType = WHAT to detect (FIRE, WEAPON, BOTH)
      // detection = HOW to detect for FIRE (LOCAL, CLOUD)
      const aiType = (camera.aiType || "FIRE").toUpperCase();
      const detectionMethod = (camera.detection || "LOCAL").toUpperCase();

      let detectionType = "LOCAL";
      if (aiType.includes("FIRE") && detectionMethod === "CLOUD") {
        detectionType = "CLOUD";
      } else if (aiType.includes("WEAPON")) {
        detectionType = "WEAPON";
      } else if (aiType.includes("BOTH")) {
        detectionType = "BOTH";
      }

      // Determine model label for logs
      // Default (FIRE/WEAPON/BOTH) = Detectron. Only explicit _YOLO suffix = YOLO.
      const modelLabel = aiType.includes("YOLO") ? "YOLO" : "Detectron";

      log.info(
        {
          id: camera.id,
          name: camera.name,
          aiType,
          model: modelLabel,
          position: `${currentIndex + 1}/${cameraQueue.length}`,
        },
        `🔍 [${camera.name}] ${aiType} detection (${modelLabel})`
      );

      // ✅ SINGLE-FRAME DETECTION — grab one frame, run model, return
      let frames = [];
      if (detectionType === "CLOUD") {
        frames = await extractMultipleFramesCloud(camera);
      } else {
        frames = await detectSingleFrame(camera);
      }

      state.lastChecked = new Date().toISOString();

      if (frames.length === 0) {
        log.info(
          {
            id: camera.id,
            name: camera.name,
            aiType,
            model: modelLabel,
          },
          `✅ [${camera.name}] ${aiType} (${modelLabel}): No detection in any frame`
        );

        if (state.isFire && broadcastFireDetection) {
          broadcastFireDetection(camera.userId, camera.id, camera.name, false);
        }

        state.isFire = false;
        state.consecutiveStatic = 0;
        lastAlertSent.delete(camera.id);
      } else {
        log.warn(
          {
            id: camera.id,
            name: camera.name,
            aiType,
            model: modelLabel,
            framesWithDetection: frames.length,
          },
          `🚨 [${camera.name}] ${aiType} (${modelLabel}) detected in ${frames.length} frames — analyzing...`
        );

        let isRealDetection = false;
        let iouAnalysis = null;

        if (detectionType === "CLOUD") {
          const cloudResult = frames[0]?.cloudResult;
          if (cloudResult && cloudResult.isFire) {
            isRealDetection = true;
            iouAnalysis = cloudResult.iouAnalysis || null;
            log.info(
              { reason: cloudResult.reason, confidence: cloudResult.confidence },
              "🌥️ CLOUD: Fire confirmed by cloud endpoint"
            );
          }
        } else {
          const fireFrames = frames.filter(f => f.aiType === "FIRE");
          const weaponFrames = frames.filter(f => f.aiType === "WEAPON");

          // --- FIRE LOGIC ---
          if (fireFrames.length >= 2) {
            const iouResult = analyzeBoxes(fireFrames);

            if (!iouResult.isStatic) {
              isRealDetection = true;
              iouAnalysis = iouResult;
              log.info({ ...iouResult }, "🔥 FIRE: REAL — boxes moving");
            } else {
              log.warn({ ...iouResult }, "⚠️ FIRE STATIC: Checking pixel motion...");
              if (fireFrames.length >= 3) {
                const pixelRatio = await livenessValidator.isFireMoving(
                  fireFrames.map(f => f.frameBuffer),
                  fireFrames.map(f => f.boxes[0])
                );
                if (pixelRatio > 0.15) {
                  isRealDetection = true;
                  iouAnalysis = iouResult;
                  iouAnalysis.reason = "pixel_motion_rescue";
                  log.warn({ pixelRatio }, "🔥 FIRE: RESCUED by pixel motion!");
                }
              }
            }
          }

          // --- WEAPON LOGIC ---
          const framesWithBoxes = frames.filter((f) => f.boxes && f.boxes.length > 0 && f.aiType === "WEAPON");

          if (framesWithBoxes.length > 0) {
            const bestFrame = framesWithBoxes.sort((a, b) => b.boxes[0][5] - a.boxes[0][5])[0];
            const bestBox = bestFrame.boxes[0];
            const confidence = bestBox[5];
            const label = bestBox[4];

            log.info(
              { id: camera.id, name: camera.name, model: modelLabel, label, confidence: confidence.toFixed(3), framesWithWeapons: framesWithBoxes.length },
              `🔫 [${camera.name}] Weapon candidate: ${label} @ ${(confidence * 100).toFixed(0)}% (${modelLabel}) — running 3D depth check...`
            );

            let is3D = false;
            try {
              is3D = await livenessValidator.isWeapon3D(bestFrame.frameBuffer, bestBox);
            } catch (err) {
              log.error({ err: err.message }, "❌ Weapon 3D depth check failed, defaulting to false");
            }

            if (is3D) {
              isRealDetection = true;
              log.info(
                { id: camera.id, name: camera.name, model: modelLabel, label, confidence: confidence.toFixed(3) },
                `🔫 [${camera.name}] WEAPON CONFIRMED: ${label} is 3D real object (${modelLabel})`
              );
            } else {
              log.info(
                { id: camera.id, name: camera.name, model: modelLabel, label, confidence: confidence.toFixed(3) },
                `⚠️ [${camera.name}] WEAPON REJECTED: ${label} appears 2D/flat (${modelLabel})`
              );
            }
          }
        }

        if (isRealDetection) {
          state.isFire = true;

          const now = Date.now();
          if (!lastAlertSent.has(camera.id) || (now - lastAlertSent.get(camera.id)) > ALERT_COOLDOWN_MS) {
            lastAlertSent.set(camera.id, now);

            const bestFrame = frames[0];
            const alertType = bestFrame.aiType === "WEAPON" ? "Weapon" : "Fire";

            log.info(
              { id: camera.id, name: camera.name, alertType, model: modelLabel },
              `🚨 [${camera.name}] SENDING ${alertType} ALERT (${modelLabel})!`
            );

            if (alertType === "Fire") {
              drawBoxesOnFrame(bestFrame.frameBuffer, bestFrame.boxes, "Fire")
                .then(modifiedBuffer => uploadFireFrame(camera.id, modifiedBuffer))
                .then((url) =>
                  sendFireAlert(
                    camera.userId,
                    camera.id,
                    camera.name,
                    {
                      detectionType: "Fire",
                      confidence: bestFrame.confidence,
                      boxes: bestFrame.boxes,
                    },
                    url
                  )
                )
                .catch((e) => log.error(e, "Alert failed"));
            } else if (alertType === "Weapon") {
              drawBoxesOnFrame(bestFrame.frameBuffer, bestFrame.boxes, "Weapon")
                .then(modifiedBuffer => uploadFireFrame(camera.id, modifiedBuffer))
                .then((url) =>
                  sendFireAlert(
                    camera.userId,
                    camera.id,
                    camera.name,
                    {
                      detectionType: bestFrame.boxes[0]?.[4] || "Weapon",
                      confidence: bestFrame.confidence,
                      boxes: bestFrame.boxes,
                    },
                    url
                  )
                )
                .catch((e) => log.error(e, "Weapon Alert failed"));
            }

            if (broadcastFireDetection) {
              broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
                boxes: bestFrame.boxes,
                alertType: alertType,
                confidence: bestFrame.confidence,
                source: "local-backend"
              });
            }
          }
        }
      }

    } catch (error) {
      log.error(
        { id: camera.id, error: error.message },
        "❌ Queue loop processing error"
      );
    }

    currentIndex = (currentIndex + 1) % cameraQueue.length;
  }

  // Loop exited naturally (stopped or queue empty)
  isRunning = false;
  log.info("🛑 Detection loop exited");
}

function stopQueueLoop() {
  isRunning = false;
  log.info("🛑 Detection queue stop requested");
}
// -------------------------------------------------------------------
// 📊 Get Queue Status
// -------------------------------------------------------------------
export function getQueueStatus() {
  const streamingCameras = new Set();
  cameraQueue.forEach(c => {
    // Check if stream is active using the imported helper
    if (isStreamActive(c.id)) {
      streamingCameras.add(c.id);
    }
  });

  const fireDetections = {};
  const lastChecked = {};

  cameraStates.forEach((val, key) => {
    fireDetections[key] = val.isFire;
    lastChecked[key] = val.lastChecked;
  });

  return {
    cameras: cameraQueue.map(c => ({ id: c.id, name: c.name })),
    fireDetections,
    lastChecked,
    streamingCameras
  };
}

// -------------------------------------------------------------------
// 🔄 Update Camera in Queue
// -------------------------------------------------------------------
export function updateCameraInQueue(id, updates) {
  const camera = cameraQueue.find(c => c.id === id);
  if (camera) {
    Object.assign(camera, updates);
    log.info({ id, updates }, "Updated camera in queue memory");
  }
}

// -------------------------------------------------------------------
// 🚀 Start/Stop Queue (Exported for Server)
// -------------------------------------------------------------------
export async function startDetectionQueue(cameras = []) {
  stopQueueLoop(); // Ensure stopped first

  cameraQueue = [...cameras];
  cameraStates.clear();

  cameras.forEach(c => {
    cameraStates.set(c.id, {
      isFire: false,
      lastChecked: null,
      consecutiveStatic: 0
    });
  });

  if (cameras.length > 0) {
    if (cameras[0].userId) {
      currentUserId = cameras[0].userId;
    }
    log.info({ count: cameras.length, currentUserId }, "🚀 Starting detection queue via server command");
    startQueueLoop();
  } else {
    log.info("START called but no cameras provided - queue idle, will start when camera is added");
    // isRunning stays false — addCameraToQueue will call startQueueLoop() when a camera is added
  }
}

export function setCurrentUser(userId) {
  currentUserId = userId;
  log.info({ currentUserId }, "Current user set manually");
}

export async function stopDetectionQueue() {
  stopQueueLoop();
  cameraQueue = [];
  cameraStates.clear();
  log.info("🛑 Detection queue fully reset");
}
