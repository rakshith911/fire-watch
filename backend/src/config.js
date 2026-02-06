import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Detect Electron mode
const isElectron = process.env.ELECTRON === "true";

// ✅ Get ffmpeg path - check multiple locations
function getFfmpegPath() {
  // 1. Explicit override from environment
  if (process.env.FFMPEG_BIN) {
    console.log("🎬 Using FFMPEG_BIN from env:", process.env.FFMPEG_BIN);
    return process.env.FFMPEG_BIN;
  }

  // 2. Bundled ffmpeg in Electron app (in backend/bin)
  if (isElectron) {
    // In production, backend is in resources/backend
    const bundledPath = path.resolve(__dirname, "../bin/ffmpeg");
    if (fs.existsSync(bundledPath)) {
      console.log("🎬 Using bundled ffmpeg:", bundledPath);
      return bundledPath;
    }
  }

  // 3. Local development - check backend/bin
  const devPath = path.resolve(__dirname, "../bin/ffmpeg");
  if (fs.existsSync(devPath)) {
    console.log("🎬 Using local ffmpeg:", devPath);
    return devPath;
  }

  // 4. System ffmpeg (fallback)
  console.log("🎬 Using system ffmpeg");
  return "ffmpeg";
}

export const cfg = {
  // ✅ NO userId - will be set dynamically on login
  userId: null,

  cognito: {
    poolId: process.env.COGNITO_USER_POOL_ID,
    clientId: process.env.COGNITO_CLIENT_ID,
    region: process.env.COGNITO_REGION || "us-east-1",
  },
  mediamtx: {
    config: process.env.MEDIAMTX_CONFIG || "./mediamtx.yml",
  },
  ffmpeg: getFfmpegPath(),

  // ✅ ADDED: Fire detection endpoint
  fireEndpoint:
    process.env.FIRE_ENDPOINT ||
    "https://2cwzmjzkx4.execute-api.us-east-1.amazonaws.com/default/fire-frame-receiver",

  // AI Type endpoints - maps AI types to their respective AWS Lambda endpoints
  aiTypeEndpoints: {
    FIRE: process.env.FIRE_ENDPOINT,
  },

  port: Number(process.env.PORT || 4000),
  isElectron,
};

console.log("✅ Config loaded - DynamoDB mode (no local database)");
console.log("🔥 Fire Endpoint:", cfg.fireEndpoint);

// Validate ffmpeg exists
if (cfg.ffmpeg !== "ffmpeg") {
  if (fs.existsSync(cfg.ffmpeg)) {
    console.log("✅ ffmpeg found at:", cfg.ffmpeg);
  } else {
    console.error("❌ CRITICAL: ffmpeg NOT FOUND at:", cfg.ffmpeg);
    console.error("   Detection will NOT work without ffmpeg!");
  }
} else {
  console.log("🎬 Using system ffmpeg (must be in PATH)");
}
