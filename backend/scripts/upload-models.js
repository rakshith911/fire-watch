
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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

async function uploadFile(fileName) {
    const filePath = path.join(MODELS_DIR, fileName);
    const fileContent = fs.readFileSync(filePath);

    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: fileContent,
    });

    try {
        await s3.send(command);
        console.log(`✅ Uploaded ${fileName} to ${BUCKET_NAME}`);
    } catch (err) {
        console.error(`❌ Failed to upload ${fileName}:`, err);
    }
}

async function main() {
    if (!BUCKET_NAME) {
        console.error("❌ Error: S3_BUCKET_MODELS is not defined in .env");
        process.exit(1);
    }

    console.log(`🚀 Uploading models from ${MODELS_DIR} to S3 bucket: ${BUCKET_NAME}`);

    if (!fs.existsSync(MODELS_DIR)) {
        console.error("❌ Models directory not found!");
        process.exit(1);
    }

    const files = fs.readdirSync(MODELS_DIR).filter(f => f.endsWith(".onnx"));

    if (files.length === 0) {
        console.log("⚠️ No .onnx files found to upload.");
        return;
    }

    for (const file of files) {
        await uploadFile(file);
    }

    console.log("✨ All uploads complete!");
}

main();
