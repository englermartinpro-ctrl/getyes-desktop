// GetYes Desktop — preload (pont sécurisé fenêtre ↔ processus principal)
// -----------------------------------------------------------------------------
// Expose un objet MINIMAL et contrôlé à la page web (contextIsolation activé).
// v0.1 : sert surtout à laisser le SaaS DÉTECTER qu'il tourne dans l'app desktop
// (utile pour déverrouiller la page « copilote d'appel » / RuntimeGate, qui sait
// alors que le runtime local est disponible).
//
// Plus tard, on ajoutera ici des méthodes contrôlées : démarrer/arrêter le
// runtime Python, connaître l'état du WebSocket ws://127.0.0.1:8765, etc.

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("getyesDesktop", {
  isDesktop: true,
  version: "0.1.0",
  platform: process.platform,
});
