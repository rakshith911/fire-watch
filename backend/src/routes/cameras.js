import { Router } from "express";
import { dynamodb } from "../db/dynamodb.js";
import { cfg } from "../config.js";
import {
  addCameraToQueue,
  removeCameraFromQueue,
  getQueueStatus,
  updateCameraInQueue, // ⬅️ IMPORTANT: import this
} from "../services/detectionQueue.js";

import {
  detectServerIP,
  sanitizePathName,
} from "../services/mediamtxConfigGenerator.js";
import { startMediaMTX, stopMediaMTX } from "../services/mediamtx.js";
import { makeLogger } from "../logger.js";

export const cameras = Router();
const log = makeLogger("camera-routes");

async function restartMediaMTXForUser(userId, reason) {
  try {
    log.info({ userId, reason }, "Regenerating MediaMTX config");
    await stopMediaMTX();
    await startMediaMTX(userId);
    log.info({ userId, reason }, "MediaMTX restarted with updated camera config");
  } catch (err) {
    log.error({ userId, reason, err: err.message }, "Failed to restart MediaMTX");
  }
}

// Create camera
cameras.post("/", async (req, res) => {
  try {
    const userId = req.user.sub;

    const serverIP = detectServerIP();

    const cameraData = {
      name: req.body.name,
      location: req.body.location || null,
      ip: req.body.ip || null,
      port: req.body.port || null,
      username: req.body.username || null,
      password: req.body.password || null,
      detection: "LOCAL", // Force local detection
      aiType: "FIRE", // Default AI type - user can change later in UI
      streamType: req.body.streamType || "WEBRTC",
      streamName: req.body.streamName || sanitizePathName(req.body.name),
      streamPath: req.body.streamPath || "/live",
      hlsUrl: req.body.hlsUrl || null,
      webrtcBase: req.body.webrtcBase || `http://${serverIP}:8889`,
      isActive: true,
    };

    const cam = await dynamodb.createCamera(userId, cameraData);

    if (cfg.backendDetectionEnabled && cam.isActive) {
      cam.userId = userId;
      addCameraToQueue(cam);
      log.info({ userId, cameraId: cam.id, cameraName: cam.name }, "Added camera to detection queue");
    }

    res.json(cam);

    restartMediaMTXForUser(userId, "after camera creation");
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get all cameras
cameras.get("/", async (req, res) => {
  try {
    const userId = req.user.sub;
    const list = await dynamodb.getCamerasByUserId(userId);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get detection status
cameras.get("/detection-status", async (req, res) => {
  try {
    const userId = req.user.sub;
    const cameraList = await dynamodb.getCamerasByUserId(userId);

    const queueStatus = getQueueStatus();

    const status = cameraList.map((cam) => ({
      id: cam.id,
      name: cam.name,
      location: cam.location,
      isRunning: queueStatus.cameras.some((c) => c.id === cam.id),
      isFire: queueStatus.fireDetections[cam.id] || false,
      lastChecked: queueStatus.lastChecked[cam.id] || null,
    }));

    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get status/all
cameras.get("/status/all", async (req, res) => {
  try {
    const userId = req.user.sub;
    const cams = await dynamodb.getCamerasByUserId(userId);

    const queueStatus = getQueueStatus();

    res.json(
      cams.map((c) => ({
        id: c.id,
        name: c.name,
        location: c.location,
        isStreaming: queueStatus.streamingCameras.has(c.id),
        isFire: queueStatus.fireDetections[c.id] || false,
        isView: c.isActive,
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start detection
cameras.post("/start-detection", async (req, res) => {
  try {
    const userId = req.user.sub;
    const { cameraIds } = req.body;

    if (!Array.isArray(cameraIds) || cameraIds.length === 0) {
      return res
        .status(400)
        .json({ error: "cameraIds must be a non-empty array" });
    }

    const ids = cameraIds.map((id) => Number(id)).filter((id) => !isNaN(id));
    if (ids.length === 0) {
      return res.status(400).json({ error: "No valid camera IDs provided" });
    }

    log.info({ userId, ids }, "Starting detection");

    const cameraList = await dynamodb.getCamerasByIds(userId, ids);

    if (cameraList.length === 0) {
      return res.status(404).json({ error: "No cameras found" });
    }

    const started = [];
    const failed = [];

    for (const cam of cameraList) {
      try {
        await dynamodb.updateCamera(userId, cam.id, { isActive: true });

        if (cfg.backendDetectionEnabled) {
          cam.userId = userId;
          addCameraToQueue(cam);
          log.info({ userId, cameraId: cam.id, cameraName: cam.name }, "Started detection for camera");
        } else {
          log.info({ userId, cameraId: cam.id, cameraName: cam.name }, "Marked camera active; backend detection is disabled");
        }
        started.push({ id: cam.id, name: cam.name });
      } catch (error) {
        log.error({ userId, cameraId: cam.id, cameraName: cam.name, err: error.message }, "Failed to start camera");
        failed.push({ id: cam.id, name: cam.name, error: error.message });
      }
    }

    res.json({
      started,
      failed,
      message: cfg.backendDetectionEnabled
        ? `Started detection for ${started.length} camera(s)`
        : `Marked ${started.length} camera(s) active; backend detection is disabled`,
    });
  } catch (error) {
    log.error({ err: error.message, stack: error.stack }, "Start detection error");
    res.status(500).json({ error: error.message });
  }
});

// Stop detection
cameras.post("/stop-detection", async (req, res) => {
  try {
    const userId = req.user.sub;
    const { cameraIds } = req.body;

    if (!Array.isArray(cameraIds) || cameraIds.length === 0) {
      return res
        .status(400)
        .json({ error: "cameraIds must be a non-empty array" });
    }

    const ids = cameraIds.map((id) => Number(id)).filter((id) => !isNaN(id));

    if (ids.length === 0) {
      return res.status(400).json({ error: "No valid camera IDs provided" });
    }

    log.info({ userId, ids }, "Stopping detection");

    const cameraList = await dynamodb.getCamerasByIds(userId, ids);

    const stopped = [];
    const failed = [];

    for (const cam of cameraList) {
      try {
        await dynamodb.updateCamera(userId, cam.id, { isActive: false });

        removeCameraFromQueue(cam.id);
        stopped.push({ id: cam.id, name: cam.name });
        log.info({ userId, cameraId: cam.id, cameraName: cam.name }, "Stopped detection for camera");
      } catch (error) {
        log.error({ userId, cameraId: cam.id, cameraName: cam.name, err: error.message }, "Failed to stop camera");
        failed.push({ id: cam.id, name: cam.name, error: error.message });
      }
    }

    res.json({
      stopped,
      failed,
      message: `Stopped detection for ${stopped.length} camera(s)`,
    });
  } catch (error) {
    log.error({ err: error.message, stack: error.stack }, "Stop detection error");
    res.status(500).json({ error: error.message });
  }
});

// Get single camera
cameras.get("/:id", async (req, res) => {
  try {
    const userId = req.user.sub;
    const id = Number(req.params.id);

    const cam = await dynamodb.getCamera(userId, id);
    res.json(cam);
  } catch (error) {
    if (error.message === "Camera not found") {
      return res.status(404).json({ error: "Camera not found" });
    }
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 🔥 UPDATE CAMERA (The CRITICAL FIX IS HERE)
// -------------------------------------------------------------
cameras.put("/:id", async (req, res) => {
  try {
    const userId = req.user.sub;
    const id = Number(req.params.id);

    // Validate aiType if provided
    if (req.body.aiType) {
      const validAiTypes = [
        "FIRE",
        "FIRE_YOLO",
        "FIRE_DETECTRON",
        "WEAPON",
        "WEAPON_YOLO",
        "WEAPON_DETECTRON",
        "MASK",
        "BOTH",
        "BOTH_DETECTRON",
      ];
      if (!validAiTypes.includes(req.body.aiType)) {
        return res.status(400).json({
          error: `Invalid aiType. Must be one of: ${validAiTypes.join(", ")}`,
        });
      }
    }

    // Get current camera state before update
    const currentCam = await dynamodb.getCamera(userId, id);
    const cam = await dynamodb.updateCamera(userId, id, req.body);

    // Handle active → queue behavior
    if (cfg.backendDetectionEnabled && req.body.isActive !== undefined) {
      if (req.body.isActive) {
        cam.userId = userId;
        addCameraToQueue(cam);
      } else {
        removeCameraFromQueue(cam.id);
      }
    }

    // If aiType changed and camera is active, restart detection with the new model set.
    if (
      req.body.aiType &&
      req.body.aiType !== currentCam.aiType &&
      cam.isActive
    ) {
      if (cfg.backendDetectionEnabled) {
        removeCameraFromQueue(cam.id);
        cam.userId = userId;
        addCameraToQueue(cam);
        log.info({
          userId,
          cameraId: cam.id,
          cameraName: cam.name,
          fromAiType: currentCam.aiType,
          toAiType: cam.aiType,
        }, "Restarted camera after aiType change");
      }
    } else if (cfg.backendDetectionEnabled && cam.isActive) {
      // Update non-aiType changes only when the camera is actually active.
      updateCameraInQueue(id, req.body);
    }

    // 🔄 Restart MediaMTX if stream-related fields changed
    const streamFields = ["ip", "port", "username", "password", "streamPath"];
    const streamFieldChanged = streamFields.some(
      (field) => req.body[field] !== undefined && req.body[field] !== currentCam[field]
    );

    res.json(cam);

    if (streamFieldChanged) {
      restartMediaMTXForUser(userId, "after camera update");
    }
  } catch (error) {
    if (error.message === "Camera not found") {
      return res.status(404).json({ error: "Camera not found" });
    }
    res.status(400).json({ error: error.message });
  }
});

// Delete camera
cameras.delete("/:id", async (req, res) => {
  try {
    const userId = req.user.sub;
    const id = Number(req.params.id);

    await dynamodb.getCamera(userId, id);
    if (cfg.backendDetectionEnabled) {
      removeCameraFromQueue(id);
    }
    await dynamodb.deleteCamera(userId, id);

    res.json({ ok: true });
  } catch (error) {
    if (error.message === "Camera not found") {
      return res.status(404).json({ error: "Camera not found" });
    }
    res.status(500).json({ error: error.message });
  }
});
