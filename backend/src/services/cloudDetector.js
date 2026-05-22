import fetch from "node-fetch";
import { makeLogger } from "../logger.js";
import { grabMultipleFrames } from "./localDetector.js";

const log = makeLogger("cloud-detector");

// ===================================================================
// ☁️ POST Frame to AWS Fire Detection Endpoint
// ===================================================================
async function postToFireEndpoint(cameraName, jpegBuffer) {
  try {
    const response = await fetch(cfg.fireEndpoint, {
      method: "POST",
      headers: { 
        "Content-Type": "image/jpeg",
        "camera-id": cameraName 
      },
      body: jpegBuffer,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`${response.status} ${errorText}`);
    }

    const result = await response.json().catch(() => ({}));
    
    log.debug({ 
      camera: cameraName, 
      fireDetected: result.fire_detected || result.isFire || false 
    }, "Cloud detection response received");

    return result;
  } catch (error) {
    log.error({ 
      camera: cameraName, 
      error: error.message 
    }, "Failed to POST to fire endpoint");
    throw error;
  }
}

// ===================================================================
// 🧮 Calculate IoU (Intersection over Union) for Bounding Boxes
// ===================================================================
function calculateIoU(box1, box2) {
  if (!box1 || !box2) return 0;

  // box format: [x1, y1, x2, y2, label, confidence]
  const x1 = Math.max(box1[0], box2[0]);
  const y1 = Math.max(box1[1], box2[1]);
  const x2 = Math.min(box1[2], box2[2]);
  const y2 = Math.min(box1[3], box2[3]);

  const intersectionWidth = Math.max(0, x2 - x1);
  const intersectionHeight = Math.max(0, y2 - y1);
  const intersectionArea = intersectionWidth * intersectionHeight;

  const box1Area = Math.max(0, box1[2] - box1[0]) * Math.max(0, box1[3] - box1[1]);
  const box2Area = Math.max(0, box2[2] - box2[0]) * Math.max(0, box2[3] - box2[1]);
  const unionArea = box1Area + box2Area - intersectionArea;

  return unionArea <= 0 ? 0 : intersectionArea / unionArea;
}

// ===================================================================
// 🔥 Main Cloud Detection Function (3-Frame Static Fire Detection)
// ===================================================================
export async function detectFireCloud(cameraUrl, cameraName) {
  const FRAME_COUNT = 3;
  const FRAME_DELAY_MS = 500; // 500ms between frames
  const IOU_THRESHOLD = 0.8; // If IoU > 0.8, boxes are static (not real fire)

  try {
    log.info({ camera: cameraName }, "🌥️ Starting cloud detection (3 frames)");

    // ===================================================================
    // STEP 1: Grab 3 frames from a SINGLE ffmpeg connection
    // This fixes the keyframe/GOP bug where separate connections
    // always start at the same I-frame, producing identical images.
    // ===================================================================
    const frames = await grabMultipleFrames(cameraUrl, FRAME_COUNT);
    const results = [];

    if (frames.length === 0) {
      throw new Error("No frames extracted from camera");
    }

    log.debug({ camera: cameraName, framesExtracted: frames.length }, "Frames captured via single connection");

    // ===================================================================
    // STEP 2: Send each frame to AWS endpoint
    // ===================================================================
    for (let i = 0; i < frames.length; i++) {
      try {
        const result = await postToFireEndpoint(cameraName, frames[i]);
        results.push(result);
        
        log.debug({ 
          camera: cameraName, 
          frame: i + 1,
          fireDetected: result.fire_detected || result.isFire || false
        }, "Cloud detection result");
      } catch (error) {
        log.error({ 
          camera: cameraName, 
          frame: i + 1, 
          error: error.message 
        }, "Failed to get cloud detection result");
        throw error;
      }
    }

    // ===================================================================
    // STEP 3: Check if ANY frame detected fire
    // ===================================================================
    const fireDetectedInAnyFrame = results.some(r => r.fire_detected || r.isFire);

    if (!fireDetectedInAnyFrame) {
      log.info({ camera: cameraName }, "✅ No fire detected in any frame");
      return {
        isFire: false,
        confidence: 0,
        reason: "no_fire_detected",
        frames: results
      };
    }

    // ===================================================================
    // STEP 4: Static Fire Detection (IoU Analysis)
    // ===================================================================
    // Extract bounding boxes from results (if available)
    const boxes = results.map(r => r.boxes || r.detections || []);

    // Check if we have boxes to compare
    if (boxes[0]?.length > 0 && boxes[1]?.length > 0 && boxes[2]?.length > 0) {
      // Compare first detection box across frames
      const box1 = boxes[0][0]; // First box from frame 1
      const box2 = boxes[1][0]; // First box from frame 2
      const box3 = boxes[2][0]; // First box from frame 3

      const iou12 = calculateIoU(box1, box2);
      const iou23 = calculateIoU(box2, box3);
      const avgIoU = (iou12 + iou23) / 2;

      log.debug({ 
        camera: cameraName, 
        iou12, 
        iou23, 
        avgIoU,
        threshold: IOU_THRESHOLD
      }, "IoU analysis");

      // If boxes are too similar (high IoU), it's likely a static image
      if (avgIoU > IOU_THRESHOLD) {
        log.warn({ 
          camera: cameraName, 
          avgIoU 
        }, "⚠️ STATIC FIRE DETECTED (bounding boxes not moving)");
        
        return {
          isFire: false,
          confidence: 0,
          reason: "static_fire",
          iouAnalysis: {
            iou12,
            iou23,
            avgIoU,
            threshold: IOU_THRESHOLD
          },
          frames: results
        };
      }
    }

    // ===================================================================
    // STEP 5: Real Fire Detected
    // ===================================================================
    log.warn({ camera: cameraName }, "🔥 REAL FIRE DETECTED");

    return {
      isFire: true,
      confidence: results[0]?.confidence || 0.9,
      reason: "fire_detected",
      frames: results,
      iouAnalysis: boxes[0]?.length > 0 ? {
        iou12: boxes[0]?.length > 0 && boxes[1]?.length > 0 ? calculateIoU(boxes[0][0], boxes[1][0]) : 0,
        iou23: boxes[1]?.length > 0 && boxes[2]?.length > 0 ? calculateIoU(boxes[1][0], boxes[2][0]) : 0,
        threshold: IOU_THRESHOLD
      } : null
    };

  } catch (error) {
    log.error({ 
      camera: cameraName, 
      error: error.message 
    }, "❌ Cloud detection failed");
    
    return {
      isFire: false,
      confidence: 0,
      error: error.message,
      reason: "detection_error"
    };
  }
}

// ===================================================================
// 📋 Export for use in detectionQueue
// ===================================================================
export default {
  detectFireCloud
};
