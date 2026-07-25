// GetYes Desktop — processus principal Electron (v0.1)
// -----------------------------------------------------------------------------
// Rôle de cette v0.1 : ouvrir UNE fenêtre native qui embarque le SaaS GetYes,
// avec la session gardée entre les lancements (comme l'app Claude). Le lancement
// du runtime Python (le brain) + l'overlay flottant + le handshake d'auth
// viendront dans les étapes suivantes (2, 3, 4).
//
// La session par défaut d'Electron est DÉJÀ persistée sur disque → l'utilisateur
// reste connecté d'un lancement à l'autre. Rien de spécial à faire pour ça.

const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

// L'app desktop ouvre LE PRODUIT (le SaaS après connexion), PAS la landing
// marketing. On charge donc /dashboard : si l'utilisateur est déjà connecté
// (session gardée) il arrive direct dans l'app ; sinon la middleware du SaaS le
// redirige vers /login. La landing (/) reste réservée au web.
// En dev : GETYES_URL=http://localhost:3000/dashboard npm start
const SAAS_URL = process.env.GETYES_URL || "https://www.getyes.app/dashboard";

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "GetYes",
    icon: path.join(__dirname, "assets", "app-icon-v3.ico"), // logo (fenêtre + barre des tâches, .ico = mieux géré par Windows)
    backgroundColor: "#000000", // évite le flash blanc pendant le chargement
    autoHideMenuBar: true, // pas de barre de menu visible (look app)
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // le SaaS ne voit PAS Node — sécurité
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(SAAS_URL);

  // Garde le titre de fenêtre « GetYes » (sinon il prend le <title> marketing
  // de la page « …L'IA qui obtient le oui »). Plus « app », moins « site ».
  mainWindow.on("page-title-updated", (e) => e.preventDefault());

  // Liens externes (Stripe, docs, et surtout l'OAuth Google — qui REFUSE de
  // s'ouvrir dans une webview embarquée) → navigateur système, pas la fenêtre.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // F12 = devtools (phase de dev uniquement).
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12") mainWindow.webContents.toggleDevTools();
  });
}

app.whenReady().then(() => {
  // Identité Windows de l'app : regroupe la fenêtre sous NOTRE icône dans la
  // barre des tâches (au lieu de celle d'Electron par défaut).
  app.setAppUserModelId("com.getyes.app");
  Menu.setApplicationMenu(null); // retire le menu File/Edit natif (look app propre)
  createWindow();

  app.on("activate", () => {
    // macOS : recrée une fenêtre au clic sur le dock si tout est fermé.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Windows/Linux : quitter quand toutes les fenêtres sont fermées.
  if (process.platform !== "darwin") app.quit();
});
