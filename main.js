// GetYes Desktop — processus principal Electron
// -----------------------------------------------------------------------------
// Fenêtre native qui embarque le SaaS GetYes (session persistée). Gère aussi le
// flux OAuth Google : Google REFUSE l'auth dans une webview embarquée, donc on
// l'ouvre dans le navigateur système et on récupère la session via le protocole
// getyes:// (deep-link). Le lancement du runtime Python viendra en v0.2.

const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

// L'app ouvre LE PRODUIT (SaaS après connexion), PAS la landing. /dashboard →
// app si connecté, sinon /login. En dev : GETYES_URL=http://localhost:3000/dashboard
const SAAS_URL = process.env.GETYES_URL || "https://www.getyes.app/dashboard";
const SAAS_ORIGIN = new URL(SAAS_URL).origin;
// Marqueur ajouté au User-Agent : le SaaS détecte le desktop (→ OAuth via
// navigateur + redirect getyes://) sans rien deviner.
const UA_MARKER = "GetYesDesktop/0.1";

let mainWindow;

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

    // Cas où l'app est lancée À FROID par un getyes:// (l'URL est dans argv).
    const initial = process.argv.find((a) => a.startsWith("getyes://"));
    if (initial) handleDeepLink(initial);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
