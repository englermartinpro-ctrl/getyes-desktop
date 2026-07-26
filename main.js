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
} = require("electron");
const path = require("path");
const runtime = require("./runtime/manager");

// L'app ouvre LE PRODUIT (SaaS après connexion), PAS la landing. /dashboard →
// app si connecté, sinon /login. En dev : GETYES_URL=http://localhost:3000/dashboard
const SAAS_URL = process.env.GETYES_URL || "https://www.getyes.app/dashboard";
const SAAS_ORIGIN = new URL(SAAS_URL).origin;
// Marqueur ajouté au User-Agent : le SaaS détecte le desktop (→ OAuth via
// navigateur + redirect getyes://) sans rien deviner.
const UA_MARKER = "GetYesDesktop/0.1";

let mainWindow;
let overlayWindow;

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

  // F12 = devtools (phase de dev).
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12") mainWindow.webContents.toggleDevTools();
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
  // En mode mock : ?dev=1 → l'overlay affiche le champ « simuler le prospect ».
  const isMock = (process.env.GETYES_RUNTIME_MODE || "mock") === "mock";
  overlayWindow.loadFile(
    path.join(__dirname, "overlay", "index.html"),
    isMock ? { search: "dev=1" } : {},
  );
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
  const isMock = (process.env.GETYES_RUNTIME_MODE || "mock") === "mock";
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
  return res;
}
function stopCopilot() {
  runtime.stop();
  overlayWindow?.hide();
}
function toggleCopilot() {
  if (runtime.isRunning() && overlayWindow?.isVisible()) stopCopilot();
  else startCopilot();
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
    Menu.setApplicationMenu(null);
    createWindow();

    // Runtime : logs en console + raccourci global de bascule du copilote +
    // IPC (bouton masquer overlay, et start/stop pilotables plus tard par le SaaS).
    runtime.setLogHandler((line) => console.log(line));
    globalShortcut.register("CommandOrControl+Shift+G", toggleCopilot);
    ipcMain.on("overlay:hide", () => overlayWindow?.hide());
    ipcMain.handle("copilot:start", () => startCopilot());
    ipcMain.handle("copilot:stop", () => stopCopilot());
    ipcMain.handle("copilot:toggle", () => toggleCopilot());

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
