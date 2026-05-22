import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { makeLogger } from "../logger.js";

const log = makeLogger("s3-service");

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const S3_BUCKET = process.env.S3_BUCKET || "fire-alert-frames";

/**
 * Draw bounding boxes on a JPEG frame using sharp + SVG overlay.
 * @param {Buffer} imageBuffer - raw JPEG buffer
 * @param {Array} boxes - [[x1,y1,x2,y2,label,confidence], ...]
 * @returns {Promise<Buffer>} annotated JPEG buffer
 */
async function annotateFrame(imageBuffer, boxes) {
  if (!boxes || boxes.length === 0) return imageBuffer;

  const meta = await sharp(imageBuffer).metadata();
  const { width, height } = meta;

  log.info({ width, height, boxCount: boxes.length, firstBox: boxes[0] }, "SVG annotation dimensions");

  const rects = boxes.map(([x1, y1, x2, y2, label, confidence]) => {
    const isWeapon = label && label.toLowerCase().includes("weapon");
    const stroke = isWeapon ? "#3399FF" : "#FF3333";
    const fillColor = isWeapon ? "#3399FF" : "#FF3333";
    const labelText = `${label || "detection"} ${((confidence || 0) * 100).toFixed(0)}%`;

    // Clamp coordinates
    const cx1 = Math.max(0, Math.round(x1));
    const cy1 = Math.max(0, Math.round(y1));
    const cx2 = Math.min(width, Math.round(x2));
    const cy2 = Math.min(height, Math.round(y2));
    const bw = cx2 - cx1;
    const bh = cy2 - cy1;

    const labelW = labelText.length * 9 + 16;
    const labelH = 24;
    const labelY = cy1 - labelH > 0 ? cy1 - labelH : cy1;

    // Use fill-opacity instead of rgba() for SVG 1.1 / librsvg compatibility
    return `
      <rect x="${cx1}" y="${cy1}" width="${bw}" height="${bh}"
            fill="${fillColor}" fill-opacity="0.15" stroke="${stroke}" stroke-width="3"/>
      <rect x="${cx1}" y="${labelY}" width="${labelW}" height="${labelH}"
            fill="${fillColor}" rx="4" ry="4"/>
      <text x="${cx1 + 8}" y="${labelY + 17}"
            font-family="Arial,sans-serif" font-size="14" font-weight="bold"
            fill="white">${labelText}</text>
    `;
  }).join("");

  const svgOverlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`
  );

  // Pre-render SVG to PNG at exact image dimensions
  // resize() guarantees pixel-perfect match regardless of DPI interpretation
  const svgImage = await sharp(svgOverlay, { density: 72 })
    .resize(width, height)
    .png()
    .toBuffer();

  return sharp(imageBuffer)
    .composite([{ input: svgImage, top: 0, left: 0 }])
    .jpeg()
    .toBuffer();
}

export async function uploadFireFrame(cameraId, imageBuffer, boxes) {
  try {
    const now = new Date();
    const datePath = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const timeStr = now
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")[1]
      .split(".")[0]; // HH-MM-SS
    const s3Key = `${cameraId}/${datePath}/frame_${timeStr}.jpg`;

    // Annotate the frame with bounding boxes before uploading
    let finalBuffer = imageBuffer;
    if (boxes && boxes.length > 0) {
      try {
        finalBuffer = await annotateFrame(imageBuffer, boxes);
        log.info({ cameraId, boxCount: boxes.length }, "Annotated frame with bounding boxes");
      } catch (annotateErr) {
        log.warn({ cameraId, error: annotateErr.message }, "Failed to annotate frame, uploading raw");
      }
    }

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: finalBuffer,
      ContentType: "image/jpeg",
    });

    await s3Client.send(command);

    const imageUrl = `https://${S3_BUCKET}.s3.amazonaws.com/${s3Key}`;

    log.info({ cameraId, s3Key, imageUrl }, "Fire frame uploaded to S3");
    return imageUrl;
  } catch (error) {
    log.error(
      { cameraId, error: error.message },
      "Failed to upload frame to S3"
    );
    throw error;
  }
}
