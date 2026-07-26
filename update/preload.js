// Preload du pop-up de mise à jour — surface minimale (contextIsolation ON).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updateAPI", {
  onInfo: (cb) => ipcRenderer.on("update:info", (_e, data) => cb(data)),
  relaunch: () => ipcRenderer.send("update:relaunch"),
  later: () => ipcRenderer.send("update:later"),
  resize: (h) => ipcRenderer.send("update:resize", h),
});
