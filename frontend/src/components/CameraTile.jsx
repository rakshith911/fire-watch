// import React, { useEffect, useRef, useState } from "react";
// import Hls from "hls.js";
// import { FaSpinner, FaExclamationCircle } from "react-icons/fa";
// import { startCloudDetect, stopCloudDetect } from "../utils/cloudDetect.js";
// import { playWebRTC } from "../utils/playWebRTC.js";
// import { useCameras } from "../store/cameras.jsx";
// import StreamingIcon from "./StreamingIcon.jsx";
// import FireStatusButton from "./FireStatusButton.jsx";
// import ThreatTimeline from "./ThreatTimeline.jsx";

// // We'll lazy-load your ESM VideoDetector class from utils directory
// let VideoDetectorClassPromise;
// function loadVideoDetector() {
//   if (!VideoDetectorClassPromise) {
//     VideoDetectorClassPromise = import("../utils/videoDetector.js").then(
//       (m) => m.VideoDetector || m.default
//     );
//   }
//   return VideoDetectorClassPromise;
// }

// export default function CameraTile({ cam }) {
//   const videoRef = useRef(null);
//   const [status, setStatus] = useState("Idle");
//   const [isFire, setIsFire] = useState(false); // can set this to true if you want to show the fire status button
//   const [isStreaming, setIsStreaming] = useState(false);
//   const [viewed, setViewed] = useState(true); // you can wire this to visibility/selection
//   const [showSpinner, setShowSpinner] = useState(false);
//   const { updateCameraStatus } = useCameras();

//   // keep detector instance for local mode
//   const detectorRef = useRef(null);
//   // cloud interval/abort
//   const abortRef = useRef(null);
//   // PeerConnection for WebRTC (if used)
//   const pcRef = useRef(null);
//   // ResizeObserver for canvas sync
//   const resizeObserverRef = useRef(null);
//   // Timeout for spinner delay
//   const spinnerTimeoutRef = useRef(null);

//   // Update camera status in store whenever local state changes
//   useEffect(() => {
//     updateCameraStatus(cam.id, { isFire, isStreaming });
//   }, [isFire, isStreaming, cam.id, updateCameraStatus]);

//   useEffect(() => {
//     const v = videoRef.current;
//     let hls;
//     let cancelled = false;
//     let connectionAttempted = false;

//     async function attachStream() {
//       if (cancelled || connectionAttempted) return;
//       connectionAttempted = true;

//       const updateStatus = (msg) => {
//         console.log(`[${cam.name}] ${msg}`);

//         // Clear any existing spinner timeout
//         if (spinnerTimeoutRef.current) {
//           clearTimeout(spinnerTimeoutRef.current);
//           spinnerTimeoutRef.current = null;
//         }

//         if (msg === "Connecting…") {
//           setShowSpinner(true);
//           setStatus(msg);
//         } else if (
//           msg.startsWith("Failed") ||
//           msg.includes("error") ||
//           msg.includes("Error")
//         ) {
//           // Always wait 2 seconds before showing error, regardless of current spinner state
//           spinnerTimeoutRef.current = setTimeout(() => {
//             setShowSpinner(false);
//             setStatus(msg);
//           }, 2000);
//         } else {
//           // For other statuses (like "Streaming…"), hide spinner immediately
//           setShowSpinner(false);
//           setStatus(msg);
//         }
//       };

//       updateStatus("Connecting…");
//       try {
//         if (cam.streamType === "WEBRTC") {
//           console.log(`[${cam.name}] 🔗 Connecting to WebRTC:`, {
//             webrtcBase: cam.webrtcBase,
//             streamName: cam.streamName,
//             fullUrl: `${cam.webrtcBase}/${cam.streamName}/whep`
//           });
//           const { pc, stream } = await playWebRTC(
//             cam.webrtcBase,
//             cam.streamName
//           );
//           if (cancelled) {
//             console.log(
//               `[${cam.name}] Connection cancelled, closing PeerConnection`
//             );
//             pc.close();
//             return;
//           }
//           pcRef.current = pc;

//           // Monitor video element for errors
//           v.onerror = (e) => {
//             console.error(`[${cam.name}] Video element error:`, e);
//             if (!cancelled) updateStatus("Video Error");
//           };

//           // Set srcObject
//           v.srcObject = stream;
//           console.log(
//             `[${cam.name}] Stream assigned, tracks:`,
//             stream
//               .getTracks()
//               .map(
//                 (t) =>
//                   `${t.kind}:${t.readyState}:${t.muted ? "muted" : "unmuted"}`
//               )
//           );

//           // Monitor track state changes
//           stream.getTracks().forEach((track) => {
//             track.addEventListener("mute", () =>
//               console.log(`[${cam.name}] Track ${track.kind} muted!`)
//             );
//             track.addEventListener("unmute", () =>
//               console.log(`[${cam.name}] Track ${track.kind} unmuted`)
//             );
//             track.addEventListener("ended", () =>
//               console.log(`[${cam.name}] Track ${track.kind} ended!`)
//             );
//           });

//           // Wait for video to be ready with a proper event listener approach
//           const waitForVideo = new Promise((resolve) => {
//             let resolved = false;

//             const checkAndResolve = (event) => {
//               if (resolved) return;
//               console.log(
//                 `[${cam.name}] Video event: ${event.type}, readyState: ${v.readyState}`
//               );

//               if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
//                 resolved = true;
//                 cleanup();
//                 resolve(true);
//               }
//             };

//             const cleanup = () => {
//               v.removeEventListener("loadstart", checkAndResolve);
//               v.removeEventListener("loadedmetadata", checkAndResolve);
//               v.removeEventListener("loadeddata", checkAndResolve);
//               v.removeEventListener("canplay", checkAndResolve);
//               v.removeEventListener("canplaythrough", checkAndResolve);
//             };

//             // Listen to all relevant events
//             v.addEventListener("loadstart", checkAndResolve);
//             v.addEventListener("loadedmetadata", checkAndResolve);
//             v.addEventListener("loadeddata", checkAndResolve);
//             v.addEventListener("canplay", checkAndResolve);
//             v.addEventListener("canplaythrough", checkAndResolve);

//             // Timeout after 5 seconds
//             setTimeout(() => {
//               if (!resolved) {
//                 console.warn(
//                   `[${cam.name}] Video ready timeout, readyState: ${v.readyState}`
//                 );
//                 resolved = true;
//                 cleanup();
//                 resolve(false);
//               }
//             }, 5000);

//             // Check immediately in case already ready
//             if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
//               resolved = true;
//               cleanup();
//               resolve(true);
//             }
//           });

//           const videoReady = await waitForVideo;

//           // Try to play
//           try {
//             await v.play();
//             console.log(
//               `[${cam.name}] Video playing, readyState: ${v.readyState}`
//             );
//             if (!cancelled) {
//               setIsStreaming(true);
//               updateStatus("Streaming…");
//             }
//           } catch (e) {
//             console.error(
//               `[${cam.name}] Play failed:`,
//               e.message,
//               "readyState:",
//               v.readyState
//             );
//             if (!cancelled) {
//               updateStatus(`Play error: ${e.message}`);
//             }
//           }
//         } else if (cam.streamType === "HLS") {
//           console.log(`[${cam.name}] 🔗 Connecting to HLS:`, {
//             hlsUrl: cam.hlsUrl
//           });
//           if (Hls.isSupported()) {
//             hls = new Hls({ liveDurationInfinity: true });
//             hls.loadSource(cam.hlsUrl);
//             hls.attachMedia(v);
//             hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
//           } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
//             v.src = cam.hlsUrl;
//             await v.play().catch(() => {});
//           } else {
//             v.src = cam.hlsUrl || "";
//             await v.play().catch(() => {});
//           }
//         } else if (cam.streamType === "MP4") {
//           console.log(`[${cam.name}] 🔗 Connecting to MP4:`, {
//             url: cam.hlsUrl
//           });
//           v.src = cam.hlsUrl;
//           await v.play().catch(() => {});
//         }
//         if (!cancelled) {
//           setIsStreaming(true);
//           updateStatus("Streaming…");
//         }
//       } catch (err) {
//         if (!cancelled) {
//           updateStatus(`Failed: ${err?.message || err}`);
//         }
//       }
//     }

//     // detection wiring
//     async function startDetection() {
//       if (cancelled) return;
//       if (cam.detection === "LOCAL") {
//         console.log(`[${cam.name}] Starting local detection...`);
//         const VideoDetector = await loadVideoDetector();
//         if (cancelled) return;

//         // Don't let VideoDetector create its own video - use existing one
//         const d = new VideoDetector({
//           id: cam.name,
//           mount: null, // Don't mount - we'll attach to existing video
//           workerUrl: "../utils/worker-client.js",
//           throttleMs: 80,
//           onDetections: (boxes) => {
//             if (cancelled) return;
//             const any = boxes && boxes.length > 0;
//             setIsFire(any);
//           },
//         });

//         // Manually set the internal video reference to our existing element
//         d._video = v;
//         d._root = v.parentElement;

//         // Create overlay canvas for bounding boxes
//         if (!d._overlay) {
//           const canvas = document.createElement("canvas");
//           canvas.style.position = "absolute";
//           canvas.style.top = "0";
//           canvas.style.left = "0";
//           canvas.style.pointerEvents = "none";
//           v.parentElement.appendChild(canvas);
//           d._overlay = canvas;
//           d._ctx = canvas.getContext("2d");

//           // Sync canvas size with video element's rendered size
//           const syncCanvasSize = () => {
//             if (v.videoWidth && v.videoHeight) {
//               // Set canvas internal resolution to video's natural size
//               canvas.width = v.videoWidth;
//               canvas.height = v.videoHeight;

//               // Set canvas display size to match video element's rendered size
//               const rect = v.getBoundingClientRect();
//               canvas.style.width = `${rect.width}px`;
//               canvas.style.height = `${rect.height}px`;

//               // Position canvas to overlay video exactly
//               const videoRect = v.getBoundingClientRect();
//               const parentRect = v.parentElement.getBoundingClientRect();
//               canvas.style.left = `${videoRect.left - parentRect.left}px`;
//               canvas.style.top = `${videoRect.top - parentRect.top}px`;

//               console.log(
//                 `[${cam.name}] Canvas synced: ${canvas.width}x${canvas.height} display: ${rect.width}x${rect.height}`
//               );
//             }
//           };
//           v.addEventListener("loadedmetadata", syncCanvasSize);
//           v.addEventListener("resize", syncCanvasSize);
//           v.addEventListener("play", syncCanvasSize);

//           // Use ResizeObserver to sync canvas when video element resizes (e.g., view changes)
//           resizeObserverRef.current = new ResizeObserver(() => {
//             syncCanvasSize();
//           });
//           resizeObserverRef.current.observe(v);
//         }

//         detectorRef.current = d;

//         // Start the detector (spawn worker and bind video loop)
//         // DON'T call attachWebRTC or start() since we're manually managing video/canvas
//         if (!d._worker) {
//           // Spawn worker
//           const url = new URL("../utils/worker-client.js", import.meta.url);
//           d._worker = new Worker(url, { type: "module", name: cam.name });

//           d._worker.onmessage = (evt) => {
//             const output = evt.data;
//             d._boxes = d._processOutput(
//               output,
//               d._overlay.width,
//               d._overlay.height
//             );
//             d.onDetections(d._boxes);
//             d._busy = false;
//           };

//           d._worker.onerror = (e) => {
//             console.error(`[${cam.name}] Worker error:`, e);
//             d._worker = null;
//           };

//           console.log(`[${cam.name}] Worker created`);
//         }

//         // Bind video loop
//         if (!d._rafHandle) {
//           const tick = (t) => {
//             d._rafHandle = requestAnimationFrame(tick);
//             if (t - d._lastTick < d.throttleMs) return;
//             d._lastTick = t;

//             if (!d._video || !d._overlay) return;
//             if (d._video.videoWidth === 0 || d._video.videoHeight === 0) return;

//             // Clear canvas and draw only boxes (NOT the video)
//             d._ctx.clearRect(0, 0, d._overlay.width, d._overlay.height);
//             d._drawBoxes(d._boxes);

//             if (d._busy) return;

//             // Prepare input from video element (not canvas)
//             const buffer = d._prepareInput(d._video);
//             if (!buffer) return;

//             if (d._worker) {
//               d._worker.postMessage(
//                 {
//                   type: "infer",
//                   data: buffer,
//                   dims: [1, 3, d.modelInputSize, d.modelInputSize],
//                 },
//                 [buffer]
//               );
//             }
//             d._busy = true;
//           };

//           // Start loop when video plays
//           const startLoop = () => {
//             if (!d._rafHandle) {
//               d._rafHandle = requestAnimationFrame(tick);
//               console.log(`[${cam.name}] Detection loop started`);
//             }
//           };

//           v.addEventListener("play", startLoop, { once: true });

//           // Also start now if already playing
//           if (!v.paused && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
//             startLoop();
//           }
//         }
//       } else if (cam.detection === "CLOUD") {
//         abortRef.current = startCloudDetect({
//           video: v,
//           endpoint: cam.awsEndpoint,
//           intervalMs: cam.cloudFps ? 1000 / cam.cloudFps : 500, // ~2 fps default
//           onResult: (r) => {
//             if (cancelled) return;
//             const any = !!(r?.isFire || r?.detections?.length > 0);
//             setIsFire(any);
//             // Don't update status for fire detection - keep it separate
//           },
//           onError: (e) => {
//             if (!cancelled) updateStatus(`Cloud error: ${e?.message || e}`);
//           },
//         });
//       }
//     }

//     attachStream().then(startDetection);

//     return () => {
//       console.log(`[${cam.name}] Cleaning up...`);
//       cancelled = true;

//       // Clear spinner timeout
//       if (spinnerTimeoutRef.current) {
//         clearTimeout(spinnerTimeoutRef.current);
//         spinnerTimeoutRef.current = null;
//       }

//       if (hls) {
//         try {
//           hls.destroy();
//         } catch (e) {
//           console.warn(`[${cam.name}] HLS cleanup error:`, e);
//         }
//       }

//       if (pcRef.current) {
//         try {
//           console.log(`[${cam.name}] Closing PeerConnection`);
//           pcRef.current.close();
//           pcRef.current = null;
//         } catch (e) {
//           console.warn(`[${cam.name}] PC cleanup error:`, e);
//         }
//       }

//       if (detectorRef.current) {
//         try {
//           // Remove overlay canvas if it exists
//           if (
//             detectorRef.current._overlay &&
//             detectorRef.current._overlay.parentElement
//           ) {
//             detectorRef.current._overlay.parentElement.removeChild(
//               detectorRef.current._overlay
//             );
//           }
//           detectorRef.current.stop();
//           detectorRef.current = null;
//         } catch (e) {
//           console.warn(`[${cam.name}] Detector cleanup error:`, e);
//         }
//       }

//       if (abortRef.current) {
//         stopCloudDetect(abortRef.current);
//         abortRef.current = null;
//       }

//       // Clean up ResizeObserver
//       if (resizeObserverRef.current) {
//         resizeObserverRef.current.disconnect();
//         resizeObserverRef.current = null;
//       }

//       // Clean up video element
//       if (v) {
//         v.srcObject = null;
//         v.onerror = null;
//       }
//     };
//   }, [
//     cam.id,
//     cam.streamType,
//     cam.webrtcBase,
//     cam.streamName,
//     cam.detection,
//   ]);

//   return (
//     <div className="tile">
//       <div className="tile-header">
//         <div className="tile-title">
//           <StreamingIcon isStreaming={isStreaming} size={22} />
//           <span className="name">{cam.name}</span>
//           <span className="location">{cam.location}</span>
//         </div>
//         <div className="tile-status-icons">
//           <FireStatusButton isFire={isFire} />
//         </div>
//       </div>
//       <div className="video-wrap" onMouseEnter={() => setViewed(true)}>
//         <video ref={videoRef} autoPlay muted playsInline controls />
//         {(showSpinner || (status !== "Streaming…" && status !== "Idle")) && (
//           <div className="status-overlay">
//             {showSpinner ? (
//               <FaSpinner className="status-icon spinning" size={32} />
//             ) : status.startsWith("Failed") ||
//               status.includes("error") ||
//               status.includes("Error") ? (
//               <FaExclamationCircle className="status-icon error" size={32} />
//             ) : null}
//           </div>
//         )}
//       </div>
//     </div>
//   );
// }

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import Hls from "hls.js";
import { FaSpinner, FaExclamationCircle } from "react-icons/fa";
import { startCloudDetect, stopCloudDetect } from "../utils/cloudDetect.js";
import { playWebRTC } from "../utils/playWebRTC.js";
import { useCameras } from "../store/cameras.jsx";
import StreamingIcon from "./StreamingIcon.jsx";
import { getMediaMTXUrl } from "../config/electron.js";
import { sendDetectionEvent } from "../utils/webSocketClient.js";
import fireWorkerUrl from "../utils/worker-client.js?worker&url";
import weaponWorkerUrl from "../utils/worker-weapon.js?worker&url";
import maskWorkerUrl from "../utils/worker-mask.js?worker&url";

// We'll lazy-load your ESM VideoDetector class from utils directory
let VideoDetectorClassPromise;
function loadVideoDetector() {
  if (!VideoDetectorClassPromise) {
    VideoDetectorClassPromise = import("../utils/videoDetector.js").then(
      (m) => m.VideoDetector || m.default
    );
  }
  return VideoDetectorClassPromise;
}

export default function CameraTile({ cam }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("Idle");
  const [isFire, setIsFire] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [viewed, setViewed] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const [staticNotice, setStaticNotice] = useState(false);
  const [alertType, setAlertType] = useState(null); // "Fire", "Knife", etc.
  const [liveMaskPresent, setLiveMaskPresent] = useState(false);
  const { updateCameraStatus, showBoundingBoxes, updateCamera } = useCameras();

  // Run both fire + weapon YOLO in-browser for real-time bounding boxes.
  // Backend still does CLIP/V-JEPA verification for labels and alerts.
  const isStartLocalDetection = true;

  // keep detector instance for local mode
  const detectorRef = useRef(null);
  // cloud interval/abort
  const abortRef = useRef(null);
  // PeerConnection for WebRTC (if used)
  const pcRef = useRef(null);
  // ResizeObserver for canvas sync
  const resizeObserverRef = useRef(null);
  // Timeout for spinner delay
  const spinnerTimeoutRef = useRef(null);
  // Debounce: last time a detection event was sent to backend
  const lastDetectionSentRef = useRef(0);

  // Ref to track bounding box visibility for the animation loop
  const showBoxesRef = useRef(showBoundingBoxes);
  const backendBoxesRef = useRef(Array.isArray(cam.boxes) ? cam.boxes : []);
  const backendCanvasRef = useRef(null);
  const forceClearOverlayRef = useRef(false); // set true to wipe YOLO overlay on next rAF tick
  // Tracks backend static-rejection state without recreating the onDetections closure
  const staticRejectedRef = useRef(cam.staticRejected || false);
  // Miss-streak debounce: require N consecutive frames with no detection before clearing.
  // Prevents brief YOLO misses (compression artifact, motion blur) from flickering the label.
  const missStreakRef = useRef(0);
  const MISS_STREAK_CLEAR = 5; // ~250ms at 50ms throttle
  const lastFireBoxRef = useRef(null);
  const movingFireFramesRef = useRef(0);

  const boxIouRef = useCallback((a, b) => {
    if (!a || !b) return 0;
    const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    return inter / (areaA + areaB - inter || 1);
  }, []);

  const centerShiftRef = useCallback((a, b) => {
    if (!a || !b) return 0;
    const cx1 = (a[0] + a[2]) / 2, cy1 = (a[1] + a[3]) / 2;
    const cx2 = (b[0] + b[2]) / 2, cy2 = (b[1] + b[3]) / 2;
    const w = ((a[2] - a[0]) + (b[2] - b[0])) / 2;
    const h = ((a[3] - a[1]) + (b[3] - b[1])) / 2;
    const diag = Math.sqrt(w * w + h * h) || 1;
    return Math.sqrt((cx2 - cx1) ** 2 + (cy2 - cy1) ** 2) / diag;
  }, []);

  useEffect(() => {
    showBoxesRef.current = showBoundingBoxes;
  }, [showBoundingBoxes]);

  useEffect(() => {
    backendBoxesRef.current = Array.isArray(cam.boxes) ? cam.boxes : [];
  }, [cam.boxes]);

  useEffect(() => {
    staticRejectedRef.current = cam.staticRejected || false;
    setStaticNotice(cam.staticRejected || false);
  }, [cam.staticRejected]);

  const getOverlayBoxes = (localBoxes = []) => {
    if (localBoxes && localBoxes.length > 0) return localBoxes;
    return cam.isFire ? backendBoxesRef.current : [];
  };

  // Sync the backend canvas to the actual rendered video content area (letterbox-aware)
  const syncBackendCanvas = useCallback(() => {
    const canvas = backendCanvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v || !v.videoWidth || !v.videoHeight) return;

    canvas.width  = v.videoWidth;
    canvas.height = v.videoHeight;

    const elemRect   = v.getBoundingClientRect();
    const parentRect = v.parentElement?.getBoundingClientRect();
    if (!parentRect) return;

    const videoRatio = v.videoWidth / v.videoHeight;
    const elemRatio  = elemRect.width / elemRect.height;
    let contentW, contentH, offsetX, offsetY;
    if (videoRatio > elemRatio) {
      contentW = elemRect.width;
      contentH = elemRect.width / videoRatio;
      offsetX  = 0;
      offsetY  = (elemRect.height - contentH) / 2;
    } else {
      contentH = elemRect.height;
      contentW = elemRect.height * videoRatio;
      offsetX  = (elemRect.width - contentW) / 2;
      offsetY  = 0;
    }

    canvas.style.width  = `${contentW}px`;
    canvas.style.height = `${contentH}px`;
    canvas.style.left   = `${elemRect.left - parentRect.left + offsetX}px`;
    canvas.style.top    = `${elemRect.top  - parentRect.top  + offsetY}px`;
  }, []);

  // Attach resize/play listeners so canvas stays aligned when video layout changes
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.addEventListener("loadedmetadata", syncBackendCanvas);
    v.addEventListener("resize",         syncBackendCanvas);
    v.addEventListener("play",           syncBackendCanvas);
    const ro = new ResizeObserver(syncBackendCanvas);
    ro.observe(v);
    return () => {
      v.removeEventListener("loadedmetadata", syncBackendCanvas);
      v.removeEventListener("resize",         syncBackendCanvas);
      v.removeEventListener("play",           syncBackendCanvas);
      ro.disconnect();
    };
  }, [syncBackendCanvas]);

  // Backend boxes are never drawn — frontend YOLO is the sole source of bounding boxes.
  // Backend communicates labels and static-rejection state via WebSocket; cam.boxes is
  // kept in state for potential future use but never rendered.
  useEffect(() => {
    const canvas = backendCanvasRef.current;
    if (!canvas) return;
    syncBackendCanvas();
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }, [cam.boxes, showBoundingBoxes, syncBackendCanvas]);

  // When backend clears fire, wipe both canvases immediately — don't wait for next cycle
  useEffect(() => {
    if (!cam.isFire) {
      forceClearOverlayRef.current = true;
      backendBoxesRef.current = [];
      setAlertType(null);
      const bc = backendCanvasRef.current;
      if (bc) bc.getContext("2d").clearRect(0, 0, bc.width, bc.height);
    }
  }, [cam.isFire]);

  const logWorkerError = (label, event) => {
    const detail = {
      message: event?.message || null,
      filename: event?.filename || null,
      lineno: event?.lineno || null,
      colno: event?.colno || null,
      error: event?.error?.message || event?.error || null,
    };
    console.error(`[${cam.name}] ${label} worker error: ${JSON.stringify(detail)}`);
  };

  // Update camera status in store whenever local state changes
  useEffect(() => {
    const updates = { isStreaming };
    if (isStartLocalDetection) {
      updates.isFire    = isFire;
      updates.alertType = alertType;
      // When local YOLO clears, also wipe the backend's persistentLabel so it doesn't
      // outlast detection. Backend will re-set it within its next cycle if threat is real.
      if (!isFire) updates.persistentLabel = null;
    }
    updateCameraStatus(cam.id, updates);
  }, [isFire, isStreaming, alertType, cam.id, updateCameraStatus]);

  useEffect(() => {
    const v = videoRef.current;
    let hls;
    let cancelled = false;
    let connectionAttempted = false;
    let streamReady = false;
    let retryTimeout = null;

    async function attachStream() {
      if (cancelled || connectionAttempted) return;
      connectionAttempted = true;

      const updateStatus = (msg) => {
        console.log(`[${cam.name}] ${msg}`);

        // Clear any existing spinner timeout
        if (spinnerTimeoutRef.current) {
          clearTimeout(spinnerTimeoutRef.current);
          spinnerTimeoutRef.current = null;
        }

        if (msg === "Connecting…") {
          setShowSpinner(true);
          setStatus(msg);
        } else if (
          msg.startsWith("Failed") ||
          msg.includes("error") ||
          msg.includes("Error")
        ) {
          // Always wait 2 seconds before showing error, regardless of current spinner state
          spinnerTimeoutRef.current = setTimeout(() => {
            setShowSpinner(false);
            setStatus(msg);
          }, 2000);
        } else {
          // For other statuses (like "Streaming…"), hide spinner immediately
          setShowSpinner(false);
          setStatus(msg);
        }
      };

      updateStatus("Connecting…");
      try {
        if (cam.streamType === "WEBRTC") {
          // Use localhost for Electron, LAN IP for browser
          const webrtcBase = getMediaMTXUrl(cam.webrtcBase);
          console.log(`[${cam.name}] 🔗 Connecting to WebRTC:`, {
            originalBase: cam.webrtcBase,
            webrtcBase: webrtcBase,
            streamName: cam.streamName,
            fullUrl: `${webrtcBase}/${cam.streamName}/whep`,
          });
          const { pc, stream } = await playWebRTC(webrtcBase, cam.streamName);
          if (cancelled) {
            console.log(
              `[${cam.name}] Connection cancelled, closing PeerConnection`
            );
            pc.close();
            return;
          }
          pcRef.current = pc;

          // Monitor video element for errors
          v.onerror = (e) => {
            console.error(`[${cam.name}] Video element error:`, e);
            if (!cancelled) updateStatus("Video Error");
          };

          // Set srcObject
          v.srcObject = stream;
          console.log(
            `[${cam.name}] Stream assigned, tracks:`,
            stream
              .getTracks()
              .map(
                (t) =>
                  `${t.kind}:${t.readyState}:${t.muted ? "muted" : "unmuted"}`
              )
          );

          // Monitor track state changes
          stream.getTracks().forEach((track) => {
            track.addEventListener("mute", () =>
              console.log(`[${cam.name}] Track ${track.kind} muted!`)
            );
            track.addEventListener("unmute", () =>
              console.log(`[${cam.name}] Track ${track.kind} unmuted`)
            );
            track.addEventListener("ended", () =>
              console.log(`[${cam.name}] Track ${track.kind} ended!`)
            );
          });

          // Wait for video to be ready with a proper event listener approach
          const waitForVideo = new Promise((resolve) => {
            let resolved = false;

            const checkAndResolve = (event) => {
              if (resolved) return;
              console.log(
                `[${cam.name}] Video event: ${event.type}, readyState: ${v.readyState}`
              );

              if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                resolved = true;
                cleanup();
                resolve(true);
              }
            };

            const cleanup = () => {
              v.removeEventListener("loadstart", checkAndResolve);
              v.removeEventListener("loadedmetadata", checkAndResolve);
              v.removeEventListener("loadeddata", checkAndResolve);
              v.removeEventListener("canplay", checkAndResolve);
              v.removeEventListener("canplaythrough", checkAndResolve);
            };

            // Listen to all relevant events
            v.addEventListener("loadstart", checkAndResolve);
            v.addEventListener("loadedmetadata", checkAndResolve);
            v.addEventListener("loadeddata", checkAndResolve);
            v.addEventListener("canplay", checkAndResolve);
            v.addEventListener("canplaythrough", checkAndResolve);

            // Timeout after 15 seconds — WebRTC streams can take longer on first connect
            setTimeout(() => {
              if (!resolved) {
                console.warn(
                  `[${cam.name}] Video ready timeout, readyState: ${v.readyState}`
                );
                resolved = true;
                cleanup();
                resolve(false);
              }
            }, 15000);

            // Check immediately in case already ready
            if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              resolved = true;
              cleanup();
              resolve(true);
            }
          });

          const videoReady = await waitForVideo;

          // Try to play
          try {
            await v.play();
            console.log(
              `[${cam.name}] Video playing, readyState: ${v.readyState}`
            );
            if (!cancelled) {
              streamReady = true;
              setIsStreaming(true);
              updateStatus("Streaming…");
            }
          } catch (e) {
            console.error(
              `[${cam.name}] Play failed:`,
              e.message,
              "readyState:",
              v.readyState
            );
            if (!cancelled) {
              updateStatus(`Play error: ${e.message}`);
            }
          }
        } else if (cam.streamType === "HLS") {
          console.log(`[${cam.name}] 🔗 Connecting to HLS:`, {
            hlsUrl: cam.hlsUrl,
          });
          if (Hls.isSupported()) {
            hls = new Hls({ liveDurationInfinity: true });
            hls.loadSource(cam.hlsUrl);
            hls.attachMedia(v);
            hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => { }));
          } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
            v.src = cam.hlsUrl;
            await v.play().catch(() => { });
          } else {
            v.src = cam.hlsUrl || "";
            await v.play().catch(() => { });
          }
        } else if (cam.streamType === "MP4") {
          console.log(`[${cam.name}] 🔗 Connecting to MP4:`, {
            url: cam.hlsUrl,
          });
          v.src = cam.hlsUrl;
          await v.play().catch(() => { });
        }
        if (!cancelled) {
          streamReady = true;
          setIsStreaming(true);
          updateStatus("Streaming…");
        }
      } catch (err) {
        if (!cancelled) {
          updateStatus(`Failed: ${err?.message || err}`);
          connectionAttempted = false;
          if (!streamReady && !retryTimeout) {
            retryTimeout = setTimeout(() => {
              retryTimeout = null;
              attachStream().then(startDetection);
            }, 3000);
          }
        }
      }
    }

    // detection wiring
    async function startDetection() {
      if (cancelled) return;
      if (isStartLocalDetection) {
        console.log(`[${cam.name}] Starting local detection (fire + weapon)...`);
        const VideoDetector = await loadVideoDetector();
        if (cancelled) return;

        const d = new VideoDetector({
          id: cam.name,
          mount: null,
          workerUrl: "../utils/worker-client.js",
          throttleMs: 50,  // ~20fps draw rate; inference still runs back-to-back via onmessage
          onDetections: (boxes) => {
            if (cancelled) return;
            const any = boxes && boxes.length > 0;
            if (any) {
              missStreakRef.current = 0;
              setIsFire(true);
              const topWeapon = boxes.find(b => b[4] === "Knife" || b[4] === "knife");
              const hasFire   = boxes.some(b => b[4] === "Fire");
              const hasSmoke  = boxes.some(b => b[4] === "Smoke");
              const hasMask   = boxes.some(b => b[4] === "with_mask" || b[4] === "mask_weared_incorrect");
              setLiveMaskPresent(hasMask);
              const fireSmokeBoxes = boxes.filter(b => b[4] === "Fire" || b[4] === "Smoke");
              const currentFireBox = fireSmokeBoxes[0] || null;
              const previousFireBox = lastFireBoxRef.current;
              if (currentFireBox && previousFireBox) {
                const iou = boxIouRef(previousFireBox, currentFireBox);
                const shift = centerShiftRef(previousFireBox, currentFireBox);
                movingFireFramesRef.current = (iou < 0.55 || shift > 0.12)
                  ? movingFireFramesRef.current + 1
                  : 0;
              }
              lastFireBoxRef.current = currentFireBox;

              if (hasFire) {
                setAlertType("Active fire detected in the scene");
              }
              else if (hasSmoke) {
                setAlertType("Smoke detected in the scene");
              }
              else if (topWeapon) {
                setAlertType("Someone carrying a knife or bladed weapon");
              }
              else if (hasMask) {
                setAlertType("Suspicious — person wearing a face mask");
              }
              else {
                setAlertType(null);
              }
            } else {
              // Require N consecutive miss frames before clearing — prevents flicker
              // from brief YOLO misses (motion blur, compression artifacts, partial occlusion).
              missStreakRef.current++;
              if (missStreakRef.current >= MISS_STREAK_CLEAR) {
                lastFireBoxRef.current = null;
                movingFireFramesRef.current = 0;
                if (staticRejectedRef.current) {
                  staticRejectedRef.current = false;
                  updateCameraStatus(cam.id, { staticRejected: false });
                }
                setIsFire(false);
                setLiveMaskPresent(false);
                setAlertType(null);
              }
            }
          },
        });

        // Manually set the internal video reference to our existing element
        d._video = v;
        d._root = v.parentElement;

        // Create overlay canvas for bounding boxes
        if (!d._overlay) {
          const canvas = document.createElement("canvas");
          canvas.style.position = "absolute";
          canvas.style.top = "0";
          canvas.style.left = "0";
          canvas.style.pointerEvents = "none";
          canvas.style.zIndex = "10";
          v.parentElement.appendChild(canvas);
          d._overlay = canvas;
          d._ctx = canvas.getContext("2d");

          // Sync canvas to the actual video CONTENT area (not the element rect)
          // because object-fit: contain leaves letterbox bars
          const syncCanvasSize = () => {
            if (v.videoWidth && v.videoHeight) {
              canvas.width = v.videoWidth;
              canvas.height = v.videoHeight;

              // Calculate the actual content rect inside the element
              const elemRect = v.getBoundingClientRect();
              const videoRatio = v.videoWidth / v.videoHeight;
              const elemRatio = elemRect.width / elemRect.height;

              let contentW, contentH, offsetX, offsetY;
              if (videoRatio > elemRatio) {
                // Video wider than element — letterbox top/bottom
                contentW = elemRect.width;
                contentH = elemRect.width / videoRatio;
                offsetX = 0;
                offsetY = (elemRect.height - contentH) / 2;
              } else {
                // Video taller than element — letterbox left/right
                contentH = elemRect.height;
                contentW = elemRect.height * videoRatio;
                offsetX = (elemRect.width - contentW) / 2;
                offsetY = 0;
              }

              canvas.style.width = `${contentW}px`;
              canvas.style.height = `${contentH}px`;

              const parentRect = v.parentElement.getBoundingClientRect();
              canvas.style.left = `${elemRect.left - parentRect.left + offsetX}px`;
              canvas.style.top = `${elemRect.top - parentRect.top + offsetY}px`;
            }
          };
          v.addEventListener("loadedmetadata", syncCanvasSize);
          v.addEventListener("resize", syncCanvasSize);
          v.addEventListener("play", syncCanvasSize);

          // Call immediately in case video is already playing (events already fired)
          syncCanvasSize();

          // Use ResizeObserver to sync canvas when video element resizes (e.g., view changes)
          resizeObserverRef.current = new ResizeObserver(() => {
            syncCanvasSize();
          });
          resizeObserverRef.current.observe(v);
        }

        detectorRef.current = d;

        // Run local workers for realtime boxes. Backend still confirms alert state.
        const aiType      = cam.aiType || "FIRE";
        const needsFire   = aiType === "FIRE";
        const needsWeapon = aiType === "WEAPON";
        const needsMask   = aiType === "MASK";

        // Start the detector (spawn worker(s) and bind video loop)
        // DON'T call attachWebRTC or start() since we're manually managing video/canvas
        if (needsFire && needsWeapon && needsMask) {
          // === Multi-worker mode: fire, weapon, and mask workers running simultaneously ===
          let fireBusy = false, weaponBusy = false, maskBusy = false;
          let fireBoxes = [], weaponBoxes = [], maskBoxes = [];
          let weaponMisses = 0;
          let maskMisses = 0;
          const WEAPON_MISS_HOLD_FRAMES = 4;
          const MASK_MISS_HOLD_FRAMES = 2;
          let boxesDirty = false; // flag to call onDetections only when results arrive

          const fireWorker = new Worker(
            fireWorkerUrl,
            { type: "module", name: `${cam.name}-fire` }
          );
          const weaponWorker = new Worker(
            weaponWorkerUrl,
            { type: "module", name: `${cam.name}-weapon` }
          );
          const maskWorker = new Worker(
            maskWorkerUrl,
            { type: "module", name: `${cam.name}-mask` }
          );

          fireWorker.onmessage = (evt) => {
            const msg = evt.data;
            const output = msg && msg.data ? msg.data : msg;
            const dims = msg && msg.dims ? msg.dims : null;
            fireBoxes = d._processOutput(output, d._overlay.width, d._overlay.height, dims);
            boxesDirty = true;
            // Immediately queue next frame so inference runs back-to-back
            // instead of waiting up to throttleMs for the next animation tick.
            if (d._video && d._overlay && d._video.videoWidth > 0) {
              const buf = d._prepareInput(d._video);
              if (buf) {
                fireWorker.postMessage(
                  { type: "infer", data: buf, dims: [1, 3, d.modelInputSize, d.modelInputSize] },
                  [buf]
                );
                fireBusy = true;
              } else {
                fireBusy = false;
              }
            } else {
              fireBusy = false;
            }
          };
          fireWorker.onerror = (e) => {
            fireBusy = false;
            logWorkerError("Fire", e);
          };

          weaponWorker.onmessage = (evt) => {
            const nextWeaponBoxes = d._processOutputWeapon(evt.data, d._overlay.width, d._overlay.height);
            if (nextWeaponBoxes.length > 0) {
              weaponBoxes = nextWeaponBoxes;
              weaponMisses = 0;
            } else if (weaponBoxes.length > 0 && weaponMisses < WEAPON_MISS_HOLD_FRAMES) {
              weaponMisses++;
            } else {
              weaponBoxes = [];
              weaponMisses = 0;
            }
            boxesDirty = true;
            // Immediately queue next frame so inference runs back-to-back.
            if (d._video && d._overlay && d._video.videoWidth > 0) {
              const buf = d._prepareInput(d._video);
              if (buf) {
                weaponWorker.postMessage(
                  { type: "infer", data: buf, dims: [1, 3, d.modelInputSize, d.modelInputSize] },
                  [buf]
                );
                weaponBusy = true;
              } else {
                weaponBusy = false;
              }
            } else {
              weaponBusy = false;
            }
          };
          weaponWorker.onerror = (e) => {
            weaponBusy = false;
            logWorkerError("Weapon", e);
          };

          maskWorker.onmessage = (evt) => {
            const nextMaskBoxes = d._processOutputMask(evt.data, d._overlay.width, d._overlay.height);
            if (nextMaskBoxes.length > 0) {
              maskBoxes = nextMaskBoxes;
              maskMisses = 0;
            } else if (maskBoxes.length > 0 && maskMisses < MASK_MISS_HOLD_FRAMES) {
              maskMisses++;
            } else {
              maskBoxes = [];
              maskMisses = 0;
            }
            boxesDirty = true;
            if (d._video && d._overlay && d._video.videoWidth > 0) {
              const buf = d._prepareInput(d._video);
              if (buf) {
                maskWorker.postMessage(
                  { type: "infer", data: buf, dims: [1, 3, d.modelInputSize, d.modelInputSize] },
                  [buf]
                );
                maskBusy = true;
              } else {
                maskBusy = false;
              }
            } else {
              maskBusy = false;
            }
          };
          maskWorker.onerror = (e) => {
            maskBusy = false;
            logWorkerError("Mask", e);
          };

          d._worker = fireWorker;
          d._weaponWorker = weaponWorker;
          d._maskWorker = maskWorker;

          console.log(`[${cam.name}] Fire + weapon + mask workers created`);

          // Bind video loop for BOTH mode
          if (!d._rafHandle) {
            let smoothedBoxes = []; // EMA-smoothed box positions to reduce per-frame jitter
            const SMOOTH_ALPHA = 0.35; // 0=never update, 1=no smoothing
            const boxIou = (a, b) => {
              const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
              const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
              const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
              const areaA = (a[2] - a[0]) * (a[3] - a[1]);
              const areaB = (b[2] - b[0]) * (b[3] - b[1]);
              return inter / (areaA + areaB - inter + 1e-6);
            };
            const smoothBoxes = (rawBoxes) => {
              if (!smoothedBoxes.length) return (smoothedBoxes = rawBoxes.map(b => [...b]));
              const next = rawBoxes.map(raw => {
                const match = smoothedBoxes.find(s => s[4] === raw[4] && boxIou(s, raw) > 0.3);
                if (!match) return [...raw];
                const alpha = raw[4] === "Knife" ? 0.85 : SMOOTH_ALPHA;
                return [
                  match[0] + alpha * (raw[0] - match[0]),
                  match[1] + alpha * (raw[1] - match[1]),
                  match[2] + alpha * (raw[2] - match[2]),
                  match[3] + alpha * (raw[3] - match[3]),
                  raw[4], raw[5],
                ];
              });
              smoothedBoxes = next;
              return next;
            };

            const tick = (t) => {
              d._rafHandle = requestAnimationFrame(tick);
              if (t - d._lastTick < d.throttleMs) return;
              d._lastTick = t;

              if (!d._video || !d._overlay) return;
              if (d._video.videoWidth === 0 || d._video.videoHeight === 0) return;

              // Force-clear overlay when backend confirms the active alert is gone
              if (forceClearOverlayRef.current) {
                forceClearOverlayRef.current = false;
                fireBoxes = []; weaponBoxes = []; maskBoxes = [];
                smoothedBoxes = []; weaponMisses = 0; maskMisses = 0;
              }

              // Merge boxes from local models, apply temporal smoothing
              const rawBoxes = [...fireBoxes, ...weaponBoxes, ...maskBoxes];
              d._boxes = smoothBoxes(rawBoxes);
              // Always clear backend canvas — YOLO overlay is the live source of truth.
              // Backend boxes are 3s stale and redundant when YOLO runs at 20fps.
              if (backendCanvasRef.current) {
                backendCanvasRef.current.getContext("2d").clearRect(
                  0, 0, backendCanvasRef.current.width, backendCanvasRef.current.height
                );
              }
              const overlayBoxes = getOverlayBoxes(d._boxes);
              d._ctx.clearRect(0, 0, d._overlay.width, d._overlay.height);
              if (showBoxesRef.current) {
                d._drawBoxes(overlayBoxes);
              }

              // Only call onDetections when a worker returned new results
              if (boxesDirty) {
                d.onDetections(d._boxes);
                boxesDirty = false;
              }

              // Send frames to whichever worker isn't busy
              const buffer = d._prepareInput(d._video);
              if (!buffer) return;

              if (!fireBusy || !weaponBusy || !maskBusy) {
                const shared = new Float32Array(buffer);
                if (!fireBusy) {
                  const copy = shared.buffer.slice(0);
                  fireWorker.postMessage(
                    { type: "infer", data: copy, dims: [1, 3, d.modelInputSize, d.modelInputSize] },
                    [copy]
                  );
                  fireBusy = true;
                }
                if (!weaponBusy) {
                  const copy = shared.buffer.slice(0);
                  weaponWorker.postMessage(
                    { type: "infer", data: copy, dims: [1, 3, d.modelInputSize, d.modelInputSize] },
                    [copy]
                  );
                  weaponBusy = true;
                }
                if (!maskBusy) {
                  const copy = shared.buffer.slice(0);
                  maskWorker.postMessage(
                    { type: "infer", data: copy, dims: [1, 3, d.modelInputSize, d.modelInputSize] },
                    [copy]
                  );
                  maskBusy = true;
                }
              }
            };

            const startLoop = () => {
              if (!d._rafHandle) {
                d._rafHandle = requestAnimationFrame(tick);
                console.log(`[${cam.name}] BOTH detection loop started`);
              }
            };
            v.addEventListener("play", startLoop, { once: true });
            if (!v.paused && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              startLoop();
            }
          }
        } else {
          // === Single model mode (FIRE or WEAPON) ===
          if (!d._worker) {
            const workerUrl = needsWeapon
              ? weaponWorkerUrl
              : needsMask
                ? maskWorkerUrl
                : fireWorkerUrl;

            d._worker = new Worker(
              workerUrl,
              { type: "module", name: cam.name }
            );

            let firstResponse = true;
            let singleMissStreak = 0;
            const SINGLE_WEAPON_HOLD = 8; // hold weapon/mask boxes for 8 missed frames before clearing
            d._worker.onmessage = (evt) => {
              const msg = evt.data;

              let fresh;
              if (needsWeapon && msg && typeof msg === "object" && "newOut" in msg) {
                // Dual-model weapon response: merge boxes from both models
                const W = d._overlay.width, H = d._overlay.height;
                const newBoxes = d._processOutputWeapon(msg.newOut, W, H);
                const legacyBoxes = d._processOutputWeaponLegacy(msg.legacyOut, W, H);
                if (firstResponse) {
                  firstResponse = false;
                  console.log(`[${cam.name}] Weapon dual-model loaded — knife_yolov8n boxes: ${newBoxes.length}, weapons_yolo boxes: ${legacyBoxes.length}`);
                } else if (Math.random() < 0.05) {
                  console.log(`[${cam.name}] knife_yolov8n: ${newBoxes.length} (conf ${newBoxes[0]?.[5]?.toFixed(2) ?? "—"}) | weapons_yolo: ${legacyBoxes.length} (conf ${legacyBoxes[0]?.[5]?.toFixed(2) ?? "—"})`);
                }
                fresh = [...newBoxes, ...legacyBoxes];
              } else {
                const output = msg && msg.data ? msg.data : msg;
                const dims = msg && msg.dims ? msg.dims : null;
                if (firstResponse) {
                  firstResponse = false;
                  console.log(`[${cam.name}] First inference response — output length: ${output?.length}, dims: [${dims || []}], canvas: ${d._overlay.width}x${d._overlay.height}`);
                }
                fresh = needsMask
                  ? d._processOutputMask(output, d._overlay.width, d._overlay.height)
                  : d._processOutput(output, d._overlay.width, d._overlay.height, dims);
              }

              if (fresh.length > 0) {
                singleMissStreak = 0;
                d._boxes = fresh;
              } else if ((needsWeapon || needsMask) && d._boxes.length > 0 && singleMissStreak < SINGLE_WEAPON_HOLD) {
                singleMissStreak++;
                // keep d._boxes from previous frame — don't update
              } else {
                singleMissStreak = 0;
                d._boxes = fresh;
              }
              d.onDetections(d._boxes);
              d._busy = false;
            };

            d._worker.onerror = (e) => {
              logWorkerError(needsWeapon ? "Weapon" : needsMask ? "Mask" : "Fire", e);
              d._worker = null;
              d._busy = false; // Reset so loop doesn't get stuck
            };

            console.log(`[${cam.name}] ${needsWeapon ? "Weapon" : needsMask ? "Mask" : "Fire"} worker created`);
          }

          // Bind video loop for single model
          if (!d._rafHandle) {
            let loggedFirstTick = false;
            const tick = (t) => {
              d._rafHandle = requestAnimationFrame(tick);
              if (t - d._lastTick < d.throttleMs) return;
              d._lastTick = t;

              if (!d._video || !d._overlay) return;
              if (d._video.videoWidth === 0 || d._video.videoHeight === 0) return;

              if (!loggedFirstTick) {
                loggedFirstTick = true;
                console.log(`[${cam.name}] Detection tick running — video: ${d._video.videoWidth}x${d._video.videoHeight}, canvas: ${d._overlay.width}x${d._overlay.height}, worker: ${!!d._worker}`);
              }

              // Clear canvas and draw only boxes (NOT the video)
              d._ctx.clearRect(0, 0, d._overlay.width, d._overlay.height);

              // Frontend YOLO is the authoritative source of bounding boxes — keep backend canvas clear
              if (backendCanvasRef.current) {
                backendCanvasRef.current.getContext("2d").clearRect(
                  0, 0, backendCanvasRef.current.width, backendCanvasRef.current.height
                );
              }

              if (showBoxesRef.current) {
                d._drawBoxes(getOverlayBoxes(d._boxes));
              }

              if (d._busy) return;

              // Prepare input from video element (not canvas)
              const buffer = d._prepareInput(d._video);
              if (!buffer) {
                if (!d._prepareInputWarnLogged) {
                  console.warn(`[${cam.name}] _prepareInput returned null (likely CORS). Detection frames cannot be sent.`);
                  d._prepareInputWarnLogged = true;
                }
                return;
              }

              if (d._worker) {
                d._worker.postMessage(
                  {
                    type: "infer",
                    data: buffer,
                    dims: [1, 3, d.modelInputSize, d.modelInputSize],
                  },
                  [buffer]
                );
                d._busy = true;
              }
            };

            // Start loop when video plays
            const startLoop = () => {
              if (!d._rafHandle) {
                d._rafHandle = requestAnimationFrame(tick);
                console.log(`[${cam.name}] Detection loop started`);
              }
            };

            v.addEventListener("play", startLoop, { once: true });

            // Also start now if already playing
            if (!v.paused && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              startLoop();
            }
          }
        }
      }
      // CLOUD DETECTION HANDLED BY BACKEND
      // else if (cam.detection === "CLOUD") {
      //   abortRef.current = startCloudDetect({
      //     video: v,
      //     endpoint: cam.awsEndpoint,
      //     intervalMs: cam.cloudFps ? 1000 / cam.cloudFps : 500, // ~2 fps default
      //     onResult: (r) => {
      //       if (cancelled) return;
      //       const any = !!(r?.isFire || r?.detections?.length > 0);
      //       setIsFire(any);
      //       // Don't update status for fire detection - keep it separate
      //     },
      //     onError: (e) => {
      //       if (!cancelled) updateStatus(`Cloud error: ${e?.message || e}`);
      //     },
      //   });
      // }
    }

    attachStream().then(startDetection);

    return () => {
      console.log(`[${cam.name}] Cleaning up...`);
      cancelled = true;

      // Clear spinner timeout
      if (spinnerTimeoutRef.current) {
        clearTimeout(spinnerTimeoutRef.current);
        spinnerTimeoutRef.current = null;
      }

      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }

      if (hls) {
        try {
          hls.destroy();
        } catch (e) {
          console.warn(`[${cam.name}] HLS cleanup error:`, e);
        }
      }

      if (pcRef.current) {
        try {
          console.log(`[${cam.name}] Closing PeerConnection`);
          pcRef.current.close();
          pcRef.current = null;
        } catch (e) {
          console.warn(`[${cam.name}] PC cleanup error:`, e);
        }
      }

      if (detectorRef.current) {
        try {
          // Terminate extra workers if they exist (multi-worker mode)
          if (detectorRef.current._weaponWorker) {
            detectorRef.current._weaponWorker.terminate();
            detectorRef.current._weaponWorker = null;
          }
          if (detectorRef.current._maskWorker) {
            detectorRef.current._maskWorker.terminate();
            detectorRef.current._maskWorker = null;
          }
          // Remove overlay canvas if it exists
          if (
            detectorRef.current._overlay &&
            detectorRef.current._overlay.parentElement
          ) {
            detectorRef.current._overlay.parentElement.removeChild(
              detectorRef.current._overlay
            );
          }
          detectorRef.current.stop();
          detectorRef.current = null;
        } catch (e) {
          console.warn(`[${cam.name}] Detector cleanup error:`, e);
        }
      }

      if (abortRef.current) {
        stopCloudDetect(abortRef.current);
        abortRef.current = null;
      }

      // Clean up ResizeObserver
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }

      // Clean up video element
      if (v) {
        v.srcObject = null;
        v.onerror = null;
      }
    };
  }, [
    cam.id,
    cam.streamType,
    cam.webrtcBase,
    cam.streamName,
    cam.detection,
    cam.aiType,
  ]);

  const displayFireStatus = cam.isFire || isFire;

  // All labels now come from CLIP directly — no hardcoded mappings needed.
  // Fire-started: "Active fire detected in the scene" (from CLIP verify)
  // Fire-clear: CLIP describes why ("Camera moved away from the fire source", etc.)
  // Behavioral: CLIP sentence labels ("Someone carrying a knife...", etc.)
  const localLabel = displayFireStatus ? alertType : null;
  const backendLabel = displayFireStatus ? (cam.persistentLabel || cam.alertType) : null;
  const backendLabelIsMask = typeof backendLabel === "string" &&
    /mask|face|balaclava/i.test(backendLabel);
  const rawLabel = localLabel
    ? localLabel
    : backendLabelIsMask && !liveMaskPresent
      ? null
      : backendLabel;
  const displayLabel = rawLabel || null;

  // Map label to CSS colour
  const detectionLabelColor = (() => {
    if (!displayLabel) return null;
    const t = displayLabel.toLowerCase();
    if (t.includes("smoke"))                                        return "#ffb86c";
    if (t.includes("no longer") || t.includes("cleared"))          return "#50fa7b";
    if (t.includes("fire") || t.includes("active fire"))           return "#f97316";
    if (t.includes("threat"))                                       return "#ff5555";
    if (t.includes("weapon") || t.includes("knife") || t.includes("bladed")) return "#8be9fd";
    if (t.includes("mask") || t.includes("face") || t.includes("balaclava")) return "#bd93f9";
    if (t.includes("suspicious"))                                   return "#ff79c6";
    if (t.includes("dancing") || t.includes("rhythmic"))           return "#8be9fd";
    if (t.includes("entering") || t.includes("entry"))             return "#ffb86c";
    if (t.includes("loiter"))                                       return "#8be9fd";
    return "#f97316";
  })();

  return (
    <div className="tile">
      <div className="tile-header">
        <div className="tile-title">
          <StreamingIcon isStreaming={isStreaming} size={22} />
          <span className="name">{cam.name}</span>
          <span className="location">{cam.location}</span>
        </div>
      </div>
      <div className="video-wrap" onMouseEnter={() => setViewed(true)}>
        <video ref={videoRef} autoPlay muted playsInline controls />
        <canvas
          ref={backendCanvasRef}
          style={{ position: "absolute", pointerEvents: "none", zIndex: 10 }}
        />
        {(showSpinner || (status !== "Streaming…" && status !== "Idle")) && (
          <div className="status-overlay">
            {showSpinner ? (
              <FaSpinner className="status-icon spinning" size={32} />
            ) : status.startsWith("Failed") ||
              status.includes("error") ||
              status.includes("Error") ? (
              <FaExclamationCircle className="status-icon error" size={32} />
            ) : null}
          </div>
        )}
        {displayLabel && (
          <div
            className="detection-label"
            style={{ borderLeftColor: detectionLabelColor, color: detectionLabelColor }}
          >
            {displayLabel}
          </div>
        )}
      </div>
    </div>
  );
}
