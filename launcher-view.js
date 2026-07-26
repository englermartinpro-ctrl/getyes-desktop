// -----------------------------------------------------------------------------
// Vue « cockpit » — affiche le VRAI launcher d'Eliott
// -----------------------------------------------------------------------------
// closepilot_ui/src/launcher.html est un fichier LOCAL. On l'affiche NON MODIFIÉ
// (donc il garde 100 % de ses fonctions + sa connexion WS passe la garde
// d'Eliott, car origine file://) dans une WebContentsView posée par-dessus la
// ZONE DE CONTENU de la page Copilote — le menu GetYes reste autour. Le SaaS
// indique la région exacte (IPC launcher:show / bounds / hide).
// -----------------------------------------------------------------------------
const { WebContentsView, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let view = null;
let mainWindow = null;
let launcherFile = null;

function init(win, runtimeDir) {
  mainWindow = win;
  launcherFile = path.join(runtimeDir, "closepilot_ui", "src", "launcher.html");
}

function round(b) {
  return {
    x: Math.round(b.x || 0),
    y: Math.round(b.y || 0),
    width: Math.round(b.width || 0),
    height: Math.round(b.height || 0),
  };
}

// Affiche le cockpit à la région donnée (le crée à la 1re fois).
function show(bounds) {
  if (!mainWindow || !launcherFile || !fs.existsSync(launcherFile)) return false;
  if (!view) {
    view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    view.webContents.loadFile(launcherFile);
    // Restyle DANS la vue (sans modifier le fichier d'Eliott) : on masque la
    // colonne identité (logo / abonnement / conseil / nouveau — redondante avec
    // le SaaS) et on centre la colonne ACTION en plein écran.
    view.webContents.on("did-finish-load", () => {
      view.webContents
        .insertCSS(
          ".hero{display:none!important}" +
            ".launcher{justify-content:center!important}" +
            ".action{flex:0 1 780px!important;max-width:100%!important}",
        )
        .catch(() => {});
    });
    // Liens getyes.app (stats / compte / débrief) → navigateur système.
    view.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.contentView.addChildView(view);
  }
  view.setBounds(round(bounds));
  return true;
}

function setBounds(bounds) {
  if (view) view.setBounds(round(bounds));
}

function hide() {
  if (view && mainWindow) {
    try {
      mainWindow.contentView.removeChildView(view);
      view.webContents.close();
    } catch {
      /* déjà retirée */
    }
    view = null;
  }
}

const isVisible = () => view !== null;

module.exports = { init, show, setBounds, hide, isVisible };
