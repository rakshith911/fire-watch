
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../");

dotenv.config({ path: path.join(BACKEND_ROOT, ".env") });

const s3 = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const BUCKET_NAME = process.env.S3_BUCKET_MODELS || process.env.S3_MODELS_BUCKET;
const MODELS_DIR = path.join(BACKEND_ROOT, "models");

if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
}

// All models the app needs — S3 key → fallback public URL
const REQUIRED_MODELS = {
    "best.onnx":                    { fallback: null },
    "best_s.onnx":                  { fallback: null },
    "weapons.onnx":                 { fallback: null },
    "weapons_yolo.onnx":            { fallback: null },
    "knife_yolov8n.onnx":           { fallback: null },
    "mask_yolov5.onnx":             { fallback: null },
    "depth_anything_v2_small.onnx": { fallback: null },
    "yolov8n.onnx":                 { fallback: "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.onnx" },
    "yolov8n-pose.onnx":            { fallback: "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n-pose.onnx" },
};

function followRedirects(url, dest, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 8) return reject(new Error("Too many redirects"));
        const mod = url.startsWith("https") ? https : http;
        mod.get(url, { headers: { "User-Agent": "firewatch/1.0" } }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                return followRedirects(res.headers.location, dest, redirectCount + 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const file = fs.createWriteStream(dest);
            pipeline(res, file).then(resolve).catch(reject);
        }).on("error", reject);
    });
}

async function downloadFromS3(key, filePath) {
    const cmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
    const response = await s3.send(cmd);
    await pipeline(response.Body, fs.createWriteStream(filePath));
}

async function main() {
    if (!BUCKET_NAME) {
        console.error("❌ S3_BUCKET_MODELS is not set in .env");
        process.exit(1);
    }

    console.log(`🚀 Syncing models → ${MODELS_DIR} from bucket: ${BUCKET_NAME}`);

    // List what's actually in the bucket
    let s3Keys = new Set();
    try {
        const listCmd = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
        const data = await s3.send(listCmd);
        for (const obj of (data.Contents || [])) s3Keys.add(obj.Key);
    } catch (err) {
        console.warn("⚠️  Could not list bucket (credentials issue?). Will try direct S3 gets.");
    }

    for (const [fileName, { fallback }] of Object.entries(REQUIRED_MODELS)) {
        const filePath = path.join(MODELS_DIR, fileName);

        if (fs.existsSync(filePath)) {
            const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
            console.log(`✅ ${fileName} already present (${sizeMB} MB)`);
            continue;
        }

        const tmp = filePath + ".tmp";
        let downloaded = false;

        // Try S3 first
        if (s3Keys.has(fileName) || !s3Keys.size) {
            try {
                console.log(`⬇️  ${fileName} ← S3`);
                await downloadFromS3(fileName, tmp);
                fs.renameSync(tmp, filePath);
                console.log(`✅ ${fileName} saved`);
                downloaded = true;
            } catch (err) {
                console.warn(`   S3 failed: ${err.message}`);
                fs.rmSync(tmp, { force: true });
            }
        }

        // Fallback to public URL
        if (!downloaded && fallback) {
            try {
                console.log(`⬇️  ${fileName} ← public URL`);
                await followRedirects(fallback, tmp);
                fs.renameSync(tmp, filePath);
                const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
                console.log(`✅ ${fileName} saved (${sizeMB} MB)`);
                downloaded = true;
            } catch (err) {
                fs.rmSync(tmp, { force: true });
                console.error(`❌ ${fileName}: ${err.message}`);
            }
        }

        if (!downloaded) {
            console.error(`❌ ${fileName} could not be downloaded — place it manually in ${MODELS_DIR}`);
        }
    }

    console.log("✨ Model sync complete!");
}

main();
