import pino from "pino";
import sharp from "sharp";
import { detectFireMultiFrame, buildCameraUrl, grabFrameOnce } from "./localDetector.js";
import livenessValidator from "./livenessValidator.js";
import { startCameraStream, stopCameraStream, isStreamActive } from "./streamManager.js";
import { sanitizePathName } from "./mediamtxConfigGenerator.js";
import { sendFireAlert } from "./snsService.js";
import { uploadFireFrame } from "./s3Service.js";
import {
  startSidecar,
  waitSidecarReady,
  classifySequenceWithClip,
  getAnomalyScore,
} from "./vjepaSidecar.js";
import { cropLargestPerson } from "./personDetector.js";
import { detectWeaponYolo } from "./localYoloDetector.js";
import { getLargestPersonPose } from "./poseDetector.js";
import { ByteTracker } from "./byteTracker.js";

const log = pino({ name: "detection-queue" });

// ─── Constants ──────────────────────────────────────────────────────────────
const CYCLE_INTERVAL_MS          = 3000;   // pause between full cycles per camera
const FRAMES_PER_CYCLE           = 3;      // frames grabbed in each initial check
const RECHECK_COUNT              = 2;      // immediate rechecks after initial fire detection
const CONFIRM_THRESHOLD          = 2;      // checks that must confirm out of (1 + RECHECK_COUNT)
const BOX_MOVE_IOU_THRESHOLD     = 0.70;   // IOU below this = bbox moved significantly
const FIRE_MOTION_THRESHOLD      = 0.10;   // pixel-motion ratio that bypasses CLIP verification
const INTER_CYCLE_THRESHOLD      = 0.04;   // inter-cycle pixel diff for long-GOP cameras
const BEHAVIORAL_COOLDOWN_MS     = 30_000; // min ms between same behavioral label per camera
const ALERT_COOLDOWN_MS          = 60_000; // min ms between SNS/S3 alerts per camera
const FAST_PERSON_INTERVAL_MS    = 1_000;  // fast person-detection loop interval
const PERSON_CLEAR_DELAY_MS      = 5_000;  // ms after person leaves before clearing label

// CLIP prompts used when fire/smoke detection clears — understand WHY it disappeared
const FIRE_CLEAR_PROMPTS = [
  "camera was moved or rotated away, now showing a completely different area with no fire",
  "fire was extinguished or put out, the scene now shows a normal room or burnt area",
  "fire moved out of frame or is no longer visible in the current camera angle",
  "the scene looks completely normal with no fire, smoke, or heat visible",
];
const FIRE_CLEAR_LABELS = [
  "Camera moved away from the fire source",
  "Fire appears to have been extinguished",
  "Fire moved out of the camera's view",
  "Scene returned to normal",
];

// CLIP prompts used to distinguish real fire/smoke from a static photo / screen
const FIRE_VERIFY_PROMPTS = [
  "real fire actively burning with visible moving flames",
  "thick dark smoke rising through the air without visible flames",
  "a photograph, poster, painting, or printed picture of fire on a flat surface",
  "a TV screen, monitor, or digital display showing fire footage or video",
  "a normal scene with no fire or smoke present",
];
const FIRE_VERIFY_LABELS = ["fire", "smoke", "static_photo", "screen_video", "no_fire"];

// ─── Module state ────────────────────────────────────────────────────────────
const cameraStates   = new Map(); // id → state object
const cameraTrackers = new Map(); // id → ByteTracker
const cameraLoops    = new Map(); // id → { active: bool }
const cameraRegistry = new Map(); // id → camera object (mutable, updated in-place)
const lastAlertSent  = new Map(); // id → timestamp
let broadcastFireDetection = null;
let currentUserId          = null;
let isRunning              = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pickBestFrame(frames) {
  return frames.reduce((best, f) => {
    const c = f?.boxes?.[0]?.[5] || 0;
    return c > (best?.boxes?.[0]?.[5] || 0) ? f : best;
  }, frames[0] || null);
}

function computeIoU(b1, b2) {
  const xi1 = Math.max(b1[0], b2[0]), yi1 = Math.max(b1[1], b2[1]);
  const xi2 = Math.min(b1[2], b2[2]), yi2 = Math.min(b1[3], b2[3]);
  const inter = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
  const a1 = (b1[2] - b1[0]) * (b1[3] - b1[1]);
  const a2 = (b2[2] - b2[0]) * (b2[3] - b2[1]);
  return inter / (a1 + a2 - inter || 1);
}

function getCameraUrl(camera) {
  try {
    const streamName = sanitizePathName(camera.streamName || camera.name);
    if (streamName) return `rtsp://127.0.0.1:8554/${streamName}`;
  } catch {}
  return buildCameraUrl(camera);
}

function initCameraState() {
  return {
    isFire:              false,
    lastChecked:         null,
    lastAlertType:       null,
    confirmedCycles:     0,
    lastCycleFrame:      null,
    lastCycleBox:        null,
    totalCycles:         0,
    clipCooldowns:       {},
    // Person presence (for label-clear on exit)
    personPresent:       false,
    lastPersonSeen:      0,
    entryClearPending:   false,
    // Weapon tracking (for box-clear when weapon disappears)
    isWeapon:            false,
  };
}

// ─── Fire verification (multi-check + JEPA/CLIP) ─────────────────────────────
async function verifyFireWithClip(fireFrames, cameraId) {
  const framesB64 = fireFrames.filter(f => f.frameBuffer).map(f => f.frameBuffer.toString("base64"));
  if (framesB64.length === 0) return { isReal: true, alertType: "Fire", reason: "no_frames" };

  try {
    const clip = await classifySequenceWithClip(framesB64, FIRE_VERIFY_PROMPTS, FIRE_VERIFY_LABELS);
    log.info({ cameraId, label: clip.label, prob: clip.top_prob }, "🔍 CLIP fire verification");

    if (clip.label === "static_photo" || clip.label === "screen_video") {
      return { isReal: false, reason: `clip_${clip.label}`, prob: clip.top_prob };
    }
    if (clip.label === "no_fire" && clip.top_prob > 0.50) {
      return { isReal: false, reason: "clip_no_fire", prob: clip.top_prob };
    }

    // CLIP directly tells us fire vs smoke
    const alertType = clip.label === "smoke" ? "Smoke" : "Fire";
    return { isReal: true, alertType };
  } catch (err) {
    log.warn({ err: err.message }, "⚠️ CLIP verification failed — defaulting to real");
    return { isReal: true, alertType: "Fire", reason: "verification_error" };
  }
}

// ─── Weapon pipeline (weapons_yolo.onnx, every cycle) ────────────────────────
const WEAPON_COOLDOWN_MS = 20_000; // min ms between weapon alerts per camera

async function runWeaponPipeline(camera, state, cameraUrl) {
  try {
    const result = await detectWeaponYolo(cameraUrl, camera.name);

    if (result.transientReadError) return;

    if (!result.isWeapon || result.boxes.length === 0) {
      // Weapon gone — send explicit clear so frontend wipes the boxes immediately
      if (state.isWeapon) {
        state.isWeapon = false;
        log.info({ cameraId: camera.id }, "🔫 Weapon gone — clearing boxes");
        if (broadcastFireDetection) {
          broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
            boxes: [], reason: "weapon_gone",
          });
        }
      }
      return;
    }

    state.isWeapon = true;
    const now      = Date.now();
    const lastSent = state.clipCooldowns["weapon"] || 0;
    if (now - lastSent < WEAPON_COOLDOWN_MS) return;

    state.clipCooldowns["weapon"] = now;
    const label = result.boxes[0]?.[4] || "Knife";
    log.info({ cameraId: camera.id, label, conf: result.confidence?.toFixed(3) }, "🔫 Weapon detected — broadcasting");

    if (broadcastFireDetection) {
      broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
        boxes:        result.boxes,
        alertType:    label,
        event:        `Someone carrying a ${label.toLowerCase()} detected`,
        clipLabel:    `Someone carrying a ${label.toLowerCase()} detected`,
        confidence:   result.confidence,
        isBehavioral: true,
      });
    }
  } catch (err) {
    log.warn({ cameraId: camera.id, err: err.message }, "⚠️ Weapon pipeline error");
  }
}

// ─── Behavioral pipeline (YOLO → V-JEPA → CLIP, every cycle) ─────────────────
async function runBehavioralPipeline(frames, camera, state, cameraUrl) {
  const allBufs = frames.map(f => f.frameBuffer).filter(Boolean);
  if (allBufs.length === 0) {
    log.info({ cameraId: camera.id }, "🔍 Behavioral: no frame buffers — skipping");
    return;
  }
  log.info({ cameraId: camera.id, frameCount: allBufs.length }, "🔍 Behavioral pipeline started");

  try {
    // Tier 1: locate person in mid-cycle frame
    const refFrame = allBufs[Math.floor(allBufs.length / 2)];
    let cropBox = null;

    const posePerson = await getLargestPersonPose(refFrame).catch(() => null);
    cropBox = posePerson?.box ?? null;
    if (!cropBox) {
      const personResult = await cropLargestPerson(refFrame).catch(() => null);
      cropBox = personResult?.box ?? null;
    }

    let personCropsB64 = [];
    let detectedBoxes  = [];

    if (cropBox) {
      const [bx1, by1, bx2, by2] = cropBox;
      let fw = 640, fh = 480;
      try { const m = await sharp(refFrame).metadata(); fw = m.width; fh = m.height; } catch {}
      const pw = (bx2 - bx1) * 0.15, ph = (by2 - by1) * 0.15;
      const left = Math.max(0, Math.floor(bx1 - pw));
      const top  = Math.max(0, Math.floor(by1 - ph));
      const w    = Math.min(fw, Math.ceil(bx2 + pw)) - left;
      const h    = Math.min(fh, Math.ceil(by2 + ph)) - top;

      if (w >= 16 && h >= 16) {
        for (const buf of allBufs) {
          const crop = await sharp(buf).extract({ left, top, width: w, height: h }).toBuffer().catch(() => null);
          if (crop) personCropsB64.push(crop.toString("base64"));
        }
        if (personCropsB64.length > 0) detectedBoxes = [cropBox];
      }
    }

    log.info({
      cameraId:   camera.id,
      personFound: !!cropBox,
      cropBox,
      personCrops: personCropsB64.length,
    }, personCropsB64.length > 0 ? "🧍 Person crop found — using for V-JEPA" : "🖼️ No person crop — using full frames for V-JEPA");

    const vjepaFrames = personCropsB64.length > 0
      ? personCropsB64
      : allBufs.map(b => b.toString("base64"));

    // Tier 2: V-JEPA temporal gate (VideoMAE-B) — skip CLIP when activity is normal baseline
    const anomaly = await getAnomalyScore(vjepaFrames, String(camera.id), false).catch(() => null);
    log.info({
      cameraId:       camera.id,
      anomalyScore:   anomaly?.anomaly_score ?? null,
      trigger:        anomaly?.anomaly_trigger ?? null,
      baselineReady:  anomaly?.baseline_ready ?? null,
      samples:        anomaly?.baseline_samples ?? null,
      inferenceMs:    anomaly?.inference_ms ?? null,
      usingCrops:     personCropsB64.length > 0,
    }, "🧠 V-JEPA anomaly gate");

    if (anomaly?.baseline_ready && !anomaly?.anomaly_trigger) {
      log.info({ cameraId: camera.id, score: anomaly.anomaly_score }, "🧠 V-JEPA: scene normal — skipping CLIP");
      return;
    }

    // While V-JEPA baseline is still building (first ~10 cycles), skip CLIP when
    // no person is in the frame. Empty rooms produce low-confidence CLIP scores
    // (~0.4) that land on random labels like "suspicious" or "camera redirected".
    if (!anomaly?.baseline_ready && personCropsB64.length === 0) {
      log.info({ cameraId: camera.id, samples: anomaly?.baseline_samples }, "⏳ Baseline building, no person — skipping CLIP");
      return;
    }

    // Tier 3: CLIP sequence classification
    const clipResult = await classifySequenceWithClip(vjepaFrames);
    const clipLabel  = clipResult.label;
    log.info({
      cameraId: camera.id,
      clipLabel,
      prob:     clipResult.top_prob,
      inferMs:  clipResult.inference_ms,
    }, clipLabel ? "🎯 CLIP label produced" : "🎯 CLIP: no label (below threshold or normal)");

    if (!clipLabel) return;

    // Broadcast CLIP scene label immediately — no recheck gate.
    // The V-JEPA anomaly gate already filtered out baseline-normal cycles,
    // so anything reaching here is genuinely unusual.
    // Cooldown prevents the same label flooding every 3-second cycle.
    const now      = Date.now();
    const lastSent = state.clipCooldowns[clipLabel] || 0;
    if (now - lastSent > BEHAVIORAL_COOLDOWN_MS) {
      state.clipCooldowns[clipLabel] = now;
      log.info({ cameraId: camera.id, label: clipLabel, prob: clipResult.top_prob }, "🎬 Behavioral scene label broadcast");

      if (broadcastFireDetection) {
        broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
          boxes:        detectedBoxes,
          alertType:    clipLabel,
          event:        clipLabel,
          clipLabel,
          confidence:   clipResult.top_prob,
          isBehavioral: true,
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, "⚠️ Behavioral pipeline error");
  }
}

// ─── Fast person-detection loop (~1s cadence, label-clear only) ──────────────
// Entry detection is handled by V-JEPA → CLIP in the main 3s cycle.
// V-JEPA has the temporal baseline of the scene; it knows what the door looks
// like at rest and flags the anomaly when someone actually walks through.
// This loop only tracks presence so we can clear the label after the person leaves.
async function runFastPersonCheck(camera, state) {
  if (!broadcastFireDetection) return;
  const cameraUrl = getCameraUrl(camera);

  try {
    const quickBuf = await grabFrameOnce(cameraUrl);
    if (!Buffer.isBuffer(quickBuf)) return;

    const personResult = await cropLargestPerson(quickBuf).catch(() => null);
    const personFound  = !!personResult?.box;
    const now          = Date.now();

    if (personFound) {
      state.lastPersonSeen    = now;
      state.entryClearPending = false;
      state.personPresent     = true;
    } else {
      if (state.personPresent) {
        const elapsed = now - state.lastPersonSeen;
        if (elapsed >= PERSON_CLEAR_DELAY_MS) {
          state.personPresent     = false;
          state.entryClearPending = false;
          log.info({ cameraId: camera.id, goneMs: elapsed }, "👤 Person gone — clearing label");
          broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
            reason: "person_left",
          });
        }
      }
    }
  } catch (err) {
    log.warn({ cameraId: camera.id, err: err.message }, "⚠️ Fast person check error");
  }
}

// ─── Main per-camera detection cycle ─────────────────────────────────────────
async function processCameraOnce(camera) {
  const state = cameraStates.get(camera.id);
  if (!state) return;

  const cameraUrl = getCameraUrl(camera);
  state.lastChecked  = new Date().toISOString();
  state.totalCycles  = (state.totalCycles || 0) + 1;
  log.info({ id: camera.id, name: camera.name, cycle: state.totalCycles }, "🔄 Camera cycle start");

  // ── 1. Initial frame grab (3 frames) + YOLO ───────────────────────────────
  let frames = [];
  try {
    frames = await detectFireMultiFrame(cameraUrl, camera.name, FRAMES_PER_CYCLE, { modelFile: "best.onnx" });
    const readErr = frames.find(f => f.transientReadError || f.error);
    if (readErr) {
      log.warn({ id: camera.id, error: readErr.error }, "⚠️ Frame read error — skipping cycle");
      return;
    }
  } catch (err) {
    log.warn({ id: camera.id, err: err.message }, "⚠️ Frame extraction failed");
    return;
  }

  // Update ByteTracker with all frames so tracks age correctly
  const tracker = cameraTrackers.get(camera.id);
  for (const f of frames) tracker.update(f.boxes || []);

  const initialFireFrames = frames.filter(f => f.isFire && f.boxes?.length > 0);

  // Behavioral + weapon always run every cycle regardless of fire state.
  // All three pipelines (fire, behavioral, weapon) are fully independent.
  const behavioralPromise = runBehavioralPipeline(frames, camera, state, cameraUrl);
  const weaponPromise     = runWeaponPipeline(camera, state, cameraUrl);

  if (initialFireFrames.length === 0) {
    // ── No fire ──────────────────────────────────────────────────────────────
    if (state.isFire) {
      // Ask CLIP to describe WHY the fire disappeared (camera moved, extinguished, etc.)
      let clearEvent = state.lastAlertType === "Smoke" ? "Smoke cleared from view" : "Fire no longer visible in the scene";
      try {
        const clearB64 = frames.filter(f => f.frameBuffer).map(f => f.frameBuffer.toString("base64"));
        if (clearB64.length > 0) {
          const clearClip = await classifySequenceWithClip(clearB64, FIRE_CLEAR_PROMPTS, FIRE_CLEAR_LABELS);
          if (clearClip.label) {
            clearEvent = clearClip.label;
            log.info({ id: camera.id, label: clearClip.label, prob: clearClip.top_prob }, "🔍 CLIP fire-clear description");
          }
        }
      } catch (err) {
        log.warn({ err: err.message }, "⚠️ CLIP fire-clear failed — using fallback label");
      }

      if (broadcastFireDetection) {
        broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
          event: clearEvent, reason: "no_detection",
        });
      }
      log.info({ id: camera.id, event: clearEvent }, "🟢 Detection cleared");
    }
    state.isFire          = false;
    state.lastAlertType   = null;
    state.confirmedCycles = 0;
    lastAlertSent.delete(camera.id);
    await Promise.all([behavioralPromise, weaponPromise]);
    return;
  }

  // ── 2. Multi-check: 2 immediate quick rechecks ────────────────────────────
  // The same full check repeats 2 more times right away.
  // Need 2/3 to confirm — OR ByteTracker shows significant bbox movement.
  let checksConfirmed = 1; // initial check passed
  const recheckFrames = [];

  for (let i = 0; i < RECHECK_COUNT; i++) {
    try {
      const quick = await detectFireMultiFrame(cameraUrl, camera.name, 1, { modelFile: "best.onnx" });
      const qf = quick[0];
      if (qf && !qf.transientReadError) {
        tracker.update(qf.boxes || []);
        recheckFrames.push(qf);
        if (qf.isFire && qf.boxes?.length > 0) checksConfirmed++;
      }
    } catch {}
  }

  // ByteTracker significant bbox movement (real fire moves; static photo doesn't)
  const allDetected = [...initialFireFrames, ...recheckFrames.filter(f => f.isFire && f.boxes?.length > 0)];
  let bboxMoved = false;
  if (allDetected.length >= 2) {
    const iou = computeIoU(allDetected[0].boxes[0], allDetected[allDetected.length - 1].boxes[0]);
    bboxMoved = iou < BOX_MOVE_IOU_THRESHOLD;
  }

  const confirmedTracks   = tracker.getConfirmedTracks();
  const multiCheckPassed  = checksConfirmed >= CONFIRM_THRESHOLD || bboxMoved;

  log.info({
    id: camera.id, checksConfirmed, bboxMoved,
    confirmedTracks: confirmedTracks.length, passed: multiCheckPassed,
  }, "🔍 Multi-check");

  if (!multiCheckPassed) {
    state.confirmedCycles++;
    log.warn({ id: camera.id, checksConfirmed, confirmedCycles: state.confirmedCycles }, "⏳ Multi-check failed — holding");
    if (state.confirmedCycles >= 3) { state.isFire = false; state.confirmedCycles = 0; }
    await Promise.all([behavioralPromise, weaponPromise]);
    return;
  }

  if (confirmedTracks.length === 0) {
    log.warn({ id: camera.id }, "⚠️ No ByteTrack confirmed tracks — waiting");
    await Promise.all([behavioralPromise, weaponPromise]);
    return;
  }

  // ── 3. Fast pixel-motion check (bypass CLIP if strong motion already seen) ─
  let pixelMotion = 0;
  try {
    const bufs = allDetected.filter(f => f.frameBuffer).map(f => f.frameBuffer);
    const boxs = allDetected.filter(f => f.frameBuffer).map(f => f.boxes[0]);
    if (bufs.length >= 2) pixelMotion = await livenessValidator.isFireMoving(bufs, boxs);
  } catch {}

  // ── 4. JEPA + CLIP verification: real fire vs static image/screen ──────────
  let verification;
  if (pixelMotion > FIRE_MOTION_THRESHOLD) {
    log.info({ id: camera.id, pixelMotion }, "🔥 Strong pixel motion — CLIP verification skipped");
    verification = { isReal: true, alertType: "Fire" };
  } else {
    verification = await verifyFireWithClip(allDetected, camera.id);
  }

  // Inter-cycle comparison catches static objects that persist across cycles
  {
    const curFrame = allDetected[allDetected.length - 1];
    let interCycleRatio = 0;
    if (state.lastCycleFrame && curFrame?.frameBuffer && curFrame?.boxes?.[0]) {
      try {
        interCycleRatio = await livenessValidator.compareInterCycle(
          state.lastCycleFrame, curFrame.frameBuffer, curFrame.boxes[0]
        );
      } catch {}
    }
    if (curFrame?.frameBuffer) { state.lastCycleFrame = curFrame.frameBuffer; state.lastCycleBox = curFrame.boxes?.[0]; }

    // Only reject as static object when CLIP is NOT already confident about fire/smoke.
    // High-res streams can return near-identical frames across 3s windows even for real fire,
    // so inter-cycle diff=0 is unreliable when CLIP has already verified the scene.
    const clipConfident = verification.isReal && (verification.alertType === "Fire" || verification.alertType === "Smoke")
      && verification.reason !== "verification_error";
    if (verification.isReal && state.confirmedCycles >= 3 && interCycleRatio === 0 && !clipConfident) {
      log.warn({ id: camera.id, confirmedCycles: state.confirmedCycles }, "🚫 Zero inter-cycle change — static object");
      verification = { isReal: false, reason: "inter_cycle_static" };
    } else if (verification.isReal && state.confirmedCycles >= 3 && interCycleRatio === 0 && clipConfident) {
      log.info({ id: camera.id, confirmedCycles: state.confirmedCycles, alertType: verification.alertType }, "✅ Inter-cycle diff=0 but CLIP confirmed — trusting CLIP");
    } else if (interCycleRatio > INTER_CYCLE_THRESHOLD) {
      // Override CLIP if inter-cycle motion is unambiguous
      verification.isReal   = true;
      verification.reason   = "inter_cycle_confirmed";
    }
  }

  if (!verification.isReal) {
    log.warn({ id: camera.id, reason: verification.reason }, "🚫 Fire rejected");
    if (state.isFire && broadcastFireDetection) {
      broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
        event: state.lastAlertType === "Smoke" ? "Smoke Disappeared" : "Fire Disappeared",
        reason: verification.reason,
      });
    }
    state.isFire = false; state.confirmedCycles = 0; state.lastAlertType = null;
    await Promise.all([behavioralPromise, weaponPromise]);
    return;
  }

  // ── 5. Confirmed — broadcast alert ───────────────────────────────────────
  const alertType    = verification.alertType || "Fire";
  const wasFireBefore = state.isFire;
  state.isFire          = true;
  state.confirmedCycles = (state.confirmedCycles || 0) + 1;
  state.lastAlertType   = alertType;

  const bestFrame      = pickBestFrame(allDetected);
  const broadcastBoxes = allDetected.flatMap(f => f.boxes || []).slice(0, 10);
  const detectionEvent = !wasFireBefore
    ? (alertType === "Smoke" ? "Smoke is spreading through the area" : "Active fire detected in the scene")
    : null;

  log.error({ id: camera.id, alertType, event: detectionEvent }, "🚨 REAL FIRE CONFIRMED — broadcasting");

  if (broadcastFireDetection) {
    broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
      boxes: broadcastBoxes, alertType, event: detectionEvent,
      confidence: bestFrame?.confidence,
    });
  }

  // SNS + S3 (rate-limited)
  const now       = Date.now();
  const lastAlert = lastAlertSent.get(camera.id) || 0;
  if (now - lastAlert > ALERT_COOLDOWN_MS && bestFrame?.frameBuffer) {
    lastAlertSent.set(camera.id, now);
    try {
      const imageUrl = await uploadFireFrame(camera.id, bestFrame.frameBuffer, broadcastBoxes);
      await sendFireAlert(camera.userId, camera.id, camera.name, {
        isFire: true, detectionType: alertType, confidence: bestFrame.confidence,
      }, imageUrl);
      log.info("✅ SNS alert sent");
    } catch (err) {
      log.error({ err: err.message }, "❌ SNS/S3 alert failed");
    }
  }

  await Promise.all([behavioralPromise, weaponPromise]);
}

// ─── Per-camera async loop (runs independently per camera) ───────────────────
function startCameraLoop(camera) {
  if (cameraLoops.has(camera.id)) return; // already running
  const loop = { active: true };
  cameraLoops.set(camera.id, loop);
  const id = camera.id;

  // Main detection loop (fire + behavioral, every 3s)
  (async () => {
    log.info({ id, name: camera.name }, "▶️ Camera loop started");
    while (loop.active && isRunning) {
      const liveCamera = cameraRegistry.get(id);
      if (!liveCamera) break;
      try {
        await processCameraOnce(liveCamera);
      } catch (err) {
        log.warn({ id, err: err.message }, "❌ Cycle error");
      }
      if (loop.active && isRunning) await sleep(CYCLE_INTERVAL_MS);
    }
    cameraLoops.delete(id);
    log.info({ id }, "⏹ Camera loop stopped");
  })();

  // Fast person-detection loop (entry/exit tracking, every 1s)
  (async () => {
    while (loop.active && isRunning) {
      await sleep(FAST_PERSON_INTERVAL_MS);
      if (!loop.active || !isRunning) break;
      const liveCamera = cameraRegistry.get(id);
      if (!liveCamera) break;
      const state = cameraStates.get(id);
      if (!state) break;
      try {
        await runFastPersonCheck(liveCamera, state);
      } catch (err) {
        log.warn({ id, err: err.message }, "❌ Fast person check error");
      }
    }
  })();
}

function stopCameraLoop(cameraId) {
  const loop = cameraLoops.get(cameraId);
  if (loop) loop.active = false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function setBroadcastFunction(fn) {
  broadcastFireDetection = fn;
  log.info("✅ Broadcast function registered");
}

export function addCameraToQueue(camera) {
  if (cameraStates.has(camera.id)) {
    log.warn({ id: camera.id }, "Camera already in queue");
    return;
  }
  cameraRegistry.set(camera.id, camera);
  cameraStates.set(camera.id, initCameraState());
  cameraTrackers.set(camera.id, new ByteTracker());
  log.info({ id: camera.id, name: camera.name }, "📹 Camera added");

  if (isRunning) startCameraLoop(camera);
}

export function removeCameraFromQueue(id) {
  stopCameraLoop(id);
  cameraRegistry.delete(id);
  cameraStates.delete(id);
  cameraTrackers.delete(id);
  lastAlertSent.delete(id);
  log.info({ id }, "🗑 Camera removed");
}

export async function startDetectionQueue(cameras) {
  if (cameras.length > 0 && cameras[0].userId) currentUserId = cameras[0].userId;

  isRunning = true;

  for (const camera of cameras) {
    cameraRegistry.set(camera.id, camera);
    cameraStates.set(camera.id, initCameraState());
    cameraTrackers.set(camera.id, new ByteTracker());
  }

  // Start sidecar and wait for all models (VideoMAE-H + CLIP) to be ready
  // before starting detection loops — avoids false positives during model loading
  try {
    startSidecar();
    log.info("🧠 V-JEPA sidecar loading — waiting for models...");
    await waitSidecarReady(120000);
    log.info("✅ V-JEPA sidecar ready — starting detection loops");
  } catch (e) {
    log.warn({ err: e.message }, "⚠️ V-JEPA sidecar failed to start — detection will proceed without it");
  }

  if (!isRunning) return; // queue was stopped while waiting

  for (const camera of cameras) {
    startCameraLoop(camera);
  }

  log.info({ count: cameras.length }, "🚀 Detection started — cameras running in parallel");
}

export async function stopDetectionQueue() {
  log.info("🛑 Stopping detection queue");
  isRunning = false;

  // Stop all camera loops
  for (const [id, loop] of cameraLoops.entries()) loop.active = false;

  // Give loops a moment to exit, then clean up
  await sleep(500);
  cameraRegistry.clear();
  cameraStates.clear();
  cameraTrackers.clear();
  cameraLoops.clear();
  lastAlertSent.clear();
  currentUserId = null;
}

export function getQueueStatus() {
  const fireDetections = {}, lastChecked = {};
  for (const [id, state] of cameraStates.entries()) {
    fireDetections[id] = state.isFire;
    lastChecked[id]    = state.lastChecked;
  }
  return {
    isRunning,
    queueSize:    cameraStates.size,
    fireDetections,
    lastChecked,
  };
}

export function updateCameraInQueue(id, updates) {
  const cam = cameraRegistry.get(id);
  if (!cam) { log.warn({ id }, "updateCameraInQueue: camera not found"); return; }
  Object.assign(cam, updates);
  log.info({ id, updates }, "🔄 Camera updated — loop will use new values next cycle");
}

// Kept for API compatibility — sampling is handled by the backend now
export async function updateSamplingRate() {}

export async function handleFrontendDetection(userId, msg) {
  // Frontend detection events are logged only — backend is source of truth
  log.info({ userId, cameraId: msg.cameraId, boxCount: msg.boxes?.length }, "📡 Frontend detection received (log only)");
}
