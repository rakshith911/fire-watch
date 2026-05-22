import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectFireMultiModelFrame, buildCameraUrl, grabFrameOnce } from "./localDetector.js";
import { detectFireMultiFrameYolo } from "./localYoloDetector.js";
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
  getTemporalVariance,
} from "./vjepaSidecar.js";
import { cropLargestPerson } from "./personDetector.js";
import { detectMaskYolo, detectWeaponYolo } from "./localYoloDetector.js";
import { getLargestPersonPose } from "./poseDetector.js";
import { ByteTracker } from "./byteTracker.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("detection-queue");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ──────────────────────────────────────────────────────────────
const CYCLE_INTERVAL_MS          = 1000;   // pause between full cycles per camera
const FRAMES_PER_CYCLE           = 3;      // frames grabbed in each initial check
const RECHECK_COUNT              = 2;      // immediate rechecks after initial fire detection
const CONFIRM_THRESHOLD          = 2;      // checks that must confirm out of (1 + RECHECK_COUNT)
const BOX_MOVE_IOU_THRESHOLD     = 0.70;   // IOU below this = bbox moved significantly (multi-check gate)
const BBOX_STABLE_IOU_THRESH     = 0.98;   // consecutive pairs must be near-identical to count as stable (any small shift = not static)
const PIXEL_MOTION_STATIC_THRESH = 0.08;   // fire-crop pixel motion below this = essentially no movement
const PIXEL_MOTION_SUSPICIOUS    = 0.20;   // below this = phone-screen / very low motion range
const PIXEL_MOTION_REAL_THRESH   = 0.20;   // strong flame-region motion = active dynamic fire signal
const CENTER_DISP_STATIC_THRESH  = 0.01;   // bbox center moved < 1% of bbox diagonal = static signal (was 5% — lowered so small movement is enough)
const CENTER_DISP_REAL_THRESH    = 0.10;   // significant bbox-center movement = dynamic fire signal
const INTER_CYCLE_THRESHOLD      = 0.04;   // inter-cycle pixel diff for long-GOP cameras
const INTER_CYCLE_STATIC_THRESH  = 0.005;  // inter-cycle ratio below this = effectively no change
const BEHAVIORAL_COOLDOWN_MS     = 30_000; // min ms between same behavioral label per camera
const ALERT_COOLDOWN_MS          = 60_000; // min ms between SNS/S3 alerts per camera
const FAST_PERSON_INTERVAL_MS    = 1_000;  // fast person-detection loop interval
const PERSON_CLEAR_DELAY_MS      = 5_000;  // ms after person leaves before clearing label

// Reasons that should set staticRejectedUntil cooldown
const STATIC_REJECT_REASONS = new Set([
  "clip_static_photo", "clip_screen_video",
  "multi_static_signal", "inter_cycle_static",
  "static_sidecar_error", "clip_no_fire_suspicious",
]);

const missingFireModelsLogged = new Set();

function getModelsDir() {
  return process.env.MODELS_DIR_OVERRIDE || path.resolve(__dirname, "../../models");
}

function fireModelForAiType() {
  return "best.onnx";
}

function getFireModelFiles(aiType) {
  const modelFile = fireModelForAiType(aiType);
  const modelsDir = getModelsDir();
  const exists = fs.existsSync(path.join(modelsDir, modelFile));
  if (!exists && !missingFireModelsLogged.has(modelFile)) {
    missingFireModelsLogged.add(modelFile);
    log.warn({ modelFile, modelsDir }, "⚠️ Fire model missing — falling back to best.onnx");
    return ["best.onnx"];
  }
  return [modelFile];
}

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

// CLIP prompts — three frames are tiled side-by-side (start / mid / end of clip).
// Prompts explicitly reference the tiled composite so CLIP can use temporal change
// (or lack thereof) as a classification signal.
const FIRE_VERIFY_PROMPTS = [
  "three frames of real fire burning: flame shapes and brightness are visibly different between panels showing actual movement",
  "three frames of thick dark smoke spreading and rising: the smoke position and density changes across the three panels",
  "three nearly identical frames of a static fire photograph or printed image on a flat surface — no change between panels",
  "three nearly identical frames of a phone, tablet, or screen displaying a fire image — glowing flat panel, scene does not change",
  "three frames of a completely normal room or scene with no fire smoke or heat visible",
];
const FIRE_VERIFY_LABELS = ["fire", "smoke", "static_photo", "screen_video", "no_fire"];

const MASK_ALERT_THRESHOLD = 0.75;
const MASK_CONFIRM_FRAMES = 2;

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
    lastPersonCycle:     0,   // consecutive cycles with person present; 0 = absent last cycle
    // Weapon tracking (for box-clear when weapon disappears)
    isWeapon:            false,
    weaponMissStreak:    0,    // consecutive cycles without weapon; clear after 2
    isMask:              false,
    maskConfirmStreak:   0,
    maskMissStreak:      0,
    // Static/screen rejection cooldown — require real bbox motion to re-confirm
    staticRejectedUntil: 0,
  };
}

// ─── Fire verification — 4 cascading layers ──────────────────────────────────
//
//  Layer 1 (caller): bbox stability across all consecutive frame pairs
//  Layer 2 (caller): pixel motion in the fire crop region (livenessValidator)
//  Layer 3 (here):   V-JEPA temporal variance — do the actual frames change?
//  Layer 4 (here):   CLIP semantic classification (always runs, threshold adjusts)
//
//  signals = { pixelMotion, bboxStable, centerDisplacement }
async function verifyFireWithClip(fireFrames, cameraId, signals = {}) {
  const { pixelMotion = 0, bboxStable = false, centerDisplacement = 0 } = signals;
  const framesB64 = fireFrames.filter(f => f.frameBuffer).map(f => f.frameBuffer.toString("base64"));

  if (framesB64.length === 0) return { isReal: true, alertType: "Fire", reason: "no_frames" };

  // ── Count pre-CLIP static evidence ──────────────────────────────────────────
  // Each signal is independently strong — a static image reliably shows all three.
  let staticSignals = 0;
  if (pixelMotion < PIXEL_MOTION_STATIC_THRESH) staticSignals++;  // fire crop pixels not changing
  if (bboxStable)                               staticSignals++;  // detection box didn't move
  if (centerDisplacement < CENTER_DISP_STATIC_THRESH) staticSignals++; // bbox center moved < 5% of diagonal

  log.info({ cameraId, pixelMotion: pixelMotion.toFixed(4), bboxStable, centerDisplacement: centerDisplacement.toFixed(4), staticSignals },
    "📊 Pre-CLIP liveness signals");

  // All 3 pixel/bbox signals agree → very high confidence static image, skip CLIP
  if (staticSignals === 3) {
    log.warn({ cameraId }, "🖼️ All 3 motion signals indicate static — rejecting before CLIP");
    return { isReal: false, reason: "multi_static_signal" };
  }

  // ── Layer 3: V-JEPA temporal variance ─────────────────────────────────────
  // Ask VideoMAE: are the first-half and second-half of this clip similar?
  // Static image → embeddings nearly identical → is_static = true.
  // Real fire → flames evolve between halves → is_static = false.
  let jepaStatic = false;
  try {
    const jepa = await getTemporalVariance(framesB64);
    jepaStatic = jepa.is_static ?? false;
    if (jepaStatic) staticSignals++;
    log.info({ cameraId, temporal_similarity: jepa.temporal_similarity, jepaStatic, staticSignals },
      "🎥 V-JEPA temporal variance");
  } catch (jepaErr) {
    log.warn({ err: jepaErr.message }, "⚠️ V-JEPA temporal variance unavailable");
  }

  // 3+ signals including V-JEPA → strong static rejection before CLIP
  if (staticSignals >= 3) {
    log.warn({ cameraId, staticSignals }, "🖼️ 3+ signals (incl. V-JEPA) indicate static — rejecting before CLIP");
    return { isReal: false, reason: "multi_static_signal" };
  }

  // ── Layer 4: CLIP semantic classification (always runs) ──────────────────
  try {
    const clip = await classifySequenceWithClip(framesB64, FIRE_VERIFY_PROMPTS, FIRE_VERIFY_LABELS);
    log.info({ cameraId, label: clip.label, prob: clip.top_prob?.toFixed(3), staticSignals },
      "🔍 CLIP fire verification");

    if (clip.label === "static_photo" || clip.label === "screen_video") {
      const strongMotionEvidence =
        pixelMotion >= PIXEL_MOTION_REAL_THRESH &&
        !jepaStatic &&
        (!bboxStable || centerDisplacement >= CENTER_DISP_REAL_THRESH);

      if (strongMotionEvidence) {
        log.info({
          cameraId,
          label: clip.label,
          pixelMotion: pixelMotion.toFixed(4),
          temporalStatic: jepaStatic,
          centerDisplacement: centerDisplacement.toFixed(4),
        }, "🔥 Strong liveness evidence overrides CLIP static/screen label");
        return { isReal: true, alertType: "Fire", reason: "motion_overrode_clip_static" };
      }

      return { isReal: false, reason: `clip_${clip.label}`, prob: clip.top_prob };
    }

    // With 2+ suspicious signals: no_fire label at any confidence is enough to reject.
    // Real fire CLIP confidence is often 0.38-0.58 — never reject based on low prob alone.
    if (staticSignals >= 2 && clip.label === "no_fire") {
      return { isReal: false, reason: "clip_no_fire_suspicious", prob: clip.top_prob };
    }
    // Normal case: only reject on no_fire with > 0.50 confidence
    if (clip.label === "no_fire" && clip.top_prob > 0.50) {
      return { isReal: false, reason: "clip_no_fire", prob: clip.top_prob };
    }

    const alertType = clip.label === "smoke" ? "Smoke" : "Fire";
    return { isReal: true, alertType };

  } catch (err) {
    // Sidecar failure — fall back to static signals if we have 2+
    if (staticSignals >= 2) {
      log.warn({ cameraId, staticSignals }, "⚠️ CLIP failed with 2+ static signals — rejecting");
      return { isReal: false, reason: "static_sidecar_error" };
    }
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
      state.weaponMissStreak = (state.weaponMissStreak ?? 0) + 1;
      // Require 2 consecutive misses before declaring weapon gone (avoids false clears on single bad frame)
      if (state.isWeapon && state.weaponMissStreak >= 2) {
        state.isWeapon = false;
        state.weaponMissStreak = 0;
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
    state.weaponMissStreak = 0;
    const now      = Date.now();
    const lastSent = state.clipCooldowns["weapon"] || 0;
    const label    = result.boxes[0]?.[4] || "Knife";

    if (now - lastSent < WEAPON_COOLDOWN_MS) {
      // Within cooldown — still push fresh boxes so they track the weapon's position
      if (broadcastFireDetection) {
        broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
          boxes:        result.boxes,
          alertType:    label,
          confidence:   result.confidence,
          isBehavioral: true,
        });
      }
      return;
    }

    state.clipCooldowns["weapon"] = now;
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

    const [posePerson, personFallback] = await Promise.all([
      getLargestPersonPose(refFrame).catch(() => null),
      cropLargestPerson(refFrame).catch(() => null),
    ]);
    cropBox = posePerson?.box ?? personFallback?.box ?? null;

    let personCropsB64 = [];
    let detectedBoxes  = [];

    if (cropBox) {
      const [bx1, by1, bx2, by2] = cropBox;
      let fw = 640, fh = 480;
      try { const m = await sharp(refFrame).metadata(); fw = m.width; fh = m.height; } catch {}

      // Entry-zone gate: only run behavioral CLIP when person is near an entry point.
      // Heuristic: person centre must be in the bottom 55% of the frame OR within 30% of either side.
      // This prevents "random person in middle of room" from triggering the pipeline.
      const cy = (by1 + by2) / 2;
      const cx = (bx1 + bx2) / 2;
      const inEntryZone = cy > fh * 0.45 || cx < fw * 0.30 || cx > fw * 0.70;
      if (!inEntryZone) {
        log.info({ cameraId: camera.id, cy, cx, fw, fh }, "👤 Person outside entry zone — skipping behavioral pipeline");
        // Clear any stale person boxes from a previous entry-zone detection
        if (broadcastFireDetection && state.isWeapon === false) {
          broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
            boxes: [], reason: "person_outside_zone",
          });
        }
        return;
      }

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
        // detectedBoxes intentionally left empty — person crop boxes from backend go stale
        // and appear frozen when person moves. Weapon boxes come from runWeaponPipeline.
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

    const personDetected = personCropsB64.length > 0;

    // Tier 2: V-JEPA temporal gate.
    // When a person is in frame, pass isThreat=true so the baseline only learns
    // from empty-room cycles — preventing "person present" from becoming "normal".
    const anomaly = await getAnomalyScore(vjepaFrames, String(camera.id), personDetected).catch(() => null);

    // A person arriving after being absent = "new arrival" — always worth classifying
    // regardless of anomaly score, since the baseline doesn't capture arrivals.
    const isNewArrival = personDetected && (state.lastPersonCycle ?? 0) === 0;

    // Update consecutive-presence counter so the next cycle knows if this was an arrival.
    state.lastPersonCycle = personDetected ? (state.lastPersonCycle ?? 0) + 1 : 0;

    log.info({
      cameraId:       camera.id,
      anomalyScore:   anomaly?.anomaly_score ?? null,
      trigger:        anomaly?.anomaly_trigger ?? null,
      baselineReady:  anomaly?.baseline_ready ?? null,
      samples:        anomaly?.baseline_samples ?? null,
      inferenceMs:    anomaly?.inference_ms ?? null,
      usingCrops:     personDetected,
      isNewArrival,
      lastPersonCycle: state.lastPersonCycle,
    }, "🧠 V-JEPA anomaly gate");

    // Dedicated mask detector. Keep this out of CLIP: mask/no-mask is a visual
    // object-detection task and should not rely on vague scene captions.
    if (personDetected) {
      try {
        const maskResult = await detectMaskYolo(cameraUrl, camera.name, refFrame);
        const rawMaskLabel = maskResult.boxes[0]?.[4] || null;
        const maskLabel = rawMaskLabel === "mask_weared_incorrect"
          ? "Suspicious — person wearing a mask incorrectly"
          : rawMaskLabel === "with_mask"
            ? "Suspicious — person wearing a face mask"
            : null;

        log.info({
          cameraId: camera.id,
          maskLabel,
          rawMaskLabel,
          confidence: maskResult.confidence,
          boxes: maskResult.boxes.length,
        }, maskLabel ? "🎭 Dedicated mask detector produced label" : "🎭 Dedicated mask detector clear");

        const maskConfirmed = !!maskLabel && maskResult.confidence >= MASK_ALERT_THRESHOLD;
        state.maskConfirmStreak = maskConfirmed ? (state.maskConfirmStreak || 0) + 1 : 0;

        if (maskConfirmed) {
          state.maskMissStreak = 0;

          if (state.maskConfirmStreak >= MASK_CONFIRM_FRAMES) {
            state.isMask = true;
            const now = Date.now();
            const lastSent = state.clipCooldowns[maskLabel] || 0;
            if (now - lastSent > BEHAVIORAL_COOLDOWN_MS) {
              state.clipCooldowns[maskLabel] = now;
              log.info({
                cameraId: camera.id,
                label: maskLabel,
                confidence: maskResult.confidence,
                confirmStreak: state.maskConfirmStreak,
              }, "🎭 Mask detection broadcast");
              if (broadcastFireDetection) {
                broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
                  boxes:        maskResult.boxes,
                  alertType:    maskLabel,
                  event:        maskLabel,
                  clipLabel:    maskLabel,
                  confidence:   maskResult.confidence,
                  isBehavioral: true,
                });
              }
            } else if (broadcastFireDetection) {
              broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
                boxes:        maskResult.boxes,
                alertType:    maskLabel,
                clipLabel:    maskLabel,
                confidence:   maskResult.confidence,
                isBehavioral: true,
              });
            }
          }
        } else if (maskLabel) {
          log.info({
            cameraId: camera.id,
            label: maskLabel,
            confidence: maskResult.confidence,
            threshold: MASK_ALERT_THRESHOLD,
            confirmStreak: state.maskConfirmStreak,
          }, "🎭 Mask label below confirmation gate — not broadcasting");
          state.maskMissStreak = (state.maskMissStreak || 0) + 1;
        } else {
          state.maskMissStreak = (state.maskMissStreak || 0) + 1;
        }

        if (state.isMask && state.maskMissStreak >= MASK_CONFIRM_FRAMES) {
          state.isMask = false;
          state.maskMissStreak = 0;
          log.info({ cameraId: camera.id }, "🎭 Mask gone — clearing mask label and boxes");
          if (broadcastFireDetection) {
            broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
              boxes: [],
              reason: "mask_gone",
              isBehavioral: true,
            });
          }
        }
      } catch (err) {
        log.warn({ cameraId: camera.id, err: err.message }, "⚠️ Mask check failed");
      }
    } else {
      if (state.isMask && broadcastFireDetection) {
        log.info({ cameraId: camera.id }, "🎭 Person gone — clearing mask label and boxes");
        broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
          boxes: [],
          reason: "mask_gone",
          isBehavioral: true,
        });
      }
      state.isMask = false;
      state.maskConfirmStreak = 0;
      state.maskMissStreak = 0;
    }

    // Only run CLIP when the person just entered — not while they're standing around.
    if (!isNewArrival) {
      log.info({
        cameraId: camera.id,
        score:    anomaly?.anomaly_score ?? null,
        samples:  anomaly?.baseline_samples ?? null,
      }, "🧠 Person present but not new arrival — skipping CLIP");
      return;
    }

    log.info({ cameraId: camera.id }, "🚶 New arrival — running CLIP");

    // Tier 3: CLIP sequence classification
    const clipResult = await classifySequenceWithClip(vjepaFrames);
    const clipLabel  = clipResult.label;  // null means CLIP said "nothing alertable" — trust it
    log.info({
      cameraId: camera.id,
      clipLabel,
      prob:     clipResult.top_prob,
      inferMs:  clipResult.inference_ms,
    }, clipLabel ? "🎯 CLIP label produced" : "🎯 CLIP: no label (screen/redirected/normal — suppressed)");

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
          state.lastPersonCycle   = 0;  // reset so next appearance is treated as new arrival
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

// ─── Mask pipeline (mask_yolov5.onnx, every cycle, mask-only mode) ───────────
async function runMaskPipeline(camera, state, cameraUrl) {
  try {
    const result = await detectMaskYolo(cameraUrl, camera.name);
    if (!result || result.transientReadError) return;

    if (!result.isMask || result.boxes.length === 0) {
      state.maskMissStreak = (state.maskMissStreak || 0) + 1;
      if (state.isMask && state.maskMissStreak >= MASK_CONFIRM_FRAMES) {
        state.isMask = false;
        state.maskMissStreak = 0;
        state.maskConfirmStreak = 0;
        log.info({ cameraId: camera.id }, "🎭 Mask gone — clearing boxes");
        if (broadcastFireDetection) {
          broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
            boxes: [], reason: "mask_gone", isBehavioral: true,
          });
        }
      }
      return;
    }

    const rawLabel = result.boxes[0]?.[4] || null;
    const maskLabel = rawLabel === "mask_weared_incorrect"
      ? "Suspicious — person wearing a mask incorrectly"
      : rawLabel === "with_mask"
        ? "Suspicious — person wearing a face mask"
        : null;

    if (!maskLabel) return;

    const confirmed = result.confidence >= MASK_ALERT_THRESHOLD;
    state.maskConfirmStreak = confirmed ? (state.maskConfirmStreak || 0) + 1 : 0;
    if (!confirmed) {
      state.maskMissStreak = (state.maskMissStreak || 0) + 1;
      return;
    }

    state.maskMissStreak = 0;
    if (state.maskConfirmStreak < MASK_CONFIRM_FRAMES) return;

    state.isMask = true;
    const now = Date.now();
    const lastSent = state.clipCooldowns[maskLabel] || 0;
    const isNewAlert = now - lastSent > BEHAVIORAL_COOLDOWN_MS;
    if (isNewAlert) state.clipCooldowns[maskLabel] = now;

    log.info({ cameraId: camera.id, maskLabel, confidence: result.confidence }, "🎭 Mask pipeline broadcast");

    if (broadcastFireDetection) {
      broadcastFireDetection(camera.userId, camera.id, camera.name, true, {
        boxes:        result.boxes,
        alertType:    maskLabel,
        event:        isNewAlert ? maskLabel : undefined,
        clipLabel:    maskLabel,
        confidence:   result.confidence,
        isBehavioral: true,
      });
    }
  } catch (err) {
    log.warn({ cameraId: camera.id, err: err.message }, "⚠️ Mask pipeline error");
  }
}

// ─── Main per-camera detection cycle ─────────────────────────────────────────
async function processCameraOnce(camera) {
  const state = cameraStates.get(camera.id);
  if (!state) return;

  const cameraUrl = getCameraUrl(camera);
  state.lastChecked  = new Date().toISOString();
  state.totalCycles  = (state.totalCycles || 0) + 1;
  const aiType = camera.aiType || "FIRE";
  log.info({ id: camera.id, name: camera.name, cycle: state.totalCycles, aiType }, "🔄 Camera cycle start");

  // Non-fire modes skip the fire pipeline entirely and run their dedicated pipeline.
  if (aiType === "WEAPON" || aiType === "WEAPON_YOLO") {
    await runWeaponPipeline(camera, state, cameraUrl);
    return;
  }
  if (aiType === "MASK") {
    await runMaskPipeline(camera, state, cameraUrl);
    return;
  }

  // ── 1. Initial frame grab (3 frames) + YOLO ─────────────────────────────
  let frames = [];
  const fireModelFiles = getFireModelFiles(aiType);
  try {
    frames = await detectFireMultiModelFrame(cameraUrl, camera.name, FRAMES_PER_CYCLE, fireModelFiles);
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

  // Fire mode only: behavioral and weapon pipelines run in their own aiType modes.
  const behavioralPromise = Promise.resolve();
  const weaponPromise     = Promise.resolve();

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

  // ── 2. Multi-check: 2 immediate quick rechecks (run in parallel) ─────────
  // Need 2/3 to confirm — OR ByteTracker shows significant bbox movement.
  let checksConfirmed = 1; // initial check passed
  const recheckFrames = [];

  const recheckResults = await Promise.allSettled(
    Array.from({ length: RECHECK_COUNT }, () =>
      detectFireMultiModelFrame(cameraUrl, camera.name, 1, fireModelFiles)
    )
  );
  for (const r of recheckResults) {
    if (r.status !== "fulfilled") continue;
    const qf = r.value[0];
    if (qf && !qf.transientReadError) {
      tracker.update(qf.boxes || []);
      recheckFrames.push(qf);
      if (qf.isFire && qf.boxes?.length > 0) checksConfirmed++;
    }
  }

  // ── Layer 1: Bbox stability across ALL consecutive frame pairs ───────────────
  // Compare every consecutive pair in allDetected, not just first vs last.
  // Real fire: at least one pair has IoU < BBOX_STABLE_IOU_THRESH (flames shift).
  // Static image: every pair is nearly identical (YOLO variance only) → bboxStable = true.
  const allDetected = [...initialFireFrames, ...recheckFrames.filter(f => f.isFire && f.boxes?.length > 0)];
  let bboxStable = true;
  let bboxMoved  = false; // first-vs-last IoU movement signal
  if (allDetected.length >= 2) {
    const firstLastIoU = computeIoU(allDetected[0].boxes[0], allDetected[allDetected.length - 1].boxes[0]);
    bboxMoved = firstLastIoU < BOX_MOVE_IOU_THRESHOLD;
    // Check every consecutive pair for the strict stability signal
    for (let i = 0; i < allDetected.length - 1; i++) {
      if (computeIoU(allDetected[i].boxes[0], allDetected[i + 1].boxes[0]) < BBOX_STABLE_IOU_THRESH) {
        bboxStable = false; break;
      }
    }
  }

  // Normalized bbox-center displacement (first → last frame), relative to bbox diagonal.
  // Quantifies how far the fire region moved across the cycle, independent of IoU.
  let centerDisplacement = 0;
  if (allDetected.length >= 2) {
    const f0 = allDetected[0].boxes[0], fN = allDetected[allDetected.length - 1].boxes[0];
    const cx1 = (f0[0] + f0[2]) / 2, cy1 = (f0[1] + f0[3]) / 2;
    const cx2 = (fN[0] + fN[2]) / 2, cy2 = (fN[1] + fN[3]) / 2;
    const avgW = ((f0[2] - f0[0]) + (fN[2] - fN[0])) / 2;
    const avgH = ((f0[3] - f0[1]) + (fN[3] - fN[1])) / 2;
    const diag = Math.sqrt(avgW * avgW + avgH * avgH) || 1;
    centerDisplacement = Math.sqrt((cx2 - cx1) ** 2 + (cy2 - cy1) ** 2) / diag;
  }

  const confirmedTracks  = tracker.getConfirmedTracks();
  const inStaticCooldown = (state.staticRejectedUntil ?? 0) > Date.now();
  const multiCheckPassed = checksConfirmed >= CONFIRM_THRESHOLD || bboxMoved;

  log.info({
    id: camera.id, checksConfirmed, bboxMoved, bboxStable,
    centerDisp: centerDisplacement.toFixed(4),
    confirmedTracks: confirmedTracks.length, passed: multiCheckPassed, inStaticCooldown,
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

  // ── Layer 2: Pixel liveness in fire crop region ───────────────────────────
  // isFireMoving crops the fire bbox from all frames and measures per-pixel change.
  // Phone screens:   0.05-0.14 (subtle frame-to-frame variation)
  // Real fire:       0.20-0.50+ (flames visibly flicker)
  // Static photo:    0.00-0.05 (near-zero change)
  // Strong local motion is enough to restore an active fire immediately.
  // Static/paused fire stays near zero and still goes through the static checks.
  let pixelMotion = 0;
  try {
    const bufs = allDetected.filter(f => f.frameBuffer).map(f => f.frameBuffer);
    const boxs = allDetected.filter(f => f.frameBuffer).map(f => f.boxes[0]);
    if (bufs.length >= 3) pixelMotion = await livenessValidator.isFireMoving(bufs, boxs);
  } catch {}

  let interCycleRatio = 0;
  const curFrame = allDetected[allDetected.length - 1];
  if (state.lastCycleFrame && curFrame?.frameBuffer && curFrame?.boxes?.[0]) {
    try {
      interCycleRatio = await livenessValidator.compareInterCycle(
        state.lastCycleFrame, curFrame.frameBuffer, curFrame.boxes[0]
      );
    } catch {}
  }
  if (curFrame?.frameBuffer) {
    state.lastCycleFrame = curFrame.frameBuffer;
    state.lastCycleBox   = curFrame.boxes?.[0];
  }

  const interCycleMotion = interCycleRatio > INTER_CYCLE_THRESHOLD;

  // Fire liveness is intentionally simple and fast:
  // YOLO fire + motion = active fire. YOLO fire + no motion = static fire image/video.
  // V-JEPA/CLIP are not used here because fire alerts must recover immediately when motion resumes.
  const hasMotion = pixelMotion >= PIXEL_MOTION_REAL_THRESH || interCycleMotion;
  const verification = hasMotion
    ? {
        isReal: true,
        alertType: "Fire",
        reason: pixelMotion >= PIXEL_MOTION_REAL_THRESH ? "pixel_motion_confirmed" : "inter_cycle_confirmed",
      }
    : { isReal: false, reason: "multi_static_signal" };

  log.info({
    id: camera.id,
    decision: verification.isReal ? "active_fire" : "static_fire",
    reason: verification.reason,
    pixelMotion: pixelMotion.toFixed(4),
    interCycleRatio: interCycleRatio.toFixed(4),
    bboxStable,
    centerDisplacement: centerDisplacement.toFixed(4),
  }, "🔥 Fire motion decision");

  if (verification.isReal) {
    state.staticRejectedUntil = 0;
  }

  if (!verification.isReal) {
    log.warn({ id: camera.id, reason: verification.reason }, "🚫 Fire rejected");
    if (STATIC_REJECT_REASONS.has(verification.reason)) {
      state.staticRejectedUntil = 0;
      log.info({ id: camera.id, reason: verification.reason }, "🖼️ Static fire detected — waiting for motion");
    }
    if (broadcastFireDetection && (state.isFire || STATIC_REJECT_REASONS.has(verification.reason))) {
      broadcastFireDetection(camera.userId, camera.id, camera.name, false, {
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
  const broadcastBoxes = bestFrame?.boxes || [];
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

  // SNS + optional S3 image (rate-limited). SNS must not depend on S3 success.
  const now       = Date.now();
  const lastAlert = lastAlertSent.get(camera.id) || 0;
  if (now - lastAlert > ALERT_COOLDOWN_MS) {
    let imageUrl = null;
    if (bestFrame?.frameBuffer) {
      try {
        imageUrl = await uploadFireFrame(camera.id, bestFrame.frameBuffer, broadcastBoxes);
      } catch (err) {
        log.error({ id: camera.id, err: err.message }, "❌ S3 upload failed — sending SNS without image");
      }
    } else {
      log.warn({ id: camera.id }, "⚠️ No best frame available — sending SNS without image");
    }

    try {
      await sendFireAlert(camera.userId, camera.id, camera.name, {
        isFire: true,
        detectionType: alertType,
        confidence: bestFrame?.confidence,
        boxes: broadcastBoxes,
      }, imageUrl);
      lastAlertSent.set(camera.id, now);
      log.info({ id: camera.id, alertType, imageAttached: !!imageUrl }, "✅ SNS alert sent");
    } catch (err) {
      log.error({ id: camera.id, err: err.message }, "❌ SNS alert failed");
    }
  } else {
    log.info({
      id: camera.id,
      remainingMs: ALERT_COOLDOWN_MS - (now - lastAlert),
    }, "⏳ SNS alert skipped by cooldown");
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
    if (cameraLoops.get(id) === loop) cameraLoops.delete(id);
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
  if (loop) {
    loop.active = false;
    cameraLoops.delete(cameraId); // delete immediately so startCameraLoop can restart on re-add
  }
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
