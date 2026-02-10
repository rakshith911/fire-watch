import * as ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(msg, data) {
    if (data) console.log(msg, JSON.stringify(data));
    else console.log(msg);
}

class LivenessValidator {
    constructor() {
        // Path to the depth model - check for Electron override first
        if (process.env.MODELS_DIR_OVERRIDE) {
            this.modelPath = path.join(process.env.MODELS_DIR_OVERRIDE, "depth_anything_v2_small.onnx");
        } else {
            this.modelPath = path.resolve(__dirname, "../../models/depth_anything_v2_small.onnx");
        }
        this.session = null;
        // Normalization constants for Depth Anything V2
        this.mean = [0.485, 0.456, 0.406];
        this.std = [0.229, 0.224, 0.225];
    }

    async init() {
        if (!this.session) {
            if (!fs.existsSync(this.modelPath)) {
                console.error(`[LivenessValidator] Model not found at: ${this.modelPath}`);
                return;
            }
            try {
                this.session = await ort.InferenceSession.create(this.modelPath);
                console.log('[LivenessValidator] Depth model loaded successfully.');
            } catch (err) {
                console.error('[LivenessValidator] Failed to load depth model:', err);
            }
        }
    }

    // Preprocess image for ONNX (Resize 518x518 -> Normalize -> HWC to CHW)
    async preprocess(imageBuffer) {
        const { data, info } = await sharp(imageBuffer)
            .resize(518, 518, { fit: 'fill' })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const float32Data = new Float32Array(3 * 518 * 518);

        for (let i = 0; i < 518 * 518; i++) {
            for (let c = 0; c < 3; c++) {
                let val = data[i * 3 + c] / 255.0;
                val = (val - this.mean[c]) / this.std[c];
                float32Data[c * 518 * 518 + i] = val;
            }
        }
        return new ort.Tensor('float32', float32Data, [1, 3, 518, 518]);
    }

    async isWeapon3D(imageBuffer, bbox) {
        // Returns TRUE if Real (3D), FALSE if Fake (2D)
        if (!this.session) await this.init();
        if (!this.session) return true; // Fail safe: assume real if model broken

        try {
            // 1. Run Inference
            const inputTensor = await this.preprocess(imageBuffer);
            const feeds = {};
            feeds[this.session.inputNames[0]] = inputTensor;
            const results = await this.session.run(feeds);
            const output = results[this.session.outputNames[0]].data;

            // 2. Map bbox (relative to original img) to 518x518 map
            const metadata = await sharp(imageBuffer).metadata();
            const scaleX = 518 / metadata.width;
            const scaleY = 518 / metadata.height;

            // bbox is [x1, y1, x2, y2] based on detectionQueue usage
            // Convert to x, y, w, h for calculation if needed, but here we just need bounds
            const x1 = bbox[0];
            const y1 = bbox[1];
            const x2 = bbox[2];
            const y2 = bbox[3];

            const fullBx = Math.floor(x1 * scaleX);
            const fullBy = Math.floor(y1 * scaleY);
            const fullBw = Math.floor((x2 - x1) * scaleX);
            const fullBh = Math.floor((y2 - y1) * scaleY);

            // 3. Shrink bbox to center 40% to focus on the actual object
            // The full bbox often includes lots of background which has natural
            // 3D depth variation, causing flat images to pass as "3D"
            const shrink = 0.3; // 30% margin on each side → center 40%
            const bx = Math.floor(fullBx + fullBw * shrink);
            const by = Math.floor(fullBy + fullBh * shrink);
            const bw = Math.floor(fullBw * (1 - 2 * shrink));
            const bh = Math.floor(fullBh * (1 - 2 * shrink));

            // 4. Sample depth values INSIDE the shrunk box
            const insideValues = [];
            for (let y = by; y < by + bh; y++) {
                for (let x = bx; x < bx + bw; x++) {
                    if (y >= 0 && y < 518 && x >= 0 && x < 518) {
                        insideValues.push(output[y * 518 + x]);
                    }
                }
            }

            if (insideValues.length === 0) return false;

            // 5. Calculate stdDev inside the shrunk box
            const insideMean = insideValues.reduce((a, b) => a + b, 0) / insideValues.length;
            const insideVar = insideValues.reduce((a, b) => a + Math.pow(b - insideMean, 2), 0) / insideValues.length;
            const insideStdDev = Math.sqrt(insideVar);

            // 6. Sample depth in a ring OUTSIDE the bbox for comparison
            const expand = 0.15;
            const ox1 = Math.max(0, Math.floor(fullBx - fullBw * expand));
            const oy1 = Math.max(0, Math.floor(fullBy - fullBh * expand));
            const ox2 = Math.min(518, Math.floor(fullBx + fullBw + fullBw * expand));
            const oy2 = Math.min(518, Math.floor(fullBy + fullBh + fullBh * expand));
            const outsideValues = [];
            for (let y = oy1; y < oy2; y++) {
                for (let x = ox1; x < ox2; x++) {
                    // Only pixels OUTSIDE the original full bbox
                    if (x >= fullBx && x < fullBx + fullBw && y >= fullBy && y < fullBy + fullBh) continue;
                    if (y >= 0 && y < 518 && x >= 0 && x < 518) {
                        outsideValues.push(output[y * 518 + x]);
                    }
                }
            }

            const outsideMean = outsideValues.length > 0
                ? outsideValues.reduce((a, b) => a + b, 0) / outsideValues.length
                : insideMean;

            // 7. Depth difference: real 3D object stands out from background
            const depthDiff = Math.abs(insideMean - outsideMean);

            // Min/Max for debugging (avoid spread to prevent stack overflow)
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < insideValues.length; i++) {
                if (insideValues[i] < min) min = insideValues[i];
                if (insideValues[i] > max) max = insideValues[i];
            }

            // 8. ULTRA-CENTER flatness check (phone screen detection)
            // Even if the overall bbox looks 3D (hand holding phone adds depth variation),
            // the very center of a phone screen is dead flat. A real knife blade has
            // subtle depth variation from angle, curvature, and reflections.
            const ultraShrink = 0.4; // 40% margin each side → center 20% of bbox
            const ucx = Math.floor(fullBx + fullBw * ultraShrink);
            const ucy = Math.floor(fullBy + fullBh * ultraShrink);
            const ucw = Math.floor(fullBw * (1 - 2 * ultraShrink));
            const uch = Math.floor(fullBh * (1 - 2 * ultraShrink));
            const ultraCenterValues = [];
            for (let y = ucy; y < ucy + uch; y++) {
                for (let x = ucx; x < ucx + ucw; x++) {
                    if (y >= 0 && y < 518 && x >= 0 && x < 518) {
                        ultraCenterValues.push(output[y * 518 + x]);
                    }
                }
            }

            let ultraCenterStdDev = 0;
            if (ultraCenterValues.length > 0) {
                const ucMean = ultraCenterValues.reduce((a, b) => a + b, 0) / ultraCenterValues.length;
                const ucVar = ultraCenterValues.reduce((a, b) => a + Math.pow(b - ucMean, 2), 0) / ultraCenterValues.length;
                ultraCenterStdDev = Math.sqrt(ucVar);
            }

            // Decision logic:
            const DEPTH_THRESHOLD = 0.15;     // center region depth variance
            const DIFF_THRESHOLD = 0.3;        // depth difference vs background
            const FLAT_SCREEN_THRESHOLD = 0.05; // ultra-center flatness (phone screen)

            const passes3D = insideStdDev > DEPTH_THRESHOLD || depthDiff > DIFF_THRESHOLD;
            // Phone screen trap: bbox looks 3D overall (hand included) but the
            // ultra-center is perfectly flat (screen surface)
            const isFlatScreen = ultraCenterStdDev < FLAT_SCREEN_THRESHOLD && depthDiff > DIFF_THRESHOLD;
            const is3D = passes3D && !isFlatScreen;

            console.log(`[Liveness] 🔍 DEPTH ANALYSIS: insideStdDev=${insideStdDev.toFixed(4)}, depthDiff=${depthDiff.toFixed(4)}, ultraCenterStdDev=${ultraCenterStdDev.toFixed(4)}, insideMean=${insideMean.toFixed(4)}, outsideMean=${outsideMean.toFixed(4)}, threshold=${DEPTH_THRESHOLD}/${DIFF_THRESHOLD}/${FLAT_SCREEN_THRESHOLD}, min=${min.toFixed(4)}, max=${max.toFixed(4)}, pixels=${insideValues.length}(inside)/${outsideValues.length}(outside)/${ultraCenterValues.length}(ultraCenter), RESULT=${is3D ? '3D_REAL' : isFlatScreen ? '2D_PHONE_SCREEN' : '2D_FLAT'}`);

            return is3D;
        } catch (err) {
            console.error("[Liveness] Error processing weapon depth:", err);
            return true; // Fail safe
        }
    }

    async isFireMoving(framesBuffer, bboxes) {
        // Expects array of 3 image buffers (JPEGs)
        if (framesBuffer.length < 3) return false; // Need more frames to decide

        try {
            // Check if bboxes is an array of boxes or a single box (legacy support/fallback)
            // If it's a single box [x1, y1, x2, y2], wrap it
            let boxes = bboxes;
            if (bboxes.length > 0 && typeof bboxes[0] === 'number') {
                boxes = framesBuffer.map(() => bboxes);
            }

            // Crop the fire region from all 3 frames using PER-FRAME boxes
            // This stabilizes the view: if the camera moves but the detector tracks the fire,
            // the crop should contain the fire in the same relative position.
            const crops = await Promise.all(framesBuffer.map(async (buf, i) => {
                // Use the box for this frame, or fallback to the first one available
                // If we have fewer boxes than frames (shouldn't happen), used the last known box
                const bbox = boxes[Math.min(i, boxes.length - 1)];

                const x1 = Math.max(0, Math.floor(bbox[0]));
                const y1 = Math.max(0, Math.floor(bbox[1]));
                const width = Math.floor(bbox[2] - bbox[0]);
                const height = Math.floor(bbox[3] - bbox[1]);

                if (width <= 0 || height <= 0) {
                    // Return empty buffer or handle error? 
                    // Sharp might throw on zero width. Let's return a blank 100x100.
                    return Buffer.alloc(100 * 100, 0);
                }

                return sharp(buf)
                    .extract({
                        left: x1,
                        top: y1,
                        width: width,
                        height: height
                    })
                    .greyscale()
                    .resize(100, 100, { fit: 'fill' }) // Normalize size for speed
                    .raw()
                    .toBuffer();
            }));

            // Compare pixels between consecutive frames
            let movingPixels = 0;
            let totalDiffMagnitude = 0;
            const totalPixels = crops[0].length;
            // Threshold 20: Increased from 15 to 20 to reduce false positives from compression artifacts
            // Real fire movement produces differences of 40-100+
            const diffThreshold = 20;

            for (let i = 0; i < totalPixels; i++) {
                const d1 = Math.abs(crops[0][i] - crops[1][i]);
                const d2 = Math.abs(crops[1][i] - crops[2][i]);

                // If it changed significantly in both consecutive pairs, it's flickering
                if (d1 > diffThreshold && d2 > diffThreshold) {
                    movingPixels++;
                    totalDiffMagnitude += (d1 + d2) / 2;
                }
            }

            const ratio = movingPixels / totalPixels;
            const avgDiff = movingPixels > 0 ? totalDiffMagnitude / movingPixels : 0;
            console.log(`[Liveness] Fire Motion: ratio=${ratio.toFixed(5)} (${movingPixels}/${totalPixels} pixels), avgDiff=${avgDiff.toFixed(1)}`);

            // Return ratio instead of boolean — caller uses context-dependent thresholds:
            // - Moving boxes (IoU < 0.85): ratio > 0.10 (10%) = real fire
            // - Static boxes (IoU > 0.85): ratio > 0.25 (25%) = real fire in fixed location
            //   Phone screens produce ~0.05-0.14, real fire produces 0.25-0.50+
            return ratio;
        } catch (err) {
            console.error("[Liveness] Error processing fire motion:", err);
            return 0; // Return 0 ratio on error
        }
    }
}

export default new LivenessValidator();
