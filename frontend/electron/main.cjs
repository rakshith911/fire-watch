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
ensureDir(modelsPath);
ensureDir(backendRootPath);

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

// ✅ CHECK RESOURCES
async function checkResources() {
  const REQUIRED_FILES = [
    "best.onnx",
    "yolov11n_bestFire.onnx",
    "theft.onnx",
    "weapons.onnx",
    "depth_anything_v2_small.onnx"
  ];

  // Also check for mediamtx binary
  const binaryName = process.platform === "win32" ? "mediamtx.exe" : "mediamtx";

  const missing = [];

  // Check models
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(modelsPath, file))) {
      missing.push({ type: "model", name: file });
    }
  }

  // Check binary
  if (!fs.existsSync(path.join(backendRootPath, binaryName))) {
    missing.push({ type: "binary", name: binaryName });
  }

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

      // 3. Make executable if binary
      if (file.type === "binary" && process.platform !== "win32") {
        fs.chmodSync(targetPath, "755");
      }

      mlog(`✅ Downloaded: ${file.name}`);
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
    // ✅ PRODUCTION: Load from built files
    const indexPath = path.join(__dirname, "../dist/index.html");
    mlog("🔍 PRODUCTION MODE: Loading file:", indexPath);
    mainWindow.loadFile(indexPath);

    // ✅ DEBUG: Open DevTools in production to help user debug
    mainWindow.webContents.openDevTools();
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

  mlog("🔍 Starting backend from:", backendSrcPath);
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
    MEDIAMTX_DIR_OVERRIDE: backendRootPath
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

app.whenReady().then(async () => {
  // 1. Check & Download Resources
  const missing = await checkResources();
  if (missing.length > 0) {
    mlog("⚠️ Missing resources:", missing);
    const success = await downloadResources(missing);
    if (!success) return; // Exit if failed
  } else {
    mlog("✅ All resources present.");
  }

  // 2. Start App
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
});

// Handle backend communication
ipcMain.handle("get-backend-status", async () => {
  return { running: !!backendProcess };
});

ipcMain.handle("get-log-path", async () => {
  return LOG.dir;
});
