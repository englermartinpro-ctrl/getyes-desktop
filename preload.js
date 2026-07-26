// GetYes Desktop — preload (pont sécurisé fenêtre ↔ processus principal)
// -----------------------------------------------------------------------------
// Expose un objet MINIMAL et contrôlé à la page web (contextIsolation activé).
// v0.1 : sert surtout à laisser le SaaS DÉTECTER qu'il tourne dans l'app desktop
// (utile pour déverrouiller la page « copilote d'appel » / RuntimeGate, qui sait
// alors que le runtime local est disponible).
//
// Plus tard, on ajoutera ici des méthodes contrôlées : démarrer/arrêter le
// runtime Python, connaître l'état du WebSocket ws://127.0.0.1:8765, etc.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("getyesDesktop", {
  isDesktop: true,
  version: "0.1.0",
  platform: process.platform,
  // Pilotage du copilote depuis le SaaS (bouton « Lancer le copilote »). Le
  // process principal applique d'abord le gate Auth/abonnement avant de lancer.
  copilot: {
    start: () => ipcRenderer.invoke("copilot:start"),
    stop: () => ipcRenderer.invoke("copilot:stop"),
    toggle: () => ipcRenderer.invoke("copilot:toggle"),
    isRunning: () => ipcRenderer.invoke("copilot:isRunning"),
    state: () => ipcRenderer.invoke("copilot:state"), // off | starting | ready
  },
  // Cockpit d'Eliott intégré dans la page : le SaaS indique la région où le
  // process principal pose la vue (le vrai launcher.html, non modifié).
  launcher: {
    show: (bounds) => ipcRenderer.invoke("launcher:show", bounds),
    setBounds: (bounds) => ipcRenderer.send("launcher:bounds", bounds),
    hide: () => ipcRenderer.send("launcher:hide"),
  },
});
