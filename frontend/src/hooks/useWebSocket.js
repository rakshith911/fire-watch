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

      // "person_left" / "weapon_gone" clear label + boxes, don't touch fire state
      if (reason === "person_left" || reason === "weapon_gone") {
        updateCameraStatus(cameraId, { persistentLabel: null, boxes: [] });
        return;
      }

      // Build status update — isFire and boxes always update
      const statusUpdate = {
        isFire,
        boxes: isFire ? boxes : [],
        alertType: isFire ? (data.alertType || null) : null,
      };

      // persistentLabel only updates on explicit events or behavioral detections.
      // Repeat fire cycles (event=null) don't overwrite "Fire Started" with "Fire".
      if (event) {
        statusUpdate.persistentLabel = event;
      } else if (isBehavioral && data.clipLabel) {
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
