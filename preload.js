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
  // Version RÉELLE de l'app, lue au chargement via IPC synchrone (remplace
  // l'ancienne valeur en dur « 0.1.0 »). Sert au badge de version des Paramètres.
  version: ipcRenderer.sendSync("app:version:sync"),
  platform: process.platform,
  // Pilotage du copilote depuis le SaaS (bouton « Lancer le copilote »). Le
  // process principal applique d'abord le gate Auth/abonnement avant de lancer.
  copilot: {
    start: () => ipcRenderer.invoke("copilot:start"),
    stop: () => ipcRenderer.invoke("copilot:stop"),
    toggle: () => ipcRenderer.invoke("copilot:toggle"),
    isRunning: () => ipcRenderer.invoke("copilot:isRunning"),
    state: () => ipcRenderer.invoke("copilot:state"), // off | starting | ready
    // Cockpit NATIF (écran recodé dans le SaaS) : préparer le cerveau, lire l'état
    // complet (cerveau + oreille), démarrer l'écoute (LE bouton), raccrocher.
    prepare: () => ipcRenderer.invoke("copilot:prepare"),
    statusFull: () => ipcRenderer.invoke("copilot:statusFull"),
    startListening: (payload) =>
      ipcRenderer.invoke("copilot:startListening", payload),
    endCall: () => ipcRenderer.invoke("copilot:endCall"),
  },
  // Cockpit d'Eliott intégré dans la page : le SaaS indique la région où le
  // process principal pose la vue (le vrai launcher.html, non modifié).
  launcher: {
    // theme : "light" | "dark" du SaaS → le cockpit s'y accorde (fond, texte).
    show: (bounds, theme) => ipcRenderer.invoke("launcher:show", bounds, theme),
    setBounds: (bounds) => ipcRenderer.send("launcher:bounds", bounds),
    setTheme: (theme) => ipcRenderer.send("launcher:setTheme", theme),
    hide: () => ipcRenderer.send("launcher:hide"),
  },
  // Réglages du copilote (Paramètres → Copilote d'appel) : lus/écrits dans le
  // fichier local du runtime, relayés à chaud s'il tourne.
  copilotSettings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (key, value) => ipcRenderer.invoke("settings:set", key, value),
  },
});
