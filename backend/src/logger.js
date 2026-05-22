import pino from "pino";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.resolve(__dirname, "../../logs");

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Date-stamped log file so each run is separate
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logFile = path.join(logsDir, `backend-${stamp}.log`);
const eventsFile = path.join(logsDir, "detection-events.jsonl");

// Latest symlink for easy tail -f logs/latest.log
const latestLink = path.join(logsDir, "latest.log");
try {
  if (fs.existsSync(latestLink)) fs.unlinkSync(latestLink);
  fs.symlinkSync(logFile, latestLink);
} catch { /* ignore symlink errors on Windows */ }

const transport = pino.transport({
  targets: [
    { target: "pino/file", level: "info", options: { destination: logFile } },
    { target: "pino/file", level: "info", options: { destination: 1 /* stdout */ } },
  ],
});

export function makeLogger(name) {
  return pino({ name }, transport);
}

// Re-export the events log path so server.js can use it
export { eventsFile };
