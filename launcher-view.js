// -----------------------------------------------------------------------------
// Vue « cockpit » — le VRAI launcher d'Eliott, intégré au SaaS
// -----------------------------------------------------------------------------
// closepilot_ui/src/launcher.html affiché NON MODIFIÉ (garde ses fonctions + sa
// connexion WS via origine file://) dans une WebContentsView posée sur la zone de
// contenu de la page Copilote. Tout le style d'intégration passe par injection —
// on ne touche JAMAIS aux fichiers d'Eliott.
//
// Intégration :
//  • Fond = celui de la PAGE SaaS (pas la surface) → plus de « rectangle dans un
//    rectangle » : le cockpit se fond dans la page, les cartes internes (champ,
//    bouton) ressortent en surface.
//  • THEME-AWARE : suit le clair/sombre du SaaS. On injecte les deux palettes et
//    on bascule une classe `gy-light` sur <html> (setTheme).
//  • Anti-flash : fond sombre + on n'attache la vue qu'une fois peinte.
//  • Colonne identité + ligne « débrief getyes.app » masquées ; zoom 1.28→1.1 +
//    ancrage haut (les réglages ne croppent plus le bouton).
// -----------------------------------------------------------------------------
const { WebContentsView, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let view = null;
let mainWindow = null;
let launcherFile = null;
let attached = false;
let lastBounds = { x: 0, y: 0, width: 0, height: 0 };
let lastTheme = "dark";

// Palettes = tokens du SaaS. --bg = TRANSPARENT : le cockpit n'a plus de fond
// propre, c'est la PAGE SaaS (derrière) qui transparaît → zéro écart de couleur
// possible entre les deux fonds, et le thème est suivi automatiquement. --panel
// = surface (cartes internes qui ressortent), --fg/--line = texte/bordures.
const VARS_DARK =
  "--bg:transparent;--panel:#101012;--fg:#E3E4E6;--muted:#8A8F98;--faint:rgba(138,143,152,.55);--line:#26262B;--btn-fg:#08090A;";
const VARS_LIGHT =
  "--bg:transparent;--panel:#FFFFFF;--fg:#171717;--muted:#666666;--faint:rgba(102,102,102,.5);--line:#DEDEE1;--btn-fg:#F1F1F3;";

const COCKPIT_CSS =
  `:root{${VARS_DARK}}` + // défaut sombre
  `:root.gy-light{${VARS_LIGHT}}` + // basculé en clair
  "html,body{overflow-x:hidden!important;overflow-y:auto!important}" +
  ".hero{display:none!important}" +
  ".launcher{justify-content:center!important}" +
  ".action{zoom:1.1!important;justify-content:flex-start!important;" +
  "gap:16px!important;padding:26px 44px!important;max-width:680px!important;" +
  "flex:0 1 780px!important}" +
  // Réglages RETIRÉS du cockpit (ils vivent dans Paramètres → Copilote d'appel) :
  // panneau dépliable + barre du bas (engrenage + lien) masqués.
  ".settings{display:none!important}" +
  ".bottom-bar{display:none!important}";

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

// Applique le thème (bascule la classe gy-light dans la page du cockpit).
function applyTheme(theme) {
  lastTheme = theme === "light" ? "light" : "dark";
  if (!view) return;
  const light = lastTheme === "light";
  view.webContents
    .executeJavaScript(
      `document.documentElement.classList.toggle("gy-light", ${light});`,
    )
    .catch(() => {});
}

function attach() {
  if (!view || !mainWindow) return;
  if (!attached) {
    mainWindow.contentView.addChildView(view);
    attached = true;
  }
  view.setBounds(lastBounds);
}

// Affiche le cockpit à la région donnée (le crée à la 1re fois).
function show(bounds, theme) {
  if (!mainWindow || !launcherFile || !fs.existsSync(launcherFile)) return false;
  lastBounds = round(bounds);
  if (theme) lastTheme = theme === "light" ? "light" : "dark";
  if (!view) {
    view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    view.setBackgroundColor("#00000000"); // TRANSPARENT : la page SaaS transparaît
    view.webContents.loadFile(launcherFile);
    view.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    // On attache seulement une fois peint + style + thème appliqués (pas de flash).
    view.webContents.once("did-finish-load", () => {
      if (!view) return;
      view.webContents.insertCSS(COCKPIT_CSS).catch(() => {});
      applyTheme(lastTheme);
      attach();
    });
  } else {
    applyTheme(lastTheme);
    attach();
  }
  return true;
}

function setBounds(bounds) {
  lastBounds = round(bounds);
  if (view && attached) view.setBounds(lastBounds);
}

function setTheme(theme) {
  applyTheme(theme);
}

// Détache la vue (la garde vivante → ré-affichage instantané, sans re-flash).
function hide() {
  if (view && mainWindow && attached) {
    try {
      mainWindow.contentView.removeChildView(view);
    } catch {
      /* déjà retirée */
    }
    attached = false;
  }
}

const isVisible = () => attached;

module.exports = { init, show, setBounds, setTheme, hide, isVisible };
