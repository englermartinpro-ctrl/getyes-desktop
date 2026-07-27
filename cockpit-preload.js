// Preload du COCKPIT (launcher.html) — surface minimale exposée à la vue du
// cockpit (contextIsolation ON). Sert au sélecteur de prospect injecté :
// lister les prospects (via le SaaS), en créer un, et signaler le prospect
// choisi. Le LIEN appel→prospect (sauvegarde du rapport) est côté runtime.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("getyesCockpit", {
  listProspects: () => ipcRenderer.invoke("prospects:list"),
  openNewProspect: () => ipcRenderer.send("prospects:new"),
  selectProspect: (id, label) =>
    ipcRenderer.send("prospect:selected", { id, label }),
  // Bouton « Réglages du copilote » du cockpit → ouvre Paramètres (onglet Copilote).
  openSettings: () => ipcRenderer.send("cockpit:openSettings"),
});
