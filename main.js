// GetYes Desktop — processus principal Electron
// -----------------------------------------------------------------------------
// Fenêtre native qui embarque le SaaS GetYes (session persistée). Gère aussi le
// flux OAuth Google : Google REFUSE l'auth dans une webview embarquée, donc on
// l'ouvre dans le navigateur système et on récupère la session via le protocole
// getyes:// (deep-link). Le lancement du runtime Python viendra en v0.2.

const {
  app,
  BrowserWindow,
  Menu,
  shell,
  screen,
  globalShortcut,
  ipcMain,
  net,
  Notification,
  Tray,
} = require("electron");
const path = require("path");
const fs = require("fs");
const runtime = require("./runtime/manager");
const { autoUpdater } = require("electron-updater");
const WebSocket = require("ws");
const launcherView = require("./launcher-view");

// L'app ouvre LE PRODUIT (SaaS après connexion), PAS la landing. /dashboard →
// app si connecté, sinon /login. En dev : GETYES_URL=http://localhost:3000/dashboard
const SAAS_URL = process.env.GETYES_URL || "https://www.getyes.app/dashboard";
const SAAS_ORIGIN = new URL(SAAS_URL).origin;
// Marqueur ajouté au User-Agent : le SaaS détecte le desktop (→ OAuth via
// navigateur + redirect getyes://) sans rien deviner.
const UA_MARKER = "GetYesDesktop/0.1";

let mainWindow;
let overlayWindow;
let updateWindow = null;
let quittingForUpdate = false;
let tray;
let copilotState = "off"; // off | starting | ready — relu par le SaaS
let bridgeWs = null;
let bridgeTimer = null;

// Retour OAuth : getyes://auth-callback?code=... → on recharge /auth/callback
// DANS la fenêtre (là où vit le code_verifier PKCE posé au clic « Google »),
// qui échange le code contre la session puis redirige vers le dashboard.
function handleDeepLink(url) {
  if (!url || !url.startsWith("getyes://") || !mainWindow) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const err = parsed.searchParams.get("error");
  const code = parsed.searchParams.get("code");
  if (err) {
    mainWindow.loadURL(
      `${SAAS_ORIGIN}/login?error=${encodeURIComponent("Connexion annulée. Réessaie.")}`,
    );
  } else if (code) {
    mainWindow.loadURL(
      `${SAAS_ORIGIN}/auth/callback?code=${encodeURIComponent(code)}`,
    );
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "GetYes",
    icon: path.join(__dirname, "assets", "app-icon-v3.ico"),
    backgroundColor: "#000000", // fond noir sous le rendu web (2e filet)
    show: false, // ← ANTI-FLASH : on n'affiche qu'au 1er rendu prêt (ci-dessous)
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Flash blanc au lancement (Windows) : la fenêtre NATIVE s'affiche blanche ~1
  // frame avant que le moteur web ne peigne — backgroundColor seul ne le masque
  // pas. On garde la fenêtre CACHÉE jusqu'à "ready-to-show" : à ce moment le 1er
  // rendu du SaaS est déjà peint (voile noir gy-splash-pending → splash vidéo),
  // donc on révèle du NOIR, jamais du blanc. Filet : on affiche quand même après
  // 10 s si le rendu tarde (réseau) — ne jamais laisser l'app invisible.
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }, 10000);
  mainWindow.once("ready-to-show", () => {
    clearTimeout(showFallback);
    mainWindow.show();
  });

  // UA marqueur AVANT le premier load (le SaaS le lit dès /login).
  mainWindow.webContents.setUserAgent(
    `${mainWindow.webContents.getUserAgent()} ${UA_MARKER}`,
  );

  mainWindow.loadURL(SAAS_URL);

  // Titre figé « GetYes » (sinon il prend le <title> marketing de la page).
  mainWindow.on("page-title-updated", (e) => e.preventDefault());

  // Fenêtres popup (target=_blank, Stripe…) → navigateur système.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // OAuth Google : la navigation top-level vers l'écran d'autorisation Supabase/
  // Google est détournée vers le navigateur système (Google bloque la webview).
  // Le retour arrive via getyes:// (handleDeepLink). Les autres navigations
  // (getyes.app/…, /auth/callback) passent normalement.
  const detourneOAuth = (event, url) => {
    if (
      url.includes("/auth/v1/authorize") ||
      url.startsWith("https://accounts.google.com")
    ) {
      event.preventDefault();
      shell.openExternal(url);
    }
  };
  mainWindow.webContents.on("will-navigate", detourneOAuth);
  mainWindow.webContents.on("will-redirect", detourneOAuth);

  // F12 = devtools ; Ctrl/Cmd+R = recharger (le menu est masqué → sinon aucun
  // raccourci de rechargement dispo).
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12") mainWindow.webContents.toggleDevTools();
    if ((input.control || input.meta) && input.key.toLowerCase() === "r") {
      mainWindow.webContents.reload();
    }
  });

  // Fermeture de la fenêtre : SANS appel actif (oreille éteinte), on QUITTE
  // VRAIMENT. Crucial : sinon une fenêtre cachée (overlay) garde l'app vivante
  // dans la zone de notification, et après une MAJ le verrou d'instance unique
  // relance l'ANCIENNE au lieu de la neuve. Appel en cours → l'app reste vive
  // (overlay + tray pilotent l'arrêt) ; la tray peut rouvrir la fenêtre.
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!quittingForUpdate && !runtime.earRunning()) app.quit();
  });
}

// Ouvre (ou recrée) la fenêtre principale — appelée par la tray, y compris si la
// fenêtre a été fermée pendant un appel (l'app tournait encore en arrière-plan).
function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
    launcherView.init(mainWindow, runtime.config().runtimeDir);
  }
}

// Rend l'overlay déplaçable en réutilisant les zones data-tauri-drag-region
// d'Eliott ; tout ce qui est interactif (boutons, champ, statut, croix) reste
// cliquable (no-drag) et non happé par le glisser-déposer de la fenêtre.
const OVERLAY_DRAG_CSS =
  "[data-tauri-drag-region]{-webkit-app-region:drag}" +
  "button,input,select,textarea,a,#gyEndCall,.status,#listenBtn,.footer-right{-webkit-app-region:no-drag}";

// Croix « terminer l'appel » posée dans le coin de l'overlay. Rouge au survol
// (action franche). Appelle overlayAPI.endCall (preload) → reset_session + stop.
const OVERLAY_CROSS_JS = `(function(){
  if (document.getElementById('gyEndCall')) return;
  var b = document.createElement('button');
  b.id = 'gyEndCall';
  b.type = 'button';
  b.title = "Terminer l'appel — enregistre le bilan";
  b.textContent = '\\u2715';
  b.style.cssText = 'position:fixed;top:7px;right:9px;z-index:2147483647;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.7);font:600 12px/22px system-ui,sans-serif;text-align:center;cursor:pointer;-webkit-app-region:no-drag;app-region:no-drag;';
  b.addEventListener('mouseenter', function(){ b.style.background='rgba(239,68,68,.9)'; b.style.color='#fff'; });
  b.addEventListener('mouseleave', function(){ b.style.background='rgba(255,255,255,.08)'; b.style.color='rgba(255,255,255,.7)'; });
  b.addEventListener('click', function(){ if (window.overlayAPI && window.overlayAPI.endCall) window.overlayAPI.endCall(); });
  document.body.appendChild(b);
})();`;

// ─── Overlay copilote ────────────────────────────────────────────────────────
// Fenêtre flottante, sans cadre, transparente, toujours au-dessus (même sur Zoom).
// Charge l'UI locale en file:// → passe la garde d'origine du serveur d'Eliott
// (file:// autorisé ; une page https serait refusée à la porte). Le rendu se
// connecte à ws://127.0.0.1:8765.
function createOverlayWindow() {
  if (overlayWindow) return overlayWindow;
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width: 560,
    height: 190,
    minWidth: 320,
    minHeight: 110,
    x: Math.round((width - 560) / 2),
    y: 24,
    frame: false,
    transparent: true,
    resizable: true, // taille ajustable (bords) — comme l'overlay Tauri d'Eliott
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "overlay", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver"); // au-dessus du plein écran
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // INDÉTECTABLE en partage d'écran / capture (WDA_EXCLUDEFROMCAPTURE côté Windows) :
  // le prospect ne voit jamais l'overlay en visio. Feature clé qu'Eliott avait posée.
  overlayWindow.setContentProtection(true);
  const cfg = runtime.config();
  const eliottOverlay = path.join(
    cfg.runtimeDir,
    "closepilot_ui",
    "src",
    "index.html",
  );
  if (cfg.mode === "real" && fs.existsSync(eliottOverlay)) {
    // Overlay d'Eliott (choix de Martin), bundlé avec le runtime.
    overlayWindow.loadFile(eliottOverlay);
  } else {
    // Mode mock (dev) : mon overlay + champ de test « simuler le prospect ».
    overlayWindow.loadFile(path.join(__dirname, "overlay", "index.html"), {
      search: "dev=1",
    });
  }
  // Restyle injecté par-dessus l'overlay (sans modifier les fichiers d'Eliott —
  // même principe que le cockpit) : (1) déplaçable partout, en réutilisant SES zones
  // data-tauri-drag-region ; (2) la croix « fin d'appel ». Idempotent.
  overlayWindow.webContents.on("did-finish-load", () => {
    const wc = overlayWindow?.webContents;
    if (!wc) return;
    wc.insertCSS(OVERLAY_DRAG_CSS).catch(() => {});
    wc.executeJavaScript(OVERLAY_CROSS_JS).catch(() => {});
  });
  overlayWindow.on("closed", () => (overlayWindow = null));
  return overlayWindow;
}

// Vérifie CÔTÉ SERVEUR (endpoint SaaS) que l'utilisateur a le droit de lancer le
// runtime — il consomme des ressources IA payantes. Réutilise la session de la
// fenêtre (cookies getyes.app). Renvoie null si le check est injoignable (réseau).
async function checkEntitlement() {
  try {
    const res = await net.fetch(`${SAAS_ORIGIN}/api/desktop/entitlement`, {
      session: mainWindow?.webContents.session,
      cache: "no-store",
    });
    if (!res.ok) return { authenticated: false, canUseRuntime: false };
    return await res.json();
  } catch {
    return null;
  }
}

function notifier(titre, corps) {
  try {
    new Notification({ title: titre, body: corps }).show();
  } catch {
    /* notifications indispo : silencieux */
  }
}

// Met en forme les notes de version pour le dialogue de MAJ. GitHub renvoie soit
// une string (corps de la release, souvent en HTML), soit un tableau
// {version, note}. On nettoie le HTML et on borne (dialogue lisible : 8 lignes /
// 500 caractères max). Vide si aucune note → le dialogue n'affiche que le numéro.
function formatReleaseNotes(raw) {
  if (!raw) return "";
  let text = Array.isArray(raw)
    ? raw.map((r) => (typeof r === "string" ? r : r?.note || "")).join("\n")
    : String(raw);
  text = text
    .replace(/<[^>]+>/g, "") // retire les balises HTML
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .trim();
  const lignes = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);
  text = lignes.join("\n");
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// Notes de la version la plus récente du CHANGELOG.md (1er bloc « ## x.y.z »).
// Sert de repli si la release GitHub n'a pas de corps, ET à prévisualiser le
// pop-up en dev (raccourci Ctrl+Shift+U) sans rien publier.
function readLatestChangelog() {
  try {
    const md = fs.readFileSync(path.join(__dirname, "CHANGELOG.md"), "utf8");
    const m = md.match(/^##\s+.+?\n([\s\S]*?)(?=\n##\s|$)/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// Pop-up de MAJ maison (remplace le dialogue natif, qui ne sait pas déplier) :
// par défaut « Version X.Y.Z prête » + Relancer / Plus tard ; les nouveautés se
// révèlent au clic sur « Nouveautés » (souligné). Se redimensionne au contenu.
function createUpdateWindow(info) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return updateWindow;
  }
  updateWindow = new BrowserWindow({
    width: 420,
    height: 190,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#101012",
    show: false,
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "update", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  updateWindow.loadFile(path.join(__dirname, "update", "dialog.html"));
  updateWindow.once("ready-to-show", () => {
    updateWindow.center();
    updateWindow.show();
  });
  updateWindow.webContents.once("did-finish-load", () => {
    // Notes = corps de la release GitHub, sinon repli sur le CHANGELOG embarqué.
    const notes =
      formatReleaseNotes(info?.releaseNotes) || readLatestChangelog();
    updateWindow.webContents.send("update:info", {
      version: info?.version || app.getVersion(),
      notes,
    });
  });

  const onRelaunch = () => {
    // On QUITTE d'abord tout ce qui garderait l'app vivante (overlay caché) puis
    // on installe en SILENCE avec relance FORCÉE : l'ancienne instance meurt →
    // l'installateur lance bien la NEUVE (plus de reprise de l'ancienne).
    quittingForUpdate = true;
    autoUpdater.quitAndInstall(true, true);
  };
  const onLater = () => updateWindow && !updateWindow.isDestroyed() && updateWindow.close();
  const onResize = (_e, h) => {
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.setContentSize(420, Math.max(120, Math.min(560, Math.round(h || 190))));
    }
  };
  ipcMain.on("update:relaunch", onRelaunch);
  ipcMain.on("update:later", onLater);
  ipcMain.on("update:resize", onResize);
  updateWindow.on("closed", () => {
    ipcMain.removeListener("update:relaunch", onRelaunch);
    ipcMain.removeListener("update:later", onLater);
    ipcMain.removeListener("update:resize", onResize);
    updateWindow = null;
  });
  return updateWindow;
}

// Lance le runtime (mock|real) + affiche l'overlay SANS voler le focus de l'appel,
// APRÈS le gate Auth/abonnement.
async function startCopilot() {
  const cfg = runtime.config();
  const isMock = cfg.mode === "mock";
  // Gate Auth/abonnement : appliqué en mode RÉEL uniquement (le runtime brûle des
  // ressources IA payantes). En mock (dev), rien n'est consommé → pas de gate,
  // pour pouvoir tester l'overlay sans être connecté dans la fenêtre.
  let closerId;
  if (!isMock) {
    const ent = await checkEntitlement();
    if (ent === null) {
      // Check réseau impossible → REFUSÉ (ne jamais lancer pour un non-vérifié).
      notifier("Copilote GetYes", "Service injoignable — réessaie dans un instant.");
      return { ok: false, reason: "unreachable" };
    }
    if (!ent.canUseRuntime) {
      notifier(
        "Copilote GetYes",
        ent.authenticated
          ? "Ton plan n'inclut pas le copilote d'appel."
          : "Connecte-toi pour lancer le copilote.",
      );
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
      return { ok: false, reason: "entitlement" };
    }
    closerId = ent.closerId; // posé dans getyes_settings.json → fiche de vente
  }
  const res = runtime.start({ closerId });
  createOverlayWindow().showInactive();
  startBridge(); // suit l'état du runtime (démarrage → prêt) + met à jour la tray
  return res;
}
function stopCopilot() {
  runtime.stop();
  overlayWindow?.hide();
  stopBridge();
  setCopilotState("off"); // met aussi à jour la tray
}
function toggleCopilot() {
  if (runtime.isRunning() && overlayWindow?.isVisible()) stopCopilot();
  else startCopilot();
}

// ─── Icône barre des tâches — arrêt du copilote TOUJOURS accessible ──────────
function updateTray() {
  if (!tray) return;
  const running = copilotState !== "off";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Ouvrir GetYes",
        click: openMainWindow,
      },
      { type: "separator" },
      {
        label: running ? "⏹  Arrêter le copilote" : "Copilote arrêté",
        enabled: running,
        click: () => stopCopilot(),
      },
      { type: "separator" },
      {
        label: "Quitter GetYes",
        click: () => {
          stopCopilot();
          app.quit();
        },
      },
    ]),
  );
  tray.setToolTip(
    copilotState === "ready"
      ? "GetYes — copilote actif (à l'écoute)"
      : copilotState === "starting"
        ? "GetYes — copilote en démarrage…"
        : "GetYes",
  );
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, "assets", "app-icon-v3.ico"));
  tray.on("click", openMainWindow);
  updateTray();
}

// ─── Pont SaaS ↔ runtime ─────────────────────────────────────────────────────
// La page SaaS (origine web) ne peut pas parler au runtime (garde d'Eliott la
// refuse). C'est donc le PROCESS PRINCIPAL qui se connecte (client Node, sans
// en-tête Origin → autorisé) et suit l'état, que le SaaS relit par IPC.
function setCopilotState(s) {
  copilotState = s;
  updateTray();
}
function startBridge() {
  stopBridge();
  setCopilotState("starting");
  const tryConnect = () => {
    if (copilotState === "off") return;
    const ws = new WebSocket("ws://127.0.0.1:8765");
    ws.on("open", () => {
      bridgeWs = ws;
    });
    ws.on("message", (raw) => {
      let d;
      try {
        d = JSON.parse(raw.toString());
      } catch {
        return; // trame non-JSON ignorée
      }
      if (d.type === "ready") setCopilotState("ready");
      // audio_toggle est diffusé par le serveur quand on bascule l'écoute.
      //  • ON  → on DÉMARRE l'oreille (1re fois) + on affiche l'overlay. Zéro
      //          écoute tant que ce signal n'arrive pas (le cockpit = cerveau seul).
      //  • OFF → PAUSE DOUCE : le pont audio d'Eliott se met en pause tout seul et
      //          GARDE LE FIL (session intacte). On NE tue PAS l'oreille ici — c'est
      //          la CROIX de l'overlay (fin d'appel) qui coupe et fait le bilan.
      if (d.type === "audio_toggle" && d.on) {
        runtime.startEar();
        createOverlayWindow().showInactive();
        setCopilotState("ready");
        updateTray();
      }
    });
    ws.on("close", () => {
      bridgeWs = null;
      if (copilotState !== "off") {
        setCopilotState("starting");
        bridgeTimer = setTimeout(tryConnect, 1500); // le cerveau chauffe ~20 s
      }
    });
    ws.on("error", () => ws.close());
  };
  tryConnect();
}
function stopBridge() {
  clearTimeout(bridgeTimer);
  try {
    bridgeWs?.close();
  } catch {
    /* déjà fermé */
  }
  bridgeWs = null;
}
// Envoie une trame au serveur runtime via le pont (ex. la croix de l'overlay :
// reset_session pour le bilan + audio_toggle off). No-op si le pont est fermé.
function bridgeSend(obj) {
  try {
    if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      bridgeWs.send(JSON.stringify(obj));
      return true;
    }
  } catch {
    /* pont fermé */
  }
  return false;
}

// Instance UNIQUE : indispensable pour le deep-link. Quand le navigateur ouvre
// getyes://…, Windows relance l'app avec l'URL en argument → le verrou renvoie
// cet argument à l'instance déjà vivante (celle qui a la fenêtre + le verifier).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Enregistre getyes:// auprès de l'OS (en dev : exe Electron + dossier app).
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("getyes", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient("getyes");
  }

  // Windows/Linux : le retour getyes://… arrive en argument d'une 2e instance.
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((a) => a.startsWith("getyes://"));
    if (link) handleDeepLink(link);
  });
  // macOS : via open-url.
  app.on("open-url", (_event, url) => handleDeepLink(url));

  app.whenReady().then(() => {
    app.setAppUserModelId("com.getyes.app"); // icône barre des tâches
    runtime.sweepKill(); // tue tout runtime orphelin d'une session précédente
    Menu.setApplicationMenu(null);
    createTray();
    createWindow();
    launcherView.init(mainWindow, runtime.config().runtimeDir);

    // Runtime : logs en console + raccourci global de bascule du copilote +
    // IPC (bouton masquer overlay, et start/stop pilotables plus tard par le SaaS).
    runtime.setLogHandler((line) => console.log(line));
    globalShortcut.register("CommandOrControl+Shift+G", toggleCopilot);
    // Dev seulement : prévisualiser le pop-up de MAJ (avec le vrai CHANGELOG)
    // sans rien publier — pour valider le rendu avant une release.
    if (!app.isPackaged) {
      globalShortcut.register("CommandOrControl+Shift+U", () =>
        createUpdateWindow({ version: app.getVersion() }),
      );
    }
    ipcMain.on("overlay:hide", () => overlayWindow?.hide());
    // Croix de l'overlay = FIN D'APPEL, accessible même hors du SaaS : on enregistre
    // le bilan (reset_session → le serveur analyse l'appel + sauve le débrief, visible
    // sur getyes.app) PUIS on coupe l'écoute et on referme l'overlay. audio_toggle off
    // fait aussi repasser le cockpit en « DÉMARRER » (état synchronisé via l'écho).
    ipcMain.on("overlay:endCall", () => {
      bridgeSend({ type: "reset_session" });
      bridgeSend({ type: "audio_toggle", on: false });
      runtime.stopEar(); // filet direct (idempotent) si le pont hoquette
      overlayWindow?.hide();
      updateTray();
    });
    ipcMain.handle("copilot:start", () => startCopilot());
    ipcMain.handle("copilot:stop", () => stopCopilot());
    ipcMain.handle("copilot:toggle", () => toggleCopilot());
    ipcMain.handle("copilot:isRunning", () => runtime.isRunning());
    ipcMain.handle("copilot:state", () => copilotState);
    // Cockpit d'Eliott intégré dans la page : le SaaS indique la région, on y
    // pose la vue + on démarre le CERVEAU SEUL (zéro écoute tant que LE bouton
    // du cockpit n'est pas cliqué).
    ipcMain.handle("launcher:show", (_e, bounds, theme) => {
      runtime.start({ brainOnly: true });
      // Le pont observe LE bouton (audio_toggle) → oreille + overlay. Démarré une
      // fois : re-naviguer vers Copilote ne le relance pas (garde sur "off").
      if (copilotState === "off") startBridge();
      return launcherView.show(bounds, theme);
    });
    ipcMain.on("launcher:bounds", (_e, bounds) => launcherView.setBounds(bounds));
    ipcMain.on("launcher:setTheme", (_e, theme) => launcherView.setTheme(theme));
    ipcMain.on("launcher:hide", () => launcherView.hide());

    // Mises à jour automatiques (app packagée uniquement) : vérifie le flux de
    // versions, télécharge en arrière-plan, installe au prochain redémarrage —
    // zéro réinstallation (comme Claude). Le flux est défini dans package.json
    // (champ "publish"). En dev, pas de flux → on ne l'appelle pas.
    if (app.isPackaged) {
      autoUpdater.on("update-downloaded", (info) => {
        // SÉCURITÉ ANTI-BOUCLE : si la version « téléchargée » est DÉJÀ celle qui
        // tourne, on ne propose rien. Sinon, en présence d'une install fantôme
        // (2 copies à des chemins différents), on re-proposerait la MAJ à l'infini.
        if (info?.version && info.version === app.getVersion()) {
          console.log(`[updater] déjà en ${info.version} — pas de pop-up`);
          return;
        }
        // Comme Claude : l'app tourne encore sur l'ancienne version → pop-up maison
        // dépliable (Relancer / Plus tard, « Nouveautés » au clic). Sinon la MAJ
        // s'installe au prochain démarrage.
        createUpdateWindow(info);
      });
      autoUpdater.on("error", (e) => console.log("[updater]", e?.message));
      autoUpdater.checkForUpdates();
      setInterval(
        () => autoUpdater.checkForUpdates(),
        6 * 60 * 60 * 1000, // re-vérif toutes les 6 h si l'app reste ouverte
      );
    }

    // Cas où l'app est lancée À FROID par un getyes:// (l'URL est dans argv).
    const initial = process.argv.find((a) => a.startsWith("getyes://"));
    if (initial) handleDeepLink(initial);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    // Ne stopper (taskkill/sweep) que si quelque chose tourne → quit instantané
    // quand l'app était au repos. Le sweep de démarrage rattrape tout orphelin.
    if (runtime.isRunning()) runtime.stop();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
