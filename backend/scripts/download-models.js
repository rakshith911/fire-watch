
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../");

// Load .env from backend root
dotenv.config({ path: path.join(BACKEND_ROOT, ".env") });

const s3 = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const BUCKET_NAME = process.env.S3_BUCKET_MODELS;
const MODELS_DIR = path.join(BACKEND_ROOT, "models");

if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
}

async function downloadFile(fileName) {
    const filePath = path.join(MODELS_DIR, fileName);

    console.log(`⬇️  Downloading ${fileName}...`);

    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
    });

    try {
        const response = await s3.send(command);
        await pipeline(response.Body, fs.createWriteStream(filePath));
        console.log(`✅ Downloaded ${fileName}`);
    } catch (err) {
        console.error(`❌ Failed to download ${fileName}:`, err);
        throw err;
    }
}

async function main() {
    if (!BUCKET_NAME) {
        console.error("❌ Error: S3_BUCKET_MODELS is not defined in .env");
        process.exit(1);
    }

    console.log(`🚀 Checking models in ${MODELS_DIR} against S3 bucket: ${BUCKET_NAME}`);

    try {
        const listCmd = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
        const data = await s3.send(listCmd);

        if (!data.Contents || data.Contents.length === 0) {
            console.log("⚠️ Bucket is empty.");
            return;
        }

        const allowedModels = ["best.onnx", "weapons.onnx", "depth_anything_v2_small.onnx"];

        for (const item of data.Contents) {
            const fileName = item.Key;
            if (!fileName.endsWith(".onnx")) continue;
            if (!allowedModels.includes(fileName)) {
                console.log(`⏭️ Skipping ${fileName} (not in allowed models list)`);
                continue;
            }

            const filePath = path.join(MODELS_DIR, fileName);

            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                if (stats.size === item.Size) {
                    console.log(`✅ ${fileName} already exists and matches size. Skipping.`);
                    continue;
                } else {
                    console.log(`🔄 ${fileName} size mismatch (Local: ${stats.size}, Remote: ${item.Size}). Re-downloading.`);
                }
            }

            await downloadFile(fileName);
        }

        console.log("✨ Model sync complete!");

    } catch (err) {
        console.error("❌ Error listing or downloading models:", err);
        process.exit(1);
    }
}

main();
