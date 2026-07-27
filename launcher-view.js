// -----------------------------------------------------------------------------
// Vue « cockpit » — le VRAI launcher d'Eliott, intégré au SaaS
// -----------------------------------------------------------------------------
// closepilot_ui/src/launcher.html est un fichier LOCAL. On l'affiche NON MODIFIÉ
// (il garde 100 % de ses fonctions + sa connexion WS passe la garde d'Eliott, car
// origine file://) dans une WebContentsView posée par-dessus la ZONE DE CONTENU de
// la page Copilote — le menu GetYes reste autour. Le SaaS indique la région exacte
// (IPC launcher:show / bounds / hide).
//
// Deux soins, SANS toucher aux fichiers d'Eliott (tout par injection) :
//  1) ANTI-FLASH : fond sombre + on n'ATTACHE la vue qu'une fois PEINTE — plus de
//     flashbang blanc ni de contenu brut avant le style.
//  2) INTÉGRATION : la palette dark du SaaS est réinjectée (le cockpit se fond dans
//     son conteneur bg-surface au lieu de flotter comme une page à part), la colonne
//     identité et la ligne « débrief getyes.app » (inopérante) sont masquées, et le
//     zoom 1.28 qui coupait le bas est neutralisé (centrage « safe » + scroll de
//     secours → plus rien n'est rogné).
// -----------------------------------------------------------------------------
const { WebContentsView, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let view = null;
let mainWindow = null;
let launcherFile = null;
let attached = false;
let lastBounds = { x: 0, y: 0, width: 0, height: 0 };

// = bg-surface du SaaS (thème sombre) : le fond de la vue ET du cockpit.
const SURFACE = "#101012";

const COCKPIT_CSS =
  // Palette dark du SaaS (surface / surface-hover / texte / bordure) → cohérence.
  ":root{" +
  "--bg:#101012;--panel:#17171A;--fg:#E3E4E6;" +
  "--muted:#8A8F98;--faint:rgba(138,143,152,.55);--line:#26262B;" +
  "}" +
  // Jamais de rognage : on laisse défiler si ça déborde (petites fenêtres).
  "html,body{overflow-x:hidden!important;overflow-y:auto!important}" +
  // Colonne identité masquée (logo/abo/conseil/liens = déjà dans le SaaS).
  ".hero{display:none!important}" +
  ".launcher{justify-content:center!important}" +
  // Action centrée, zoom 1.28 → 1.1 (le 1.28 débordait), centrage SAFE (bascule
  // en haut si trop grand → le bas n'est plus coupé), respiration resserrée.
  // Ancrage HAUT (pas centré) : ouvrir les réglages fait défiler vers le bas
  // sans jamais pousser/couper le bouton. Zoom 1.28 → 1.1 (le 1.28 débordait).
  ".action{zoom:1.1!important;justify-content:flex-start!important;" +
  "gap:16px!important;padding:26px 44px!important;max-width:680px!important;" +
  "flex:0 1 780px!important}" +
  // Le panneau réglages défile dans SA boîte → n'allonge plus toute la colonne.
  ".settings{max-height:46vh!important;overflow-y:auto!important}" +
  // « débrief complet de chaque appel → ton espace getyes.app » : retiré (inopérant).
  ".bottom-bar .hint{display:none!important}";

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

// Attache la vue à la fenêtre (une fois seulement) et la cale sur la région.
function attach() {
  if (!view || !mainWindow) return;
  if (!attached) {
    mainWindow.contentView.addChildView(view);
    attached = true;
  }
  view.setBounds(lastBounds);
}

// Affiche le cockpit à la région donnée (le crée à la 1re fois).
function show(bounds) {
  if (!mainWindow || !launcherFile || !fs.existsSync(launcherFile)) return false;
  lastBounds = round(bounds);
  if (!view) {
    view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // Fond sombre = surface du SaaS : la vue n'affiche JAMAIS de blanc avant le
    // 1er paint (fin du flashbang) et se confond avec son conteneur.
    view.setBackgroundColor(SURFACE);
    view.webContents.loadFile(launcherFile);
    // Liens getyes.app (stats / compte / débrief) → navigateur système.
    view.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    // On n'ATTACHE qu'une fois le contenu PEINT + le style d'intégration appliqué
    // → aucun flash de contenu brut ni de thème par défaut.
    view.webContents.once("did-finish-load", () => {
      if (!view) return;
      view.webContents.insertCSS(COCKPIT_CSS).catch(() => {});
      attach();
    });
  } else {
    attach();
  }
  return true;
}

function setBounds(bounds) {
  lastBounds = round(bounds);
  if (view && attached) view.setBounds(lastBounds);
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

module.exports = { init, show, setBounds, hide, isVisible };
