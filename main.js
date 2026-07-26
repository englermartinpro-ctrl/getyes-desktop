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
  dialog,
  Tray,
} = require("electron");
const path = require("path");
const fs = require("fs");
const runtime = require("./runtime/manager");
const { autoUpdater } = require("electron-updater");
const WebSocket = require("ws");

// L'app ouvre LE PRODUIT (SaaS après connexion), PAS la landing. /dashboard →
// app si connecté, sinon /login. En dev : GETYES_URL=http://localhost:3000/dashboard
const SAAS_URL = process.env.GETYES_URL || "https://www.getyes.app/dashboard";
const SAAS_ORIGIN = new URL(SAAS_URL).origin;
// Marqueur ajouté au User-Agent : le SaaS détecte le desktop (→ OAuth via
// navigateur + redirect getyes://) sans rien deviner.
const UA_MARKER = "GetYesDesktop/0.1";

let mainWindow;
let overlayWindow;
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
    backgroundColor: "#000000", // évite le flash blanc au chargement
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
}

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
    x: Math.round((width - 560) / 2),
    y: 24,
    frame: false,
    transparent: true,
    resizable: false,
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
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
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
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
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
      try {
        if (JSON.parse(raw.toString()).type === "ready") setCopilotState("ready");
      } catch {
        /* trame non-JSON ignorée */
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

    // Runtime : logs en console + raccourci global de bascule du copilote +
    // IPC (bouton masquer overlay, et start/stop pilotables plus tard par le SaaS).
    runtime.setLogHandler((line) => console.log(line));
    globalShortcut.register("CommandOrControl+Shift+G", toggleCopilot);
    ipcMain.on("overlay:hide", () => overlayWindow?.hide());
    ipcMain.handle("copilot:start", () => startCopilot());
    ipcMain.handle("copilot:stop", () => stopCopilot());
    ipcMain.handle("copilot:toggle", () => toggleCopilot());
    ipcMain.handle("copilot:isRunning", () => runtime.isRunning());
    ipcMain.handle("copilot:state", () => copilotState);

    // Mises à jour automatiques (app packagée uniquement) : vérifie le flux de
    // versions, télécharge en arrière-plan, installe au prochain redémarrage —
    // zéro réinstallation (comme Claude). Le flux est défini dans package.json
    // (champ "publish"). En dev, pas de flux → on ne l'appelle pas.
    if (app.isPackaged) {
      autoUpdater.on("update-downloaded", async () => {
        // Comme Claude : l'app tourne encore sur l'ancienne version → on propose
        // de la RELANCER pour appliquer la MAJ (sinon : au prochain démarrage).
        const { response } = await dialog.showMessageBox({
          type: "info",
          buttons: ["Relancer maintenant", "Plus tard"],
          defaultId: 0,
          cancelId: 1,
          title: "GetYes — mise à jour prête",
          message: "Une nouvelle version de GetYes est prête.",
          detail:
            "Relance l'app pour l'appliquer (quelques secondes). Sinon, elle s'installera au prochain démarrage.",
        });
        if (response === 0) autoUpdater.quitAndInstall();
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
    runtime.stop(); // ne jamais laisser un process runtime orphelin
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
