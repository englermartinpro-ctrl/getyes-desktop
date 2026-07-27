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
// --bg = EXACTEMENT le fond de la zone de contenu du SaaS (bg-bg : #08090A
// sombre / #F1F1F3 clair) → le cockpit a le même noir/blanc que la page, zéro
// écart. Couleur SOLIDE (pas transparent) : rendu 100 % prévisible.
const VARS_DARK =
  "--bg:#08090A;--panel:#101012;--fg:#E3E4E6;--muted:#8A8F98;--faint:rgba(138,143,152,.55);--line:#26262B;--btn-fg:#08090A;";
const VARS_LIGHT =
  "--bg:#F1F1F3;--panel:#FFFFFF;--fg:#171717;--muted:#666666;--faint:rgba(102,102,102,.5);--line:#DEDEE1;--btn-fg:#F1F1F3;";

const COCKPIT_CSS =
  `:root{${VARS_DARK}}` + // défaut sombre
  `:root.gy-light{${VARS_LIGHT}}` + // basculé en clair
  "html,body{overflow-x:hidden!important;overflow-y:auto!important}" +
  ".hero{display:none!important}" +
  ".launcher{justify-content:center!important}" +
  ".action{zoom:1.1!important;justify-content:flex-start!important;" +
  "gap:16px!important;padding:26px 44px!important;max-width:680px!important;" +
  "flex:0 1 780px!important}" +
  // Panneau dépliable retiré + engrenage d'Eliott et lien débrief masqués. La
  // barre du bas RESTE : on y injecte un bouton « Réglages du copilote » qui
  // renvoie aux Paramètres (les réglages y vivent maintenant).
  ".settings{display:none!important}" +
  ".bottom-bar .hint{display:none!important}" +
  "#gearBtn{display:none!important}";

// Bouton « Réglages du copilote » (STRUCTURE demandée) : un LIEN vers les
// Paramètres (onglet Copilote), pas un dépliable. Injecté dans la barre du bas.
const SETTINGS_LINK_JS = `(function(){
  if (document.getElementById('gyOpenSettings')) return;
  var bar = document.querySelector('.bottom-bar');
  if (!bar || !window.getyesCockpit) return;
  var b = document.createElement('button');
  b.id = 'gyOpenSettings'; b.type = 'button';
  b.textContent = '\\u2699 R\\u00e9glages du copilote';
  b.style.cssText = 'background:none;border:none;color:var(--muted);font:inherit;font-size:13px;text-decoration:underline;text-underline-offset:2px;cursor:pointer;padding:0;';
  b.addEventListener('mouseenter', function(){ b.style.color='var(--fg)'; });
  b.addEventListener('mouseleave', function(){ b.style.color='var(--muted)'; });
  b.addEventListener('click', function(){ window.getyesCockpit.openSettings(); });
  bar.appendChild(b);
})();`;

// Sélecteur de prospect (STRUCTURE) : remplace le champ texte « Qui vas-tu
// appeler ? » par une liste déroulante des prospects (via le SaaS) + « Nouveau ».
// On garde le textarea d'Eliott CACHÉ et on le pilote (valeur + event change) →
// le mécanisme prospect_note existant part sans rien changer côté runtime. La
// sélection est aussi relayée (selectProspect) pour le futur lien appel→prospect.
const SELECTOR_JS = `(async function(){
  if (document.getElementById('gyProspectSelect')) return;
  var ta = document.getElementById('prospectNotes');
  if (!ta || !ta.parentElement || !window.getyesCockpit) return;
  var sel = document.createElement('select');
  sel.id = 'gyProspectSelect';
  sel.style.cssText = 'width:100%;padding:12px 14px;border-radius:12px;background:var(--panel);color:var(--fg);border:1px solid var(--line);font:inherit;font-size:14px;outline:none;cursor:pointer;';
  var o0 = document.createElement('option'); o0.value=''; o0.textContent='Qui vas-tu appeler ? — choisis un prospect'; sel.appendChild(o0);
  var oNew = document.createElement('option'); oNew.value='__new__'; oNew.textContent='+ Nouveau prospect'; sel.appendChild(oNew);
  try {
    var list = await window.getyesCockpit.listProspects();
    for (var i=0;i<list.length;i++){ var o=document.createElement('option'); o.value=list[i].id; o.textContent=list[i].label; sel.insertBefore(o, oNew); }
  } catch(e){}
  sel.addEventListener('change', function(){
    if (sel.value==='__new__'){ window.getyesCockpit.openNewProspect(); sel.value=''; return; }
    if (sel.value){
      var label = sel.options[sel.selectedIndex].textContent;
      ta.value = 'Prospect : ' + label;
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      window.getyesCockpit.selectProspect(sel.value, label);
    }
  });
  ta.style.display='none';
  ta.parentElement.insertBefore(sel, ta);
})();`;

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
      webPreferences: {
        preload: path.join(__dirname, "cockpit-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    view.setBackgroundColor("#08090A"); // = bg-bg du SaaS (sombre) : même noir
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
      view.webContents.executeJavaScript(SELECTOR_JS).catch(() => {});
      view.webContents.executeJavaScript(SETTINGS_LINK_JS).catch(() => {});
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
