// import React, { useEffect, useRef, useState } from "react";
// import Hls from "hls.js";
// import { FaSpinner, FaExclamationCircle } from "react-icons/fa";
// import { startCloudDetect, stopCloudDetect } from "../utils/cloudDetect.js";
// import { playWebRTC } from "../utils/playWebRTC.js";
// import { useCameras } from "../store/cameras.jsx";
// import StreamingIcon from "./StreamingIcon.jsx";
// import FireStatusButton from "./FireStatusButton.jsx";

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

import React, { useEffect, useRef, useState, useMemo } from "react";
import Hls from "hls.js";
import { FaSpinner, FaExclamationCircle } from "react-icons/fa";
import { startCloudDetect, stopCloudDetect } from "../utils/cloudDetect.js";
import { playWebRTC } from "../utils/playWebRTC.js";
import { useCameras } from "../store/cameras.jsx";
import StreamingIcon from "./StreamingIcon.jsx";
import FireStatusButton from "./FireStatusButton.jsx";
import { getMediaMTXUrl } from "../config/electron.js";
import { sendDetectionEvent } from "../utils/webSocketClient.js";

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
  const [alertType, setAlertType] = useState(null); // "Fire", "Knife", "Pistol", etc.
  const { updateCameraStatus, showBoundingBoxes } = useCameras();

  // Flag to control local detection - set to false to disable local detection. Change to true to enable local detection.
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

  useEffect(() => {
    showBoxesRef.current = showBoundingBoxes;
  }, [showBoundingBoxes]);


  // Resolve detection method once (default to LOCAL if missing from DB)
  const detMethod = (cam.detection || "LOCAL").toUpperCase();
  const isLocalDetection = detMethod === "LOCAL" || detMethod === "BOTH";

  // Update camera status in store whenever local state changes
  useEffect(() => {
    const updates = { isStreaming };

    if (isStartLocalDetection && isLocalDetection) {
      updates.isFire = isFire;
      updates.alertType = alertType;
    }

    updateCameraStatus(cam.id, updates);
  }, [isFire, isStreaming, alertType, cam.id, isLocalDetection, updateCameraStatus]);

  useEffect(() => {
    const v = videoRef.current;
    let hls;
    let cancelled = false;
    let connectionAttempted = false;

    async function attachStream() {
      // ... (stream connection logic remains same) ...
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
          // const webrtcBase = cam.webrtcBase;
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

            // Timeout after 5 seconds
            setTimeout(() => {
              if (!resolved) {
                console.warn(
                  `[${cam.name}] Video ready timeout, readyState: ${v.readyState}`
                );
                resolved = true;
                cleanup();
                resolve(false);
              }
            }, 5000);

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
          setIsStreaming(true);
          updateStatus("Streaming…");
        }
      } catch (err) {
        if (!cancelled) {
          updateStatus(`Failed: ${err?.message || err}`);
        }
      }
    }

    // detection wiring
    async function startDetection() {
      if (cancelled) return;
      if (isStartLocalDetection && isLocalDetection) {
        console.log(`[${cam.name}] Starting local detection...`);
        const VideoDetector = await loadVideoDetector();
        if (cancelled) return;

        // Determine correct worker based on AI type
        const aiType = (cam.aiType || "FIRE").toUpperCase();
        let selectedWorkerUrl = "../utils/worker-client.js"; // Default Fire

        if (aiType.includes("WEAPON")) {
          selectedWorkerUrl = "../utils/worker-weapon.js";
          console.log(`[${cam.name}] Using WEAPON worker: ${selectedWorkerUrl}`);
        } else {
          console.log(`[${cam.name}] Using FIRE worker: ${selectedWorkerUrl}`);
        }

        // Don't let VideoDetector create its own video - use existing one
        const d = new VideoDetector({
          id: cam.name,
          mount: null, // Don't mount - we'll attach to existing video
          workerUrl: selectedWorkerUrl,
          throttleMs: 80,
          onDetections: (boxes) => {
            if (cancelled) return;
            const any = boxes && boxes.length > 0;
            setIsFire(any);

            // Determine alert type from box labels
            if (any) {
              const weaponLabels = ["Knife", "Pistol"];
              const hasWeapon = boxes.some(b => weaponLabels.includes(b[4]));
              const hasFire = boxes.some(b => b[4] === "Fire" || b[4] === "Smoke");
              if (hasWeapon) {
                // Use the specific weapon label (Knife or Pistol)
                const topWeapon = boxes.find(b => weaponLabels.includes(b[4]));
                setAlertType(topWeapon[4]);
              } else if (hasFire) {
                setAlertType("Fire");
              }
            } else {
              setAlertType(null);
            }

            // Send high-confidence detections to backend (debounced 5s)
            if (any) {
              const highConfBoxes = boxes.filter((b) => b[5] >= 0.5);
              const now = Date.now();
              if (highConfBoxes.length > 0 && now - lastDetectionSentRef.current > 5000) {
                lastDetectionSentRef.current = now;
                console.log(`[${cam.name}] Sending frontend detection to backend:`, {
                  boxCount: highConfBoxes.length,
                  labels: highConfBoxes.map(b => `${b[4]}(${b[5]?.toFixed(2)})`),
                });
                sendDetectionEvent({
                  type: "frontend-detection",
                  cameraId: cam.id,
                  cameraName: cam.name,
                  boxes: highConfBoxes,
                  timestamp: new Date().toISOString(),
                });
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

        // Determine which model(s) to run based on camera aiType
        const camAiType = (cam.aiType || "FIRE").toUpperCase();
        const needsFire = camAiType.includes("FIRE") || camAiType.includes("BOTH");
        const needsWeapon = camAiType.includes("WEAPON") || camAiType.includes("BOTH");

        console.log(`[${cam.name}] aiType=${camAiType} needsFire=${needsFire} needsWeapon=${needsWeapon}`);

        // Start the detector (spawn worker(s) and bind video loop)
        // DON'T call attachWebRTC or start() since we're manually managing video/canvas
        if (needsFire && needsWeapon) {
          // === BOTH mode: two workers running simultaneously ===
          let fireBusy = false, weaponBusy = false;
          let fireBoxes = [], weaponBoxes = [];
          let boxesDirty = false;

          const fireWorker = new Worker(
            new URL("../utils/worker-client.js", import.meta.url),
            /* @vite-ignore */ { type: "module", name: `${cam.name}-fire` }
          );
          const weaponWorker = new Worker(
            new URL("../utils/worker-weapon.js", import.meta.url),
            /* @vite-ignore */ { type: "module", name: `${cam.name}-weapon` }
          );

          fireWorker.onmessage = (evt) => {
            fireBoxes = d._processOutput(evt.data, d._overlay.width, d._overlay.height);
            fireBusy = false;
            boxesDirty = true;
          };
          fireWorker.onerror = (e) => {
            console.error(`[${cam.name}] Fire worker error:`, e);
            fireBusy = false;
          };

          weaponWorker.onmessage = (evt) => {
            const raw = evt.data;
            const data = raw.data || raw;
            const dims = raw.dims || null;

            weaponBoxes = d._processOutputWeapon(data, d._overlay.width, d._overlay.height, dims);
            weaponBusy = false;
            boxesDirty = true;
          };
          weaponWorker.onerror = (e) => {
            console.error(`[${cam.name}] Weapon worker error:`, e);
            weaponBusy = false;
          };

          d._worker = fireWorker;
          d._weaponWorker = weaponWorker;

          console.log(`[${cam.name}] Both fire + weapon workers created`);

          // Bind video loop for BOTH mode
          if (!d._rafHandle) {
            const tick = (t) => {
              d._rafHandle = requestAnimationFrame(tick);
              if (t - d._lastTick < d.throttleMs) return;
              d._lastTick = t;

              if (!d._video || !d._overlay) return;
              if (d._video.videoWidth === 0 || d._video.videoHeight === 0) return;

              // Merge boxes from both models and draw
              d._boxes = [...fireBoxes, ...weaponBoxes];
              d._ctx.clearRect(0, 0, d._overlay.width, d._overlay.height);
              if (showBoxesRef.current) {
                d._drawBoxes(d._boxes);
              }

              // Only call onDetections when a worker returned new results
              if (boxesDirty) {
                d.onDetections(d._boxes);
                boxesDirty = false;
              }

              // Send frames to whichever worker isn't busy
              const buffer = d._prepareInput(d._video);
              if (!buffer) return;

              // Both workers need the same input — copy for the second
              if (!fireBusy || !weaponBusy) {
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
              ? new URL("../utils/worker-weapon.js", import.meta.url)
              : new URL("../utils/worker-client.js", import.meta.url);

            d._worker = new Worker(
              workerUrl,
              /* @vite-ignore */ { type: "module", name: cam.name }
            );

            let firstResponse = true;
            d._worker.onmessage = (evt) => {
              const raw = evt.data;
              // Weapon worker sends {data, dims}; fire worker sends flat Float32Array
              const output = raw.data || raw;
              const dims = raw.dims || null;
              if (firstResponse) {
                firstResponse = false;
                console.log(`[${cam.name}] First inference response received — model loaded OK, output length: ${output.length}, dims: ${JSON.stringify(dims)}, canvas: ${d._overlay.width}x${d._overlay.height}`);
              }
              d._boxes = needsWeapon
                ? d._processOutputWeapon(output, d._overlay.width, d._overlay.height, dims)
                : d._processOutput(output, d._overlay.width, d._overlay.height);
              d.onDetections(d._boxes);
              d._busy = false;
            };

            d._worker.onerror = (e) => {
              console.error(`[${cam.name}] Worker error:`, e);
              d._worker = null;
              d._busy = false; // Reset so loop doesn't get stuck
            };

            console.log(`[${cam.name}] ${needsWeapon ? "Weapon" : "Fire"} worker created`);
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

              if (showBoxesRef.current) {
                d._drawBoxes(d._boxes);
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
          // Terminate weapon worker if it exists (BOTH mode)
          if (detectorRef.current._weaponWorker) {
            detectorRef.current._weaponWorker.terminate();
            detectorRef.current._weaponWorker = null;
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
  ]);

  const displayFireStatus = cam.isFire || isFire;
  // Determine which alert type to display — local detection takes priority, then backend
  const displayAlertType = alertType || cam.alertType || (displayFireStatus ? "Fire" : null);

  return (
    <div className="tile">
      <div className="tile-header">
        <div className="tile-title">
          <StreamingIcon isStreaming={isStreaming} size={22} />
          <span className="name">{cam.name}</span>
          <span className="location">{cam.location}</span>
        </div>
        <div className="tile-status-icons">
          <FireStatusButton
            isFire={displayFireStatus}
            alertType={displayAlertType}
            key={`fire-${displayFireStatus}-${displayAlertType}`}
          />
        </div>
      </div>
      <div className="video-wrap" onMouseEnter={() => setViewed(true)}>
        <video ref={videoRef} autoPlay muted playsInline controls />
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
      </div>
    </div>
  );
}
