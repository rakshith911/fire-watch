
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
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

// Models to upload — those with a publicUrl are auto-fetched if not already local
const MODELS = [
    { file: "best.onnx",                    publicUrl: null },
    { file: "best_s.onnx",                  publicUrl: null },
    { file: "weapons.onnx",                 publicUrl: null },
    { file: "weapons_yolo.onnx",            publicUrl: null },
    { file: "knife_yolov8n.onnx",           publicUrl: null },
    { file: "mask_yolov5.onnx",             publicUrl: null },
    { file: "depth_anything_v2_small.onnx", publicUrl: null },
    { file: "yolov8n.onnx",                 publicUrl: "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.onnx" },
    { file: "yolov8n-pose.onnx",            publicUrl: "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n-pose.onnx" },
];

function followRedirects(url, dest, n = 0) {
    return new Promise((resolve, reject) => {
        if (n > 8) return reject(new Error("Too many redirects"));
        const mod = url.startsWith("https") ? https : http;
        mod.get(url, { headers: { "User-Agent": "firewatch/1.0" } }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode))
                return followRedirects(res.headers.location, dest, n + 1).then(resolve).catch(reject);
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            pipeline(res, fs.createWriteStream(dest)).then(resolve).catch(reject);
        }).on("error", reject);
    });
}

async function alreadyOnS3(key) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
        return true;
    } catch { return false; }
}

async function uploadFile(filePath, key) {
    const body = fs.readFileSync(filePath);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: body }));
    const sizeMB = (body.length / 1024 / 1024).toFixed(1);
    console.log(`✅ Uploaded ${key} (${sizeMB} MB) → s3://${BUCKET_NAME}/${key}`);
}

async function main() {
    if (!BUCKET_NAME) {
        console.error("❌ S3_BUCKET_MODELS / S3_MODELS_BUCKET is not set in .env");
        process.exit(1);
    }

    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log(`🚀 Uploading models to s3://${BUCKET_NAME}/`);

    for (const { file, publicUrl } of MODELS) {
        const localPath = path.join(MODELS_DIR, file);

        // Fetch from public URL if not local
        if (!fs.existsSync(localPath)) {
            if (!publicUrl) {
                console.warn(`⚠️  ${file} missing locally and no public URL — skipping`);
                continue;
            }
            console.log(`⬇️  Fetching ${file} from public URL…`);
            const tmp = localPath + ".tmp";
            try {
                await followRedirects(publicUrl, tmp);
                fs.renameSync(tmp, localPath);
                console.log(`   Fetched ${file}`);
            } catch (err) {
                fs.rmSync(tmp, { force: true });
                console.error(`❌ Could not fetch ${file}: ${err.message}`);
                continue;
            }
        }

        // Skip if already on S3 (same key)
        if (await alreadyOnS3(file)) {
            const sizeMB = (fs.statSync(localPath).size / 1024 / 1024).toFixed(1);
            console.log(`⏭️  ${file} already in S3 (${sizeMB} MB local) — skipping`);
            continue;
        }

        try {
            await uploadFile(localPath, file);
        } catch (err) {
            console.error(`❌ Failed to upload ${file}: ${err.message}`);
        }
    }

    console.log("✨ Upload complete!");
}

main();
