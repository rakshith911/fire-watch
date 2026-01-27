const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getBackendStatus: () => ipcRenderer.invoke("get-backend-status"),
  getLogPath: () => ipcRenderer.invoke("get-log-path"),
  platform: process.platform,
  versions: process.versions,
});
