// modelDownloader.js — unified ONNX model download from S3 with public URL fallback

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import pino from "pino";

const log = pino({ name: "model-downloader" });

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const MODELS_BUCKET = process.env.S3_MODELS_BUCKET || process.env.S3_BUCKET_MODELS || "firewatch-models";

// Model registry: name → { s3Key, fallbackUrl }
// s3Key uses flat convention matching existing upload-models.js / download-models.js scripts
export const MODEL_REGISTRY = {
  "yolov8n.onnx": {
    s3Key: "yolov8n.onnx",
    fallbackUrl: "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.onnx",
    purpose: "Person Detection",
  },
  "yolov8n-pose.onnx": {
    s3Key: "yolov8n-pose.onnx",
    fallbackUrl: "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n-pose.onnx",
    purpose: "Pose Estimation (dancing / suspicious)",
  },
};

function followRedirects(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error("Too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, { headers: { "User-Agent": "firewatch/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        return followRedirects(res.headers.location, dest, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const file = fs.createWriteStream(dest);
      pipeline(res, file).then(resolve).catch(reject);
    }).on("error", reject);
  });
}

async function downloadFromS3(modelName, dest) {
  const entry = MODEL_REGISTRY[modelName];
  if (!entry) throw new Error(`Unknown model: ${modelName}`);
  if (!process.env.AWS_ACCESS_KEY_ID) throw new Error("No AWS credentials");

  log.info({ bucket: MODELS_BUCKET, key: entry.s3Key }, `Downloading ${modelName} from S3…`);
  const cmd = new GetObjectCommand({ Bucket: MODELS_BUCKET, Key: entry.s3Key });
  const { Body } = await s3.send(cmd);
  const file = fs.createWriteStream(dest);
  await pipeline(Body, file);
  log.info(`${modelName} downloaded from S3`);
}

async function downloadFromUrl(modelName, dest) {
  const entry = MODEL_REGISTRY[modelName];
  if (!entry?.fallbackUrl) throw new Error(`No fallback URL for ${modelName}`);
  log.info({ url: entry.fallbackUrl }, `Downloading ${modelName} from public URL…`);
  await followRedirects(entry.fallbackUrl, dest);
  log.info(`${modelName} downloaded from public URL`);
}

/**
 * Ensure a model file exists in modelsDir.
 * Tries S3 first, falls back to public URL.
 */
export async function ensureModel(modelName, modelsDir) {
  const dest = path.join(modelsDir, modelName);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(modelsDir, { recursive: true });
  const tmp = dest + ".tmp";

  try {
    await downloadFromS3(modelName, tmp);
  } catch (s3Err) {
    log.warn({ error: s3Err.message }, `S3 download failed for ${modelName}, trying public URL`);
    try {
      await downloadFromUrl(modelName, tmp);
    } catch (urlErr) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Failed to download ${modelName}: ${urlErr.message}`);
    }
  }

  fs.renameSync(tmp, dest);
  return dest;
}
