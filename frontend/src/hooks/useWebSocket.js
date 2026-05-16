// src/hooks/useWebSocket.js
import { useEffect, useCallback, useRef } from "react";
import { initWebSocket, closeWebSocket } from "../utils/webSocketClient.js";
import { useCameras } from "../store/cameras.jsx";

/**
 * Custom hook to manage WebSocket connection for fire detection alerts.
 * Automatically shows cameras and starts streams when fire is detected.
 */
export function useWebSocket() {
  const { updateCameraStatus, setCameraVisibilityById } = useCameras();
  const isInitialized = useRef(false);
  // Track cameras that were auto-shown by detection so we only auto-hide those
  const autoShownCameras = useRef(new Set());

  const handleFireDetection = useCallback(
    (cameraId, isFire, data = {}) => {
      console.log(`🔥 Fire detection update: Camera ${cameraId}, isFire=${isFire}`);
      const boxes = Array.isArray(data.boxes) ? data.boxes : [];

      // Update fire status and keep backend boxes so packaged builds can draw
      // overlays even if the renderer-side model is not producing boxes.
      updateCameraStatus(cameraId, {
        isFire,
        alertType: isFire ? (data.alertType || null) : null,
        boxes: isFire ? boxes : [],
      });

      if (isFire) {
        // Auto-show camera and track that we opened it
        console.log(`🎥 Auto-showing camera ${cameraId} due to fire detection`);
        autoShownCameras.current.add(cameraId);
        setCameraVisibilityById(cameraId, true);
      } else if (
        (data.reason === "static_fire" || data.reason === "weapon_clear") &&
        autoShownCameras.current.has(cameraId)
      ) {
        // Fire streams stay up on normal clear, but static fire and cleared weapon alerts auto-hide.
        console.log(`🎥 Auto-hiding camera ${cameraId} — ${data.reason}`);
        autoShownCameras.current.delete(cameraId);
        setCameraVisibilityById(cameraId, false);
      }
    },
    [updateCameraStatus, setCameraVisibilityById]
  );

  useEffect(() => {
    // Prevent multiple initializations
    if (isInitialized.current) return;

    console.log("🔌 Initializing WebSocket connection...");
    isInitialized.current = true;
    initWebSocket(handleFireDetection);

    return () => {
      console.log("🔌 Cleaning up WebSocket connection...");
      closeWebSocket();
      isInitialized.current = false;
    };
  }, [handleFireDetection]);
}
