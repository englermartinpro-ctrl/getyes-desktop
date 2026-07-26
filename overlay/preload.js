// Preload de l'overlay — surface minimale et sûre (contextIsolation ON).
// Le rendu de l'overlay parle au serveur WS directement (API WebSocket standard) ;
// on n'expose ici que ce qui doit passer par le process principal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayAPI", {
  hide: () => ipcRenderer.send("overlay:hide"),
  // Croix « terminer l'appel » : enregistre le bilan puis coupe l'écoute + referme.
  endCall: () => ipcRenderer.send("overlay:endCall"),
});
