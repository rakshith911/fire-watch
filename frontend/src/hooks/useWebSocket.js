// src/hooks/useWebSocket.js
import { useEffect, useCallback, useRef } from "react";
import { initWebSocket, closeWebSocket } from "../utils/webSocketClient.js";
import { useCameras } from "../store/cameras.jsx";

export function useWebSocket() {
  const { updateCameraStatus, setCameraVisibilityById, pushDetectionEvent } = useCameras();
  const isInitialized = useRef(false);

  const handleFireDetection = useCallback(
    (cameraId, isFire, data = {}) => {
      const boxes = Array.isArray(data.boxes) ? data.boxes : [];
      const event = data.event || null;
      const isBehavioral = data.isBehavioral || false;
      const reason = data.reason || null;

      // Explicit backend clears: wipe stale label + boxes + alert state immediately.
      if (reason === "person_left" || reason === "weapon_gone" || reason === "mask_gone") {
        updateCameraStatus(cameraId, { persistentLabel: null, boxes: [], isFire: false, alertType: null });
        return;
      }
      // "person_outside_zone" — just clear stale person boxes, keep fire/label state
      if (reason === "person_outside_zone") {
        updateCameraStatus(cameraId, { boxes: [] });
        return;
      }

      // Build status update — isFire and boxes always update
      const statusUpdate = {
        isFire,
        boxes: isFire ? boxes : [],
        alertType: isFire ? (data.alertType || null) : null,
      };

      // Track whether the backend explicitly rejected this as a static/screen image.
      // When staticRejected=true, CameraTile suppresses the local YOLO fire label
      // so the user doesn't see "active fire" for a photo or phone screen.
      const STATIC_REASONS = new Set([
        "clip_static_photo", "clip_screen_video", "multi_static_signal",
        "inter_cycle_static", "static_sidecar_error",
        "clip_no_fire_suspicious",
      ]);
      if (!isFire && STATIC_REASONS.has(reason)) {
        statusUpdate.staticRejected = true;
      } else if (isFire) {
        // Backend confirmed real fire — clear any previous static rejection
        statusUpdate.staticRejected = false;
      } else if (reason === "no_detection") {
        // Fire genuinely gone (user moved camera away) — clear static flag too
        statusUpdate.staticRejected = false;
      }

      // persistentLabel only updates when fire is ACTIVE (not on fire-clear events).
      // Clear events (isFire=false) always wipe the label immediately.
      if (isFire && event) {
        statusUpdate.persistentLabel = event;
      } else if (isFire && isBehavioral && data.clipLabel) {
        statusUpdate.persistentLabel = data.clipLabel;
      } else if (!isFire) {
        // Fire cleared — wipe label too
        statusUpdate.persistentLabel = null;
      }

      updateCameraStatus(cameraId, statusUpdate);
      pushDetectionEvent(cameraId, isFire, data);

      if (isFire || event) {
        setCameraVisibilityById(cameraId, true);
      }
    },
    [updateCameraStatus, setCameraVisibilityById, pushDetectionEvent]
  );

  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;
    initWebSocket(handleFireDetection);

    return () => {
      closeWebSocket();
      isInitialized.current = false;
    };
  }, [handleFireDetection]);
}
