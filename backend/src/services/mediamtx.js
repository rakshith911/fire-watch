import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import pino from "pino";
import os from "node:os";
import { cfg } from "../config.js";
import { generateMediaMTXConfig } from "./mediamtxConfigGenerator.js";
import { fileURLToPath } from "url";

const log = pino({ name: "mediamtx" });

let mtxProcess = null;

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the backend root (where src is)
const BACKEND_ROOT = path.resolve(__dirname, "../../");

// ✅ FIX: Use user data directory for config when running in Electron
function getConfigPath() {
  const isElectron = process.env.ELECTRON === 'true';

  if (isElectron) {
    // ✅ Use user's home directory for Electron
    const userDataPath = path.join(os.homedir(), '.firewatch');

    // Create directory if it doesn't exist
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
      log.info({ path: userDataPath }, "Created FireWatch user data directory");
    }

    return path.join(userDataPath, 'mediamtx.yml');
  } else {
    // ✅ Use project directory for normal mode
    const rawPath = cfg.mediamtx?.config || "./mediamtx.yml";
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  }
}

/**
 * Find the MediaMTX executable
 */
function getExecutablePath() {
  const isWindows = process.platform === "win32";

  // 1. Check override path (from Electron Launcher)
  if (process.env.MEDIAMTX_DIR_OVERRIDE) {
    const binaryName = isWindows ? "mediamtx.exe" : "mediamtx";
    const overridePath = path.join(process.env.MEDIAMTX_DIR_OVERRIDE, binaryName);
    if (fs.existsSync(overridePath)) {
      return overridePath;
    }
  }

  const binaryName = isWindows ? "mediamtx.exe" : "mediamtx";

  // Look in the backend root directory
  const localPath = path.join(BACKEND_ROOT, binaryName);

  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // Also try looking in current working directory
  const cwdPath = path.join(process.cwd(), binaryName);
  if (fs.existsSync(cwdPath)) {
    return cwdPath;
  }

  return null;
}

export async function startMediaMTX(userId = null) {
  // STEP 1: Generate MediaMTX config
  try {
    log.info("Generating MediaMTX configuration from database...");

    // ✅ Generate config in accessible location
    const configPath = getConfigPath();
    const result = await generateMediaMTXConfig(configPath, userId);

    log.info(
      {
        serverIP: result.serverIP,
        camerasCount: result.camerasCount,
        configPath: configPath,
      },
      "MediaMTX config generated successfully"
    );
  } catch (error) {
    log.warn(
      { error: error.message },
      "Failed to generate MediaMTX config, will use existing config if available"
    );
  }

  // STEP 2: Check if already running
  if (mtxProcess && !mtxProcess.killed) {
    log.info("MediaMTX process is already running");
    return mtxProcess;
  }

  // Ensure any previous instances are dead
  await stopMediaMTX();

  // STEP 3: Spawn the process
  const exePath = getExecutablePath();
  const configPath = getConfigPath();

  if (!exePath) {
    log.error("❌ MediaMTX executable not found! Please place mediamtx binary in the backend folder.");
    throw new Error("MediaMTX executable not found");
  }

  log.info({ exePath, configPath }, "🚀 Spawning MediaMTX process...");

  const args = [configPath];

  mtxProcess = spawn(exePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin, capture stdout/stderr
    windowsHide: true // Hide the console window on Windows
  });

  // Handle Logs
  mtxProcess.stdout.on("data", (data) => {
    log.info({ mtx: data.toString().trim() });
  });

  mtxProcess.stderr.on("data", (data) => {
    log.warn({ mtx_err: data.toString().trim() });
  });

  mtxProcess.on("close", (code) => {
    log.info(`MediaMTX process exited with code ${code}`);
    mtxProcess = null;
  });

  // Wait until HTTP port answers
  const timeout = Number(process.env.MEDIAMTX_READY_TIMEOUT_MS || 10000);
  await waitForHttp("127.0.0.1", 8888, timeout);
  log.info("MediaMTX HTTP is responsive on :8888");

  return mtxProcess;
}

export async function stopMediaMTX() {
  if (mtxProcess) {
    log.info("🛑 Stopping MediaMTX process...");
    mtxProcess.kill();
    mtxProcess = null;
  }
}

export async function isMediaMTXRunning() {
  return mtxProcess !== null && !mtxProcess.killed;
}

export async function streamMediaMtxLogs() {
  // Logs were already piped in startMediaMTX
}

async function waitForHttp(host, port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request(
        { host, port, method: "GET", path: "/" },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", () => {
        if (Date.now() > deadline)
          return reject(new Error("MTX HTTP not ready"));
        setTimeout(tick, 300);
      });
      req.end();
    };
    tick();
  });
}