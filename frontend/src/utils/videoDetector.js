// public/videoPlayer.js  (ES module friendly)
// Requires Hls.js on the page.
// Usage:
//   const d = new VideoDetector({ source: "output/stream.m3u8", mount: "#grid", id: "cam-1" });
//   await d.start();

export class VideoDetector {
  constructor({
    source, // HLS URL (or MP4). For step 1 we assume HLS like your current flow.
    id, // unique id for this instance
    mount, // CSS selector or HTMLElement where we'll append the video/canvas UI
    workerUrl = "/src/utils/worker-client.js",
    modelInputSize = 640, // YOLO input side (square)
    throttleMs = 60, // ~16ms=60fps, 33ms=30fps, 60ms~16fps
    onDetections = () => {}, // callback(boxes) per frame
  }) {
    this.source = source;
    this.id = id || `detector-${Math.random().toString(36).slice(2)}`;
    this.workerUrl = workerUrl;
    this.modelInputSize = modelInputSize;
    this.throttleMs = throttleMs;
    this.onDetections = onDetections;
    this.enabled = true;

    this._root =
      typeof mount === "string"
        ? document.querySelector(mount)
        : mount || document.body;
    this._video = null;
    this._overlay = null;
    this._ctx = null;
    this._hls = null;
    this._worker = null;

    // per-instance state (no globals)
    this._busy = false;
    this._rafHandle = null;
    this._lastTick = 0;
    this._boxes = [];

    // detection history
    this._detectionHistory = []; // booleans
    this._fireAreasHistory = [];
    this._fireIncreaseHistory = [];
    this._MAX_FRAMES = 10;
    this._MAX_FRAMES_HISTORY = 10;
    this._THRESHOLD = 0.8; // 80%
    this._AREA_INCREASE_PERCENT = 0.5; // 50%
    // this.detectionHistory = [];          // booleans
    // this.fireAreasHistory = [];
    // this.fireIncreaseHistory = [];
    // this.MAX_FRAMES = 10;
    // this.MAX_FRAMES_HISTORY = 10;
    // this.THRESHOLD = 0.8;                // 80%
    // this.AREA_INCREASE_PERCENT = 0.5;    // 50%
  }

  setEnabled(val) {
    this.enabled = !!val;
  }

  render() {
    // new
    if (!this._container) this._buildUI();
    return this._container;
  }

  async start() {
    this.render(); // make sure UI exists
    await this._attachStream();
    this._spawnWorker();
    this._bindVideoLoop();
  }

  stop() {
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }

  destroy() {
    this.stop();
    if (this._root && this._container) this._root.removeChild(this._container);
  }

  // async attachWebRTC(stream) {
  //   this.render(); // ensure video/canvas exist
  //   const setSizes = () => {
  //     if (!this._video.videoWidth) return;
  //     this._overlay.width  = this._video.videoWidth;
  //     this._overlay.height = this._video.videoHeight;
  //   };
  //   this._video.srcObject = stream;
  //   this._video.addEventListener('loadedmetadata', setSizes, { once: true });
  //   try { await this._video.play(); } catch {}
  //   if (!this._worker) this._spawnWorker();
  //   this._bindVideoLoop();
  // }

  async attachWebRTC(stream) {
    this.render(); // ensure UI exists

    const v = this._video;

    // 1) Wire the stream and common flags
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true;
    v.srcObject = stream;

    // 2) Keep overlay canvas in sync with video dimensions
    const setSizes = () => {
      if (!v.videoWidth) return;
      this._overlay.width = v.videoWidth;
      this._overlay.height = v.videoHeight;
    };
    v.addEventListener("loadedmetadata", setSizes);
    v.addEventListener("resize", setSizes);

    // 3) Make sure the worker exists before the loop
    if (!this._worker) this._spawnWorker();

    // 4) Bind the loop BEFORE attempting to play (so we don't miss the 'play' event)
    this._bindVideoLoop();

    // 5) Kick playback; if it's already playing, start the loop immediately
    try {
      await v.play();
    } catch (_) {
      /* UI play button may handle */
    }
    if (!v.paused && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      // ensure the first tick happens even if 'play' already fired
      if (!this._rafHandle)
        this._rafHandle = requestAnimationFrame(
          (t) => (this._lastTick = t - this.throttleMs - 1)
        );
    }
  }

  // ————— internal helpers —————
  _buildUI() {
    const container = document.createElement("div");
    container.className = "detector rounded-xl shadow p-2";
    container.style.position = "relative";
    container.style.background = "#000";
    container.style.display = "grid";
    container.style.gridTemplateRows = "auto auto";
    container.style.gap = "6px";

    const header = document.createElement("div");
    header.textContent = this.id;
    header.style.color = "white";
    header.style.font = "600 14px system-ui";
    header.style.opacity = "0.85";

    const video = document.createElement("video");
    video.id = `${this.id}-video`;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.style.width = "100%";
    video.style.height = "auto";
    video.style.display = "block";
    video.crossOrigin = "anonymous";

    const canvas = document.createElement("canvas");
    canvas.id = `${this.id}-overlay`;
    canvas.style.position = "absolute";
    canvas.style.inset = "22px 2px 2px 2px"; // under header
    canvas.style.pointerEvents = "none";
    canvas.style.display = "block";

    const stage = document.createElement("div");
    stage.style.position = "relative";
    stage.appendChild(video);
    stage.appendChild(canvas);

    container.appendChild(header);
    container.appendChild(stage);

    this._root.appendChild(container);

    this._container = container;
    this._video = video;
    this._overlay = canvas;
    this._ctx = canvas.getContext("2d");
  }

  async _attachStream() {
    const LIVE_STREAM_URL = this.source;
    const isHls = /\.m3u8(\?|$)/i.test(LIVE_STREAM_URL);
    console.log(this.id, "attach", { url: LIVE_STREAM_URL, isHls });

    const setSizes = () => {
      if (!this._video.videoWidth) return;
      this._overlay.width = this._video.videoWidth;
      this._overlay.height = this._video.videoHeight;
    };

    // ── HLS ONLY if the URL is actually an HLS playlist ──────────────────────────
    if (isHls && window.Hls && window.Hls.isSupported()) {
      this._hls = new Hls({
        liveDurationInfinity: true,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      this._hls.loadSource(LIVE_STREAM_URL);
      this._hls.attachMedia(this._video);
      this._hls.on(Hls.Events.MANIFEST_PARSED, () => this._video.play());
      this._video.addEventListener("loadedmetadata", setSizes);
      console.log(`[${this.id}] using Hls.js`);
      return;
    }

    // Native HLS (Safari)
    if (isHls && this._video.canPlayType("application/vnd.apple.mpegurl")) {
      this._video.src = LIVE_STREAM_URL;
      this._video.addEventListener("loadedmetadata", () => {
        setSizes();
        this._video.play().catch(() => {
          /* show play button if you want */
        });
      });
      console.log(`[${this.id}] using native HLS`);
      return;
    }

    // ── MP4 / non-HLS fallback ───────────────────────────────────────────────────
    this._video.src = LIVE_STREAM_URL;
    this._video.addEventListener("loadedmetadata", () => {
      setSizes();
      const p = this._video.play();
      if (p && p.catch) {
        p.catch(() => {
          const btn = this._container?.querySelector(".play-button");
          if (btn) btn.style.display = "block"; // autoplay blocked
        });
      }
    });
    this._video.addEventListener("error", () => {
      console.error(`[${this.id}] video error`, this._video.error);
    });
    console.log(`[${this.id}] using MP4 fallback`);
  }
  // vite ignore is important to prevent build errors due to dynamic name
  _spawnWorker() {
    try {
      this._worker = new Worker(
        new URL("../utils/worker-client.js", import.meta.url),
        /* @vite-ignore */ { type: "module", name: this.id }
      );

      this._worker.onmessage = (evt) => {
        // Worker now sends { data, dims } — fall back to raw array for compatibility
        const msg = evt.data;
        const output = (msg && msg.data) ? msg.data : msg;
        const dims   = (msg && msg.dims) ? msg.dims : null;
        if (dims && !this._dimsLogged) {
          console.log(`[${this.id}] fire model output dims: [${dims}]`);
          this._dimsLogged = true;
        }
        this._boxes = this._processOutput(
          output,
          this._overlay.width,
          this._overlay.height,
          dims
        );
        this.onDetections(this._boxes);
        this._busy = false;
      };

      this._worker.onerror = (e) => {
        console.error(`[${this.id}] Worker error:`, e);
        this._worker = null;
      };

      console.log(`[${this.id}] Worker created successfully`);
    } catch (e) {
      console.error(`[${this.id}] Worker spawn failed`, e);
      this._worker = null;
    }
  }

  _bindVideoLoop() {
    if (!this.enabled) return;
    const tick = (t) => {
      this._rafHandle = requestAnimationFrame(tick);

      // throttle
      if (t - this._lastTick < this.throttleMs) return;
      this._lastTick = t;

      if (!this._video || !this._overlay) return;
      if (this._video.videoWidth === 0 || this._video.videoHeight === 0) return;

      // draw frame & boxes
      this._ctx.drawImage(
        this._video,
        0,
        0,
        this._overlay.width,
        this._overlay.height
      );
      this._drawBoxes(this._boxes);

      if (this._busy) return;

      const buffer = this._prepareInput(this._overlay);
      if (!buffer) return;

      // Transfer the underlying ArrayBuffer to avoid copying
      if (this._worker) {
        this._worker.postMessage(
          {
            type: "infer",
            data: buffer,
            dims: [1, 3, this.modelInputSize, this.modelInputSize],
          },
          [buffer] // Transferable
        );
      }
      this._busy = true;
    };
    const start = () => {
      if (!this._rafHandle) this._rafHandle = requestAnimationFrame(tick);
    };

    // Start on future 'play'...
    this._video.addEventListener("play", start, { once: true });
    // ...and also start now if already playing
    if (
      !this._video.paused &&
      this._video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      start();
    }
  }

  _prepareInput() {
    const S = this.modelInputSize;

    if (!this._scratch) {
      this._scratch = document.createElement("canvas");
      this._scratch.width = S;
      this._scratch.height = S;
      this._scratchCtx = this._scratch.getContext("2d", {
        willReadFrequently: true,
      });
    }

    const vw = this._video.videoWidth;
    const vh = this._video.videoHeight;
    if (!vw || !vh) return null;

    // Letterbox: preserve aspect ratio with gray padding — matches YOLO training preprocessing.
    // Stretching to 640x640 distorts thin objects (knives, faces) and kills detection confidence.
    const scale = Math.min(S / vw, S / vh);
    const newW  = Math.round(vw * scale);
    const newH  = Math.round(vh * scale);
    const padX  = Math.floor((S - newW) / 2);
    const padY  = Math.floor((S - newH) / 2);
    this._lbScale = scale;
    this._lbPadX  = padX;
    this._lbPadY  = padY;

    this._scratchCtx.fillStyle = "rgb(114,114,114)";
    this._scratchCtx.fillRect(0, 0, S, S);
    this._scratchCtx.drawImage(this._video, padX, padY, newW, newH);

    let data;
    try {
      data = this._scratchCtx.getImageData(0, 0, S, S).data;
    } catch (e) {
      if (e.name === "SecurityError") {
        if (!this._corsWarned) {
          console.warn(`[${this.id}] CORS SecurityError in getImageData — canvas tainted. Detection disabled for this stream.`);
          this._corsWarned = true;
        }
        this._scratch.width = S;
        this._scratch.height = S;
        return null;
      }
      throw e;
    }
    const N = S * S;
    const arr = new Float32Array(N * 3);

    let r = 0,
      g = N,
      b = 2 * N;
    for (let i = 0; i < data.length; i += 4) {
      arr[r++] = data[i] / 255;
      arr[g++] = data[i + 1] / 255;
      arr[b++] = data[i + 2] / 255;
    }
    return arr.buffer;
  }

  _processOutput(output, imgW, imgH, dims) {
    if (output && typeof output === "object" && "data" in output) {
      dims = output.dims || dims;
      output = output.data;
    }
    if (!output || output.length === 0) return [];
    let boxes = [];
    let fireCount = 0;
    let smokeCount = 0;
    let totalFireArea = 0;

    const sc  = this._lbScale || 1;
    const lpx = this._lbPadX  || 0;
    const lpy = this._lbPadY  || 0;

    // Determine format from actual dims when available, else fall back to heuristic.
    // ScaledYOLOv4 exports [1, N_anchors, 7] (anchor-first, has objectness).
    // YOLOv8/v11 exports  [1, C, 8400]       (channel-first, no objectness).
    let isAnchorFirst, anchors, channels;
    if (dims && dims.length >= 3) {
      // Use exact shape from tensor dims — no guessing
      const d1 = dims[dims.length - 2];
      const d2 = dims[dims.length - 1];
      isAnchorFirst = d1 > d2;   // [N, 7] → anchor-first;  [C, 8400] → channel-first
      anchors  = isAnchorFirst ? d1 : d2;
      channels = isAnchorFirst ? d2 : d1;
    } else {
      const CELLS_V8 = 8400;
      const ch = output.length / CELLS_V8;
      isAnchorFirst = !(Number.isInteger(ch) && ch <= 16);
      anchors  = isAnchorFirst ? Math.round(output.length / 7) : CELLS_V8;
      channels = isAnchorFirst ? 7 : ch;
    }

    if (!isAnchorFirst) {
      // YOLOv8/v11: no objectness, channel-first [C, anchors]
      const clsCount = Math.round(channels) - 4;
      const labels = clsCount >= 3 ? ["Fire", "Smoke", "Other"] : ["Fire", "Smoke"];
      const fireProbThreshold  = 0.7;
      const smokeProbThreshold = 0.35;

      for (let i = 0; i < anchors; i++) {
        let classId = 0, best = 0;
        for (let c = 0; c < clsCount; c++) {
          const p = output[anchors * (c + 4) + i];
          if (p > best) { best = p; classId = c; }
        }
        const label = labels[classId] || "Other";
        if (label === "Other") continue;
        const minScore = label === "Smoke" ? smokeProbThreshold : fireProbThreshold;
        if (best < minScore) continue;

        const xc = output[i];
        const yc = output[anchors + i];
        const w  = output[2 * anchors + i];
        const h  = output[3 * anchors + i];

        const x1 = Math.max(0, Math.min(imgW, (xc - w / 2 - lpx) / sc));
        const y1 = Math.max(0, Math.min(imgH, (yc - h / 2 - lpy) / sc));
        const x2 = Math.max(0, Math.min(imgW, (xc + w / 2 - lpx) / sc));
        const y2 = Math.max(0, Math.min(imgH, (yc + h / 2 - lpy) / sc));

        const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        if (area < Math.max(1, imgW * imgH) * 0.001) continue;

        boxes.push([x1, y1, x2, y2, label, best]);
        if (label === "Fire")  { fireCount++;  totalFireArea += area; }
        if (label === "Smoke") { smokeCount++; totalFireArea += area; }
      }
    } else {
      // ScaledYOLOv4-P5 anchor-first [anchors, channels] with objectness
      // Per anchor: cx, cy, w, h, objectness, fire_score, smoke_score
      const labels = ["Fire", "Smoke"];
      const fireThreshold  = 0.45;
      const smokeThreshold = 0.35;

      for (let i = 0; i < anchors; i++) {
        const base = i * channels;
        const obj  = output[base + 4];
        if (obj < 0.35) continue;

        let classId = 0, bestClass = 0;
        for (let c = 0; c < labels.length; c++) {
          const p = output[base + 5 + c];
          if (p > bestClass) { bestClass = p; classId = c; }
        }
        const score = obj * bestClass;
        const label = labels[classId];
        const minScore = label === "Smoke" ? smokeThreshold : fireThreshold;
        if (score < minScore) continue;

        const xc = output[base + 0];
        const yc = output[base + 1];
        const w  = output[base + 2];
        const h  = output[base + 3];

        const x1 = Math.max(0, Math.min(imgW, (xc - w / 2 - lpx) / sc));
        const y1 = Math.max(0, Math.min(imgH, (yc - h / 2 - lpy) / sc));
        const x2 = Math.max(0, Math.min(imgW, (xc + w / 2 - lpx) / sc));
        const y2 = Math.max(0, Math.min(imgH, (yc + h / 2 - lpy) / sc));

        const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        if (area < Math.max(1, imgW * imgH) * 0.001) continue;
        // Reject boxes that cover more than 90% of the frame — usually false positives
        if (area > imgW * imgH * 0.90) continue;

        boxes.push([x1, y1, x2, y2, label, score]);
        if (label === "Fire")  { fireCount++;  totalFireArea += area; }
        if (label === "Smoke") { smokeCount++; totalFireArea += area; }
      }
    }

    // history updates
    const detected = fireCount > 0 || smokeCount > 0;
    this._detectionHistory.push(detected);
    if (this._detectionHistory.length > this._MAX_FRAMES)
      this._detectionHistory.shift();

    if (this._fireAreasHistory.length > 0) {
      const prev = this._fireAreasHistory[this._fireAreasHistory.length - 1];
      this._fireIncreaseHistory.push(totalFireArea > prev);
    } else {
      this._fireIncreaseHistory.push(false);
    }
    this._fireAreasHistory.push(totalFireArea);
    if (this._fireAreasHistory.length > this._MAX_FRAMES_HISTORY) {
      this._fireAreasHistory.shift();
      this._fireIncreaseHistory.shift();
    }

    const incCount = this._fireIncreaseHistory.filter(Boolean).length;
    const incRate = incCount / this._fireIncreaseHistory.length;
    const detRate =
      this._detectionHistory.filter(Boolean).length /
      this._detectionHistory.length;

    if (detRate >= this._THRESHOLD && incRate >= this._AREA_INCREASE_PERCENT) {
      console.log(`[${this.id}] Serious fire trend detected`);
    }
    // console.log("--------------------------------")
    // console.log("current detection id", this.id)
    // console.log("detectionHistory", this._detectionHistory)
    // console.log("fireAreasHistory", this._fireAreasHistory)
    // console.log("fireIncreaseHistory", this._fireIncreaseHistory)
    // console.log("detRate", detRate)
    // console.log("incRate", incRate)
    // console.log("boxes", boxes)
    // console.log("area increase percent", this._AREA_INCREASE_PERCENT)
    // console.log("threshold", this._THRESHOLD)
    // console.log("--------------------------------")

    // NMS (simple IoU)
    boxes.sort((a, b) => b[5] - a[5]);
    const keep = [];
    const iou = (A, B) => {
      const inter = (() => {
        const x1 = Math.max(A[0], B[0]);
        const y1 = Math.max(A[1], B[1]);
        const x2 = Math.min(A[2], B[2]);
        const y2 = Math.min(A[3], B[3]);
        return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      })();
      const areaA = Math.max(0, A[2] - A[0]) * Math.max(0, A[3] - A[1]);
      const areaB = Math.max(0, B[2] - B[0]) * Math.max(0, B[3] - B[1]);
      const uni = areaA + areaB - inter;
      return uni <= 0 ? 0 : inter / uni;
    };
    while (boxes.length) {
      const head = boxes.shift();
      keep.push(head);
      boxes = boxes.filter((b) => iou(head, b) < 0.7);
    }
    return keep;
  }

  _processOutputWeapon(output, imgW, imgH) {
    if (output && typeof output === "object" && "newOut" in output) {
      output = output.newOut;
    }
    if (!output || output.length === 0) return [];
    // YOLO column-major format: [1, (4+C), 8400] in 640px space.
    // We detect the number of classes from output length so this works whether
    // the model has 1 class or the 4-class threat label set. In the threat
    // model, only class 3 is knife.
    let boxes = [];
    const cells = 8400;
    const numClasses = Math.max(1, Math.round(output.length / cells) - 4);
    const threatLabels = ["Gun", "explosion", "grenade", "knife"];
    const probThreshold = 0.40;
    const sc  = this._lbScale || 1;
    const lpx = this._lbPadX  || 0;
    const lpy = this._lbPadY  || 0;

    for (let i = 0; i < cells; i++) {
      let best = 0;
      let classId = 0;
      for (let c = 0; c < numClasses; c++) {
        const p = output[cells * (c + 4) + i];
        if (p > best) {
          best = p;
          classId = c;
        }
      }
      const label = numClasses === 1 ? "knife" : threatLabels[classId];
      if (label !== "knife") continue;
      if (best < probThreshold) continue;

      const xc = output[i];
      const yc = output[cells + i];
      const w  = output[2 * cells + i];
      const h  = output[3 * cells + i];

      const x1 = Math.max(0, Math.min(imgW, (xc - w / 2 - lpx) / sc));
      const y1 = Math.max(0, Math.min(imgH, (yc - h / 2 - lpy) / sc));
      const x2 = Math.max(0, Math.min(imgW, (xc + w / 2 - lpx) / sc));
      const y2 = Math.max(0, Math.min(imgH, (yc + h / 2 - lpy) / sc));

      boxes.push([x1, y1, x2, y2, "knife", best]);
    }

    // NMS
    boxes.sort((a, b) => b[5] - a[5]);
    const keep = [];
    const iou = (A, B) => {
      const ix1 = Math.max(A[0], B[0]), iy1 = Math.max(A[1], B[1]);
      const ix2 = Math.min(A[2], B[2]), iy2 = Math.min(A[3], B[3]);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const areaA = (A[2] - A[0]) * (A[3] - A[1]);
      const areaB = (B[2] - B[0]) * (B[3] - B[1]);
      return inter / (areaA + areaB - inter || 1);
    };
    while (boxes.length) {
      const head = boxes.shift();
      keep.push(head);
      boxes = boxes.filter((b) => iou(head, b) < 0.7);
    }
    return keep;
  }

  // Legacy weapons_yolo.onnx — all detections labeled "Knife" (uppercase for colorMap)
  _processOutputWeaponLegacy(output, imgW, imgH) {
    if (!output || output.length === 0) return [];
    let boxes = [];
    const cells = 8400;
    const numClasses = Math.max(1, Math.round(output.length / cells) - 4);
    const probThreshold = 0.40;
    const sc  = this._lbScale || 1;
    const lpx = this._lbPadX  || 0;
    const lpy = this._lbPadY  || 0;

    for (let i = 0; i < cells; i++) {
      let best = 0;
      for (let c = 0; c < numClasses; c++) {
        const p = output[cells * (c + 4) + i];
        if (p > best) best = p;
      }
      if (best < probThreshold) continue;

      const xc = output[i];
      const yc = output[cells + i];
      const w  = output[2 * cells + i];
      const h  = output[3 * cells + i];
      boxes.push([
        Math.max(0, Math.min(imgW, (xc - w / 2 - lpx) / sc)),
        Math.max(0, Math.min(imgH, (yc - h / 2 - lpy) / sc)),
        Math.max(0, Math.min(imgW, (xc + w / 2 - lpx) / sc)),
        Math.max(0, Math.min(imgH, (yc + h / 2 - lpy) / sc)),
        "Knife", best,
      ]);
    }

    boxes.sort((a, b) => b[5] - a[5]);
    const keep = [];
    const iou = (A, B) => {
      const ix1 = Math.max(A[0], B[0]), iy1 = Math.max(A[1], B[1]);
      const ix2 = Math.min(A[2], B[2]), iy2 = Math.min(A[3], B[3]);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      return inter / ((A[2]-A[0])*(A[3]-A[1]) + (B[2]-B[0])*(B[3]-B[1]) - inter || 1);
    };
    while (boxes.length) {
      const head = boxes.shift();
      keep.push(head);
      boxes = boxes.filter((b) => iou(head, b) < 0.7);
    }
    return keep;
  }

  _processOutputMask(output, imgW, imgH) {
    if (!output || output.length === 0) return [];
    // YOLOv5 row-major format: [1, 25200, 8] = x,y,w,h,obj,3 class scores.
    let boxes = [];
    const channels = 8;
    const cells = Math.floor(output.length / channels);
    const labels = ["with_mask", "without_mask", "mask_weared_incorrect"];
    const probThreshold = 0.75;

    for (let i = 0; i < cells; i++) {
      const base = i * channels;
      const objectness = output[base + 4];
      if (objectness < 0.20) continue;

      let classId = 0, bestClass = 0;
      for (let c = 0; c < labels.length; c++) {
        const p = output[base + 5 + c];
        if (p > bestClass) { bestClass = p; classId = c; }
      }

      const label = labels[classId];
      if (label === "without_mask") continue;

      const score = objectness * bestClass;
      if (score < probThreshold) continue;

      const xc = output[base];
      const yc = output[base + 1];
      const w  = output[base + 2];
      const h  = output[base + 3];

      const sc  = this._lbScale || 1;
      const lpx = this._lbPadX  || 0;
      const lpy = this._lbPadY  || 0;
      const x1  = Math.max(0, Math.min(imgW, (xc - w / 2 - lpx) / sc));
      const y1  = Math.max(0, Math.min(imgH, (yc - h / 2 - lpy) / sc));
      const x2  = Math.max(0, Math.min(imgW, (xc + w / 2 - lpx) / sc));
      const y2  = Math.max(0, Math.min(imgH, (yc + h / 2 - lpy) / sc));

      boxes.push([x1, y1, x2, y2, label, score]);
    }

    boxes.sort((a, b) => b[5] - a[5]);
    const keep = [];
    const iou = (A, B) => {
      const ix1 = Math.max(A[0], B[0]), iy1 = Math.max(A[1], B[1]);
      const ix2 = Math.min(A[2], B[2]), iy2 = Math.min(A[3], B[3]);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const areaA = (A[2] - A[0]) * (A[3] - A[1]);
      const areaB = (B[2] - B[0]) * (B[3] - B[1]);
      return inter / (areaA + areaB - inter || 1);
    };
    while (boxes.length) {
      const head = boxes.shift();
      keep.push(head);
      boxes = boxes.filter((b) => iou(head, b) < 0.45);
    }
    return keep;
  }

  _drawBoxes(boxes) {
    const ctx = this._ctx;
    ctx.save();

    // Scale font size based on canvas dimensions for better visibility
    // Use more aggressive scaling: divide by 30 instead of 60 to double the font size
    const fontSize = Math.max(24, Math.floor(this._overlay.width / 30));
    const lineWidth = Math.max(4, Math.floor(this._overlay.width / 320));
    const labelPadding = Math.floor(fontSize * 0.3);
    const labelHeight = Math.floor(fontSize * 1.3);

    ctx.lineWidth = lineWidth;
    ctx.font = `bold ${fontSize}px system-ui`;

    const colorMap = {
      Fire: "#00FF00",
      Smoke: "#00FF00",
      Knife: "#FF0000",
      knife: "#FF0000",
      with_mask: "#bd93f9",
      mask_weared_incorrect: "#bd93f9",
    };

    boxes.forEach(([x1, y1, x2, y2, label]) => {
      const color = colorMap[label] || "#00FF00";
      const displayLabel = label === "with_mask"
        ? "Mask"
        : label === "mask_weared_incorrect"
          ? "Mask worn incorrectly"
          : label;
      ctx.strokeStyle = color;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = color;
      const w = ctx.measureText(displayLabel).width;
      ctx.fillRect(
        x1,
        Math.max(0, y1 - labelHeight),
        w + labelPadding * 2,
        labelHeight
      );
      ctx.fillStyle = "#000";
      ctx.fillText(
        displayLabel,
        x1 + labelPadding,
        Math.max(fontSize, y1 - labelPadding)
      );
    });
    ctx.restore();
  }
}
