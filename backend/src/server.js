import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import cors from "cors";
import pino from "pino";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { cfg } from "./config.js";
import { requireAuth } from "./auth/cognitoVerify.js";
import {
  startMediaMTX,
  stopMediaMTX,
  isMediaMTXRunning,
} from "./services/mediamtx.js";
import { cameras as camerasRouter } from "./routes/cameras.js";
import { user as userRouter } from "./routes/user.js";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  startDetectionQueue,
  stopDetectionQueue,
  setBroadcastFunction,
  handleFrontendDetection,
} from "./services/detectionQueue.js";
import { dynamodb } from "./db/dynamodb.js";

const log = pino({ name: "server" });
const app = express();
const httpServer = createServer(app);

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===================================================================
// 🔧 Configuration Constants
// ===================================================================


// ✅ Track current user (starts as null, set dynamically on login)
let currentUserId = null;

// -------------------------------------------------------------------
// 📥 Model Download Trigger
// -------------------------------------------------------------------
import { spawn } from "child_process";
const downloadScript = path.join(__dirname, "../scripts/download-models.js");

function ensureModels() {
  log.info("📥 Checking/Downloading models...");
  const downloader = spawn("node", [downloadScript], {
    stdio: "inherit",
    env: process.env // Pass current env (including overrides)
  });

  downloader.on("close", (code) => {
    if (code === 0) {
      log.info("✅ Models check complete");
    } else {
      log.error({ code }, "❌ Model download failed");
    }
  });
}

// Trigger on start
ensureModels();

// -------------------------------------------------------------------
// 🧠 WebSocket setup with JWT authentication
// -------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });
const wsClients = new Map(); // userId -> Set<WebSocket>

const verifier = CognitoJwtVerifier.create({
  userPoolId: cfg.cognito.poolId,
  tokenUse: "id",
  clientId: cfg.cognito.clientId,
});

wss.on("connection", async (ws, req) => {
  log.info("🔗 WebSocket connection attempt");

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    ws.close(4001, "Missing token");
    log.warn("WebSocket rejected: missing token");
    return;
  }

  try {
    const payload = await verifier.verify(token);
    const userId = payload.sub;

    log.info(
      { userId, email: payload.email },
      "✅ User authenticated via WebSocket"
    );

    // ✅ ENSURE USER EXISTS: Create user with default settings if not exists
    try {
      const user = await dynamodb.ensureUser(userId);
      log.info(
        { userId },
        "📋 User settings loaded/initialized"
      );
    } catch (error) {
      log.error(
        { error: error.message, userId },
        "❌ Failed to initialize user settings"
      );
      // Continue anyway - don't block connection on settings failure
    }

    // ✅ DYNAMIC USER DETECTION: Switch detection queue for new user
    if (!currentUserId || currentUserId !== userId) {
      log.info(
        { oldUser: currentUserId, newUser: userId },
        "🔄 New user detected, switching detection queue"
      );

      currentUserId = userId;

      // Stop existing queue (if any)
      await stopDetectionQueue();

      // ✅ ONLY CHANGE: Load ALL cameras for this user (not just active)
      const userCameras = await dynamodb.getCamerasByUserId(userId);

      if (userCameras.length > 0) {
        log.info(
          { userId, count: userCameras.length },
          "🎥 Starting detection for new user's cameras"
        );

        // ✅ Regenerate MediaMTX config for this user
        try {
          log.info("🔄 Regenerating MediaMTX config for logged-in user...");
          await stopMediaMTX();
          await startMediaMTX(userId);
          log.info("✅ MediaMTX restarted with user's cameras");
        } catch (err) {
          log.error({ error: err.message }, "❌ Failed to restart MediaMTX");
        }

        // ✅ Attach userId to each camera before passing to queue
        const camerasWithUserId = userCameras.map(cam => ({
          ...cam,
          userId: userId
        }));

        await startDetectionQueue(camerasWithUserId);
      } else {
        log.warn({ userId }, "⚠️ No cameras found for this user");
      }
    } else {
      log.info({ userId }, "♻️ Same user reconnected, keeping existing queue");
    }

    // Register WebSocket client
    if (!wsClients.has(userId)) wsClients.set(userId, new Set());
    wsClients.get(userId).add(ws);
    log.info(
      { userId, totalClients: wsClients.get(userId).size },
      "📡 WebSocket client registered"
    );

    ws.send(
      JSON.stringify({ type: "connected", message: "WebSocket connected" })
    );

    // Handle messages from frontend (e.g. frontend YOLO detection events)
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "frontend-detection") {
          log.info({
            userId,
            cameraId: msg.cameraId,
            cameraName: msg.cameraName,
            boxCount: msg.boxes?.length,
            labels: (msg.boxes || []).map(b => b[4]),
            source: "websocket-inbound",
          }, "📩 WS message: frontend-detection received from browser");
          await handleFrontendDetection(userId, msg);
        } else {
          log.info({ type: msg.type }, "📩 WS message: unknown type");
        }
      } catch (err) {
        log.warn({ error: err.message }, "Failed to parse WebSocket message from client");
      }
    });

    ws.on("close", () => {
      const clients = wsClients.get(userId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          wsClients.delete(userId);
          log.info({ userId }, "❌ Last WebSocket disconnected for user");
        }
      }
      log.info({ userId }, "❌ WebSocket disconnected");
    });
  } catch (error) {
    ws.close(4002, "Invalid token");
    log.warn({ error: error.message }, "❌ WebSocket authentication failed");
  }
});

// -------------------------------------------------------------------
// 🔥 Broadcast helper for fire detection
// -------------------------------------------------------------------
export function broadcastFireDetection(userId, id, cameraName, isFire, metadata = {}) {
  log.info(
    {
      userId,
      id,
      cameraName,
      isFire,
      totalUsers: wsClients.size,
      hasMetadata: Object.keys(metadata).length > 0
    },
    "🔥 broadcastFireDetection called"
  );

  const clients = wsClients.get(userId);

  if (!clients || clients.size === 0) {
    log.warn(
      { userId, id, availableUsers: Array.from(wsClients.keys()) },
      "⚠️ No WebSocket clients found for userId"
    );
    return;
  }

  // ✅ Include optional metadata (IoU analysis, motion info, etc.)
  const payload = JSON.stringify({
    type: "fire-detection",
    cameraId: id,
    cameraName,
    isFire,
    timestamp: new Date().toISOString(),
    ...metadata  // Spread any additional metadata (iouAnalysis, motionAnalysis, etc.)
  });

  log.info(
    { userId, id, clientCount: clients.size, payloadSize: payload.length },
    "📡 Sending to WebSocket clients"
  );

  let sentCount = 0;
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(payload);
      sentCount++;
    } else {
      log.warn(
        { userId, id, readyState: client.readyState },
        "⚠️ Client not in OPEN state"
      );
    }
  }

  log.info(
    { userId, id, isFire, sentCount },
    "📢 Fire detection broadcasted"
  );
}

// -------------------------------------------------------------------
// 🌐 Express configuration
// -------------------------------------------------------------------
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "5mb" }));

// Serve static files from the frontend dist folder
const isElectronProduction =
  process.env.ELECTRON &&
  process.resourcesPath &&
  __dirname.includes(process.resourcesPath);
let frontendDistPath;

if (isElectronProduction) {
  frontendDistPath = path.join(process.resourcesPath, "app.asar", "dist");
  log.info(
    { frontendDistPath, resourcesPath: process.resourcesPath },
    "📂 Electron production - serving from asar"
  );
} else {
  frontendDistPath = path.join(__dirname, "../../frontend/dist");
  log.info(
    { frontendDistPath, isElectron: !!process.env.ELECTRON },
    "📂 Development mode"
  );
}

app.use(express.static(frontendDistPath));

app.get("/healthz", async (_req, res) => {
  res.json({ ok: true, mediamtx: await isMediaMTXRunning() });
});

// Diagnostic endpoint - check models and system info
app.get("/diagnostics", async (_req, res) => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const os = await import("os");

  const modelsDir = process.env.MODELS_DIR_OVERRIDE
    ? process.env.MODELS_DIR_OVERRIDE
    : path.resolve(__dirname, "../models");

  const requiredModels = [
    "best.onnx",
    "yolov11n_bestFire.onnx",
    "weapons.onnx",
    "weapons_yolo.onnx",
    "depth_anything_v2_small.onnx"
  ];

  const modelStatus = {};
  for (const model of requiredModels) {
    const modelPath = path.join(modelsDir, model);
    try {
      if (fs.existsSync(modelPath)) {
        const stats = fs.statSync(modelPath);
        modelStatus[model] = {
          exists: true,
          sizeMB: (stats.size / 1024 / 1024).toFixed(1),
          path: modelPath
        };
      } else {
        modelStatus[model] = { exists: false, path: modelPath };
      }
    } catch (e) {
      modelStatus[model] = { exists: false, error: e.message };
    }
  }

  res.json({
    system: {
      platform: os.default.platform(),
      arch: os.default.arch(),
      nodeVersion: process.version,
      cpuModel: os.default.cpus()[0]?.model || "unknown"
    },
    environment: {
      MODELS_DIR_OVERRIDE: process.env.MODELS_DIR_OVERRIDE || "not set",
      ELECTRON: process.env.ELECTRON || "not set",
      NODE_ENV: process.env.NODE_ENV || "not set"
    },
    models: {
      directory: modelsDir,
      files: modelStatus
    },
    mediamtx: await isMediaMTXRunning()
  });
});

app.use("/api", requireAuth);
app.use("/api/cameras", camerasRouter);
app.use("/api/user", userRouter);

// Handle React Router (catch all handler for SPA)
app.get("*", (req, res) => {
  const indexPath = isElectronProduction
    ? path.join(process.resourcesPath, "app.asar", "dist", "index.html")
    : path.join(__dirname, "../../frontend/dist/index.html");
  res.sendFile(indexPath);
});

// -------------------------------------------------------------------
// 🔍 Model Diagnostics - Check all required models at startup
// -------------------------------------------------------------------
function checkModelsAtStartup() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  const modelsDir = process.env.MODELS_DIR_OVERRIDE
    ? process.env.MODELS_DIR_OVERRIDE
    : path.resolve(__dirname, "../models");

  const requiredModels = [
    { name: "best.onnx", purpose: "Fire Detection (Detectron)" },
    { name: "yolov11n_bestFire.onnx", purpose: "Fire Detection (YOLO)" },
    { name: "weapons.onnx", purpose: "Weapon Detection (Detectron)" },
    { name: "weapons_yolo.onnx", purpose: "Weapon Detection (YOLO)" },
    { name: "depth_anything_v2_small.onnx", purpose: "Liveness/Depth Check" },
  ];

  log.info("═══════════════════════════════════════════════════════════");
  log.info("🔍 MODEL DIAGNOSTICS");
  log.info("═══════════════════════════════════════════════════════════");
  log.info({ modelsDir, override: !!process.env.MODELS_DIR_OVERRIDE }, "Models directory");

  let allPresent = true;
  const modelStatus = [];

  for (const model of requiredModels) {
    const modelPath = path.join(modelsDir, model.name);
    const exists = fs.existsSync(modelPath);
    let size = 0;

    if (exists) {
      try {
        const stats = fs.statSync(modelPath);
        size = stats.size;
      } catch (e) {
        size = -1;
      }
    } else {
      allPresent = false;
    }

    const status = {
      model: model.name,
      purpose: model.purpose,
      exists,
      sizeMB: exists ? (size / 1024 / 1024).toFixed(1) : "N/A",
      path: modelPath
    };
    modelStatus.push(status);

    if (exists) {
      log.info({ ...status }, `✅ ${model.name}`);
    } else {
      log.error({ ...status }, `❌ ${model.name} - MISSING!`);
    }
  }

  log.info("═══════════════════════════════════════════════════════════");

  if (!allPresent) {
    log.error("⚠️ SOME MODELS ARE MISSING! Detection may not work properly.");
    log.error("Models should be at: " + modelsDir);
  } else {
    log.info("✅ All required models present");
  }

  log.info("═══════════════════════════════════════════════════════════");

  return { allPresent, modelStatus, modelsDir };
}

// -------------------------------------------------------------------
// 🚀 Main Entrypoint
// -------------------------------------------------------------------
async function main() {
  // Run model diagnostics first
  const modelCheck = checkModelsAtStartup();

  setBroadcastFunction(broadcastFireDetection);
  log.info("🔌 WebSocket broadcast function registered with detection queue");

  // ✅ Start MediaMTX with EMPTY config (will be populated on login)
  try {
    log.info("Starting MediaMTX with empty configuration...");
    await startMediaMTX();
    log.info("✅ MediaMTX started (waiting for user login to add camera paths)");
  } catch (err) {
    log.error({ error: err.message }, "Failed to start MediaMTX");
  }

  // ✅ NO detection queue at startup - will start when user logs in
  log.info("⏳ Waiting for user to login via WebSocket...");
  log.info("💡 Cameras and detection will load automatically after authentication");

  httpServer.listen(cfg.port, () =>
    log.info(`🚀 API & WebSocket listening on port ${cfg.port}`)
  );
}

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  log.info("SIGTERM received, shutting down...");
  await stopDetectionQueue();
  await stopMediaMTX();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log.info("SIGINT received, shutting down...");
  await stopDetectionQueue();
  await stopMediaMTX();
  process.exit(0);
});

main().catch((e) => {
  log.error(e);
  process.exit(1);
});