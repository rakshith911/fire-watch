// const { app, BrowserWindow, Menu, ipcMain } = require("electron");
// const path = require("path");
// const isDev = require("electron-is-dev");
// const { spawn } = require("child_process");

// let mainWindow;
// let backendProcess;

// function createWindow() {
//   mainWindow = new BrowserWindow({
//     width: 1400,
//     height: 900,
//     webPreferences: {
//       nodeIntegration: false,
//       contextIsolation: true,
//       enableRemoteModule: false,
//       preload: path.join(__dirname, "preload.cjs"),
//     },
//     icon: path.join(__dirname, "../images/fire_ai_logo.png"),
//     titleBarStyle: "default",
//     show: false,
//   });

//   // Load the React app
//   const startUrl = isDev ? "http://localhost:5173" : "http://localhost:4000";

//   console.log("🔍 Loading URL:", startUrl);
//   mainWindow.loadURL(startUrl);

//   mainWindow.once("ready-to-show", () => {
//     mainWindow.show();
//   });

//   if (isDev) {
//     mainWindow.webContents.openDevTools();
//   }
// }

// function startBackend() {
//   const backendPath = isDev
//     ? path.join(__dirname, "../../backend")
//     : path.join(process.resourcesPath, "backend");

//   const command = isDev ? "npm" : "node";
//   const args = isDev ? ["run", "dev"] : ["src/server.js"];

//   console.log("🔍 Starting backend from:", backendPath);
//   console.log("🔍 Command:", command, args.join(" "));

//   backendProcess = spawn(command, args, {
//     cwd: backendPath,
//     stdio: "inherit",
//     shell: true,
//     env: {
//       ...process.env,
//       NODE_ENV: isDev ? "development" : "production",
//       ELECTRON: "true", // Signal to backend that it's running in Electron
//       PORT: "4000", // Ensure backend uses port 4000
//     },
//   });

//   backendProcess.on("error", (err) => {
//     console.error("Backend process error:", err);
//   });
// }

// app.whenReady().then(() => {
//   createWindow();
//   startBackend();

//   app.on("activate", () => {
//     if (BrowserWindow.getAllWindows().length === 0) {
//       createWindow();
//     }
//   });
// });

// app.on("window-all-closed", () => {
//   if (backendProcess) {
//     backendProcess.kill();
//   }
//   if (process.platform !== "darwin") {
//     app.quit();
//   }
// });

// // Handle backend communication
// ipcMain.handle("get-backend-status", async () => {
//   // Check if backend is running
//   return { running: !!backendProcess };
// });

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, exec } = require("child_process");
const util = require("util");
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage"); // Not used for download but good to have
const stream = require("stream");
const { promisify } = require("util");
const pipeline = promisify(stream.pipeline);

const execPromise = util.promisify(exec);

// ✅ Logging setup
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch { }
}

function logPaths() {
  // Electron exposes a per-app logs dir
  const logsDir = app.getPath("logs"); // e.g. ~/Library/Logs/FireAI
  ensureDir(logsDir);
  return {
    dir: logsDir,
    backend: path.join(logsDir, "backend.log"),
    main: path.join(logsDir, "main.log"),
  };
}

const LOG = logPaths();
const mainLog = fs.createWriteStream(LOG.main, { flags: "a" });
const stamp = () => new Date().toISOString();

// write your main-process logs to file as well
function mlog(...args) {
  const line = `[${stamp()}] [main] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}\n`;
  mainLog.write(line);
  console.log(...args); // still visible in dev tools when running via npm
}

// (optional) add a menu/shortcut to open Logs folder:
function openLogsFolder() {
  shell.openPath(LOG.dir);
}

let mainWindow;
let splashWindow;
let backendProcess;

const isDev = !app.isPackaged;

// ✅ LOAD ENV VARS for S3
if (isDev) {
  require("dotenv").config({ path: path.join(__dirname, "../../backend/.env") });
} else {
  // In production, .env is copied to resources/backend/.env
  require("dotenv").config({ path: path.join(process.resourcesPath, "backend/.env") });
}

// ✅ RESOURCE PATHS
const userDataPath = app.getPath("userData");
const modelsPath = path.join(userDataPath, "models");
const backendRootPath = path.join(userDataPath, "backend_bin"); // For binaries like mediamtx
const versionFilePath = path.join(userDataPath, ".app_version");
ensureDir(modelsPath);
ensureDir(backendRootPath);

// ✅ APP VERSION & BUILD ID - Used to trigger re-download when DMG is updated
const APP_VERSION = "0.2.1";

// Build ID is auto-generated at build time - forces re-download on every new DMG
function getBuildId() {
  // In production, read from bundled file. In dev, use "dev"
  if (isDev) return "dev";

  try {
    const buildIdPath = path.join(__dirname, "build-id.txt");
    if (fs.existsSync(buildIdPath)) {
      return fs.readFileSync(buildIdPath, "utf8").trim();
    }
  } catch (e) {
    mlog("Could not read build ID:", e.message);
  }
  return "unknown";
}

const BUILD_ID = getBuildId();

// Check if build changed - if so, clear models to force re-download
function checkVersionAndClearIfNeeded() {
  let storedBuildId = null;

  try {
    if (fs.existsSync(versionFilePath)) {
      storedBuildId = fs.readFileSync(versionFilePath, "utf8").trim();
    }
  } catch (e) {
    mlog("Could not read version file:", e.message);
  }

  mlog(`📦 App version: ${APP_VERSION}, Build ID: ${BUILD_ID}, Stored Build ID: ${storedBuildId || "none"}`);

  if (storedBuildId !== BUILD_ID) {
    mlog("🔄 NEW BUILD DETECTED - Clearing old models to force re-download...");

    // Delete all files in models directory
    try {
      if (fs.existsSync(modelsPath)) {
        const files = fs.readdirSync(modelsPath);
        for (const file of files) {
          const filePath = path.join(modelsPath, file);
          fs.unlinkSync(filePath);
          mlog(`🗑️ Deleted: ${file}`);
        }
      }
    } catch (e) {
      mlog("Error clearing models:", e.message);
    }

    // Delete mediamtx binary (ffmpeg is bundled, not downloaded)
    try {
      const binaryName = process.platform === "win32" ? "mediamtx.exe" : "mediamtx";
      const binaryPath = path.join(backendRootPath, binaryName);
      if (fs.existsSync(binaryPath)) {
        fs.unlinkSync(binaryPath);
        mlog(`🗑️ Deleted: ${binaryName}`);
      }
    } catch (e) {
      mlog("Error clearing binary:", e.message);
    }

    mlog("✅ Old resources cleared - will download fresh copies");
    return true; // Version changed
  }

  return false; // Same version
}

// Save current build ID after successful download
function saveVersion() {
  try {
    fs.writeFileSync(versionFilePath, BUILD_ID);
    mlog(`💾 Saved build ID ${BUILD_ID} to ${versionFilePath}`);
  } catch (e) {
    mlog("Failed to save build ID:", e.message);
  }
}

// ✅ AWS CONFIG
// NOTE: Ideally these should be baked in or fetched securely. 
// For this verifying phase, we assume env vars or hardcoded defaults if safe.
// Since this is client-side, using read-only credentials or signed URLs is better.
// For now, we will use the ENV vars if available (dev) or require them.
// WARNING: Bundling admin keys in the app is unsafe. 
// User should probably use public bucket or signed URLs. 
// Assuming public bucket or env vars for now as per previous context.
const S3_BUCKET = "firewatch-models";
const AWS_REGION = "us-east-1";

// Create S3 Client (Anonymous if bucket is public, or use embedded Creds - careful!)
// For the purpose of this demo, we assume the bucket is public-read OR variables are present.
// If deployment, we should bundle a specific read-only access key.
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, // Needs to be injected in build or handled
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

mlog("🔍 isDev:", isDev);
mlog("🔍 app.isPackaged:", app.isPackaged);
mlog("🔍 UserData Path:", userDataPath);

// ✅ CHECK RESOURCES - with file size validation
async function checkResources() {
  // Expected file sizes (in bytes) to validate downloads are complete
  const REQUIRED_FILES = [
    { name: "best.onnx", minSize: 130000000 },           // ~131MB
    { name: "weapons.onnx", minSize: 130000000 },        // ~131MB
    { name: "depth_anything_v2_small.onnx", minSize: 98000000 }, // ~99MB
    { name: "yolov11n_bestFire.onnx", minSize: 5000000 }, // ~5MB (Estimated for YOLO11n)
    { name: "weapons_yolo.onnx", minSize: 5000000 }      // ~5MB (Estimated for YOLO11n)
  ];

  // Also check for mediamtx binary (ffmpeg is bundled with the app)
  const mediamtxName = process.platform === "win32" ? "mediamtx.exe" : "mediamtx";

  const missing = [];

  mlog("═══════════════════════════════════════════════════════════");
  mlog("🔍 CHECKING RESOURCES");
  mlog("═══════════════════════════════════════════════════════════");
  mlog("Models path:", modelsPath);
  mlog("Backend bin path:", backendRootPath);

  // Check models - validate existence AND size
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(modelsPath, file.name);
    const exists = fs.existsSync(filePath);

    if (!exists) {
      mlog(`❌ ${file.name} - MISSING`);
      missing.push({ type: "model", name: file.name });
    } else {
      const stats = fs.statSync(filePath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

      if (stats.size < file.minSize) {
        mlog(`⚠️ ${file.name} - CORRUPTED (${sizeMB}MB, expected >${(file.minSize / 1024 / 1024).toFixed(0)}MB)`);
        // Delete corrupted file so it gets re-downloaded
        try {
          fs.unlinkSync(filePath);
          mlog(`🗑️ Deleted corrupted ${file.name}`);
        } catch (e) {
          mlog(`Failed to delete corrupted file: ${e.message}`);
        }
        missing.push({ type: "model", name: file.name });
      } else {
        mlog(`✅ ${file.name} - OK (${sizeMB}MB)`);
      }
    }
  }

  // Check mediamtx binary
  const mediamtxPath = path.join(backendRootPath, mediamtxName);
  if (!fs.existsSync(mediamtxPath)) {
    mlog(`❌ ${mediamtxName} - MISSING`);
    missing.push({ type: "binary", name: mediamtxName });
  } else {
    const stats = fs.statSync(mediamtxPath);
    mlog(`✅ ${mediamtxName} - OK (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
  }

  // Check ffmpeg - first check bundled location, then app data fallback
  const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const backendPath = isDev
    ? path.join(__dirname, "../../backend")
    : path.join(process.resourcesPath, "backend");
  const bundledFfmpeg = path.join(backendPath, "bin", ffmpegName);
  const fallbackFfmpeg = path.join(backendRootPath, ffmpegName);

  if (fs.existsSync(bundledFfmpeg)) {
    const stats = fs.statSync(bundledFfmpeg);
    mlog(`✅ ${ffmpegName} (bundled) - OK (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
  } else if (fs.existsSync(fallbackFfmpeg)) {
    const stats = fs.statSync(fallbackFfmpeg);
    mlog(`✅ ${ffmpegName} (downloaded) - OK (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
  } else {
    mlog(`❌ ${ffmpegName} - MISSING (not bundled, will download)`);
    missing.push({ type: "binary", name: ffmpegName });
  }

  mlog("═══════════════════════════════════════════════════════════");
  if (missing.length > 0) {
    mlog(`⚠️ ${missing.length} resources need to be downloaded`);
  } else {
    mlog("✅ All resources present and valid");
  }
  mlog("═══════════════════════════════════════════════════════════");

  return missing;
}

// ✅ DOWNLOAD RESOURCES
async function downloadResources(missingFiles) {
  mlog("⬇️ Starting download for:", missingFiles.map(f => f.name));

  createSplashWindow();

  let totalFiles = missingFiles.length;
  let current = 0;

  for (const file of missingFiles) {
    const targetDir = file.type === "model" ? modelsPath : backendRootPath;
    const targetPath = path.join(targetDir, file.name);

    // Update Splash UI
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send("download-progress", {
        filename: file.name,
        current: current + 1,
        total: totalFiles,
        percent: Math.round((current / totalFiles) * 100)
      });
    }

    try {
      // 1. Get from S3
      // NOTE: If bucket is public, we can just use https.get
      // Using SDK for robustness
      const command = new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: file.name // Assuming keys match filenames exactly at root
      });

      const response = await s3.send(command);

      // 2. Stream to file
      await pipeline(response.Body, fs.createWriteStream(targetPath));

      // 3. Verify download
      const stats = fs.statSync(targetPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      mlog(`✅ Downloaded: ${file.name} (${sizeMB}MB)`);

      // 4. Make executable if binary
      if (file.type === "binary" && process.platform !== "win32") {
        fs.chmodSync(targetPath, "755");
      }

      current++;

    } catch (e) {
      mlog(`❌ Failed to download ${file.name}:`, e.message);
      dialog.showErrorBox("Download Error", `Failed to download ${file.name}. Please check your internet connection.`);
      app.quit();
      return false; // Stop
    }
  }

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  return true;
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 300,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false // Simple splash screen
    }
  });

  const splashHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { background: #1a1a1a; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; border: 2px solid #333; border-radius: 10px; }
            .bar { width: 80%; height: 10px; background: #333; margin-top: 20px; border-radius: 5px; overflow: hidden; }
            .fill { width: 0%; height: 100%; background: #007bff; transition: width 0.3s; }
            .status { margin-top: 10px; font-size: 14px; color: #aaa; }
        </style>
    </head>
    <body>
        <h2>FireAI Setup</h2>
        <div class="status" id="text">Checking resources...</div>
        <div class="bar"><div class="fill" id="fill"></div></div>
        <script>
            const { ipcRenderer } = require('electron');
            ipcRenderer.on('download-progress', (event, data) => {
                document.getElementById('text').innerText = 'Downloading ' + data.filename + ' (' + data.current + '/' + data.total + ')';
                document.getElementById('fill').style.width = data.percent + '%';
            });
        </script>
    </body>
    </html>
  `;

  splashWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashHtml));
}

// ✅ LOCAL HTTP SERVER for production builds
// Web Workers can't fetch() from file:// protocol, so we serve dist/ over HTTP
let frontendPort = 4100;
let frontendServer = null;

function startFrontendServer() {
  return new Promise((resolve) => {
    if (isDev) return resolve(); // Dev uses Vite's dev server

    const distPath = path.join(__dirname, "../dist");
    const MIME_TYPES = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".mjs": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".wasm": "application/wasm",
      ".onnx": "application/octet-stream",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".map": "application/json",
    };

    frontendServer = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (urlPath === "/") urlPath = "/index.html";

      const filePath = path.join(distPath, urlPath);

      // Security: prevent path traversal
      if (!filePath.startsWith(distPath)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      // SharedArrayBuffer requires cross-origin isolation headers.
      // ort-wasm-simd-threaded.wasm needs SharedArrayBuffer even with numThreads=1.
      const ISOLATION_HEADERS = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      };

      fs.readFile(filePath, (err, data) => {
        if (err) {
          // Try index.html for SPA routing
          if (err.code === "ENOENT" && !path.extname(urlPath)) {
            fs.readFile(path.join(distPath, "index.html"), (err2, html) => {
              if (err2) {
                res.writeHead(404);
                res.end("Not found");
                return;
              }
              res.writeHead(200, { "Content-Type": "text/html", ...ISOLATION_HEADERS });
              res.end(html);
            });
            return;
          }
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType, ...ISOLATION_HEADERS });
        res.end(data);
      });
    });

    frontendServer.listen(frontendPort, "127.0.0.1", () => {
      mlog(`✅ Frontend HTTP server running at http://127.0.0.1:${frontendPort}`);
      resolve();
    });

    frontendServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        mlog(`⚠️ Port ${frontendPort} in use, trying ${frontendPort + 1}`);
        frontendPort++;
        frontendServer.listen(frontendPort, "127.0.0.1");
      } else {
        mlog("❌ Frontend server error:", err);
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
    icon: path.join(__dirname, "../dist/fire_ai_logo.png"),
    titleBarStyle: "default",
    show: false,
  });

  // ✅ FIX: Load from file in production, dev server in dev
  if (isDev) {
    mlog("🔍 DEV MODE: Loading URL: http://localhost:5173");
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    // ✅ PRODUCTION: Load from local HTTP server so Web Workers can fetch() models/WASM
    // file:// protocol doesn't support fetch() in Workers — HTTP server is the fix
    mlog("🔍 PRODUCTION MODE: Loading from http://127.0.0.1:" + frontendPort);
    mainWindow.loadURL(`http://127.0.0.1:${frontendPort}`);
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // ✅ Log load failures
  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription) => {
      mlog("❌ Failed to load:", errorCode, errorDescription);
    }
  );

  // ✅ Log when page finishes loading
  mainWindow.webContents.on("did-finish-load", () => {
    mlog("✅ Page loaded successfully");
  });
}

function startBackend() {
  const backendSrcPath = isDev
    ? path.join(__dirname, "../../backend")
    : path.join(process.resourcesPath, "backend");

  const command = isDev ? "npm" : process.execPath;
  const serverEntry = path.join(backendSrcPath, "src", "server.js");
  const args = isDev ? ["run", "dev"] : [serverEntry];

  // Resolve ffmpeg: bundled first, then downloaded fallback
  const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const bundledFfmpeg = path.join(backendSrcPath, "bin", ffmpegName);
  const fallbackFfmpeg = path.join(backendRootPath, ffmpegName);
  const resolvedFfmpeg = fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : fallbackFfmpeg;

  mlog("🔍 Starting backend from:", backendSrcPath);
  mlog("🔍 FFMPEG_BIN:", resolvedFfmpeg, fs.existsSync(resolvedFfmpeg) ? "✅ EXISTS" : "❌ MISSING");
  mlog("🔍 Command:", command, args.join(" "));

  // ✅ FIX: Build proper PATH with common binary locations
  const systemPaths = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    "/opt/local/bin",
  ];

  const currentPath = process.env.PATH || "";
  const newPath = [...systemPaths, ...currentPath.split(":")]
    .filter(Boolean)
    .join(":");

  // ✅ INJECT USER DATA PATHS INTO BACKEND
  // This tells the backend where to find the dynamic models/binary
  const env = {
    ...process.env,
    PATH: newPath,
    NODE_ENV: isDev ? "development" : "production",
    ELECTRON: "true",
    ELECTRON_RUN_AS_NODE: "1",
    PORT: "4000",
    // DIRECTORY OVERRIDES
    MODELS_DIR_OVERRIDE: modelsPath,
    MEDIAMTX_DIR_OVERRIDE: backendRootPath,
    FFMPEG_BIN: resolvedFfmpeg
  };

  // ✅ CLEANUP: Kill any zombie process on port 4000 before starting
  try {
    if (process.platform !== "win32") {
      mlog("🧹 Cleaning up port 4000...");
      exec("lsof -ti :4000 | xargs kill -9", (err) => {
        if (!err) mlog("✅ Killed zombie process on port 4000");
      });
    }
  } catch (e) {
    mlog("Clean up warning:", e.message);
  }

  backendProcess = spawn(command, args, {
    cwd: backendSrcPath,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: env,
  });

  // Pipe backend output to logs/backend.log
  const backendLog = fs.createWriteStream(LOG.backend, { flags: "a" });
  backendProcess.stdout.on("data", (buf) => {
    backendLog.write(`[${stamp()}] [backend:stdout] ${buf}`);
    console.log("[Backend]", buf.toString().trim());
  });
  backendProcess.stderr.on("data", (buf) => {
    backendLog.write(`[${stamp()}] [backend:stderr] ${buf}`);
    console.error("[Backend Error]", buf.toString().trim());
  });

  backendProcess.on("error", (err) => {
    const line = `[${stamp()}] [backend:error] ${err.stack || err}\n`;
    backendLog.write(line);
    mlog("backend spawn error", err);
  });

  backendProcess.on("exit", (code, signal) => {
    const line = `[${stamp()}] [backend:exit] code=${code} signal=${signal}\n`;
    backendLog.write(line);
    mlog("backend exited", { code, signal });
  });

  mlog("Backend started. Logs:", LOG);
}

// ✅ Ensure bundled binaries have execute permissions
function ensureBinaryPermissions() {
  if (process.platform === "win32") return; // Not needed on Windows

  const backendPath = isDev
    ? path.join(__dirname, "../../backend")
    : path.join(process.resourcesPath, "backend");

  const binaries = [
    path.join(backendPath, "bin", "ffmpeg"),
    path.join(backendRootPath, "mediamtx") // Downloaded mediamtx
  ];

  for (const binPath of binaries) {
    try {
      if (fs.existsSync(binPath)) {
        fs.chmodSync(binPath, "755");
        mlog(`✅ Set execute permission: ${path.basename(binPath)}`);
      }
    } catch (e) {
      mlog(`⚠️ Could not set permission for ${binPath}: ${e.message}`);
    }
  }
}

// ✅ Validate critical dependencies before starting
function validateDependencies() {
  const issues = [];

  const backendPath = isDev
    ? path.join(__dirname, "../../backend")
    : path.join(process.resourcesPath, "backend");

  // Check ffmpeg
  const ffmpegPath = path.join(backendPath, "bin", "ffmpeg");
  if (!fs.existsSync(ffmpegPath)) {
    issues.push(`ffmpeg not found at: ${ffmpegPath}`);
  }

  // Check server.js
  const serverPath = path.join(backendPath, "src", "server.js");
  if (!fs.existsSync(serverPath)) {
    issues.push(`Backend server not found at: ${serverPath}`);
  }

  // Check mediamtx (in app data)
  const mediamtxPath = path.join(backendRootPath, process.platform === "win32" ? "mediamtx.exe" : "mediamtx");
  if (!fs.existsSync(mediamtxPath)) {
    issues.push(`mediamtx not found at: ${mediamtxPath}`);
  }

  if (issues.length > 0) {
    mlog("❌ DEPENDENCY VALIDATION FAILED:");
    issues.forEach(i => mlog(`   - ${i}`));
    return false;
  }

  mlog("✅ All dependencies validated");
  return true;
}

app.whenReady().then(async () => {
  // 0. Check if version changed - clear old models if so
  const versionChanged = checkVersionAndClearIfNeeded();

  // 1. Check & Download Resources
  const missing = await checkResources();
  if (missing.length > 0) {
    mlog("⚠️ Missing resources:", missing);
    const success = await downloadResources(missing);
    if (!success) return; // Exit if failed

    // Save version after successful download
    saveVersion();
  } else {
    mlog("✅ All resources present.");
    // Still save version in case it wasn't saved before
    saveVersion();
  }

  // 2. Set binary permissions
  ensureBinaryPermissions();

  // 3. Validate all dependencies
  if (!validateDependencies()) {
    dialog.showErrorBox(
      "FireAI Setup Error",
      "Some required files are missing. Please reinstall the application.\n\nCheck logs at: " + LOG.dir
    );
    app.quit();
    return;
  }

  // 4. Start frontend HTTP server (production only) + App
  await startFrontendServer();
  createWindow();
  startBackend();

  // ✅ Log Logs location to console for user debugging
  mlog("📂 Logs Directory:", LOG.dir);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
    // ✅ Check if backend is running (fix for MacOS dock click)
    if (!backendProcess) {
      mlog("Re-starting backend on activate...");
      startBackend();
    }
  });
});

app.on("window-all-closed", () => {
  if (backendProcess) {
    backendProcess.kill();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (backendProcess) {
    backendProcess.kill();
  }
  if (frontendServer) {
    frontendServer.close();
  }
});

// Handle backend communication
ipcMain.handle("get-backend-status", async () => {
  return { running: !!backendProcess };
});

ipcMain.handle("get-log-path", async () => {
  return LOG.dir;
});
