// -----------------------------------------------------------------------------
// Runtime manager — le "launcher" GetYes (remplace GETYES.bat / GETYES_STOP.bat)
// -----------------------------------------------------------------------------
// Démarre / arrête le runtime de closing et pipe ses logs. Deux modes :
//   mock : faux serveur WS Node (dev/mock-runtime.js) — zéro dépendance.
//   real : le vrai runtime Python d'Eliott (closepilot_ui_server.py + oreille).
// Tout est paramétrable par variables d'env — AUCUN chemin en dur.
//   GETYES_RUNTIME_MODE = mock | real          (défaut : mock)
//   GETYES_RUNTIME_DIR  = dossier du runtime (real)
//   GETYES_PYTHON       = python à utiliser (sinon : venv .venv auto-détecté)
//   GETYES_EAR          = loopback | mic        (défaut : loopback = appel réel)
// -----------------------------------------------------------------------------

const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Tue un PID ET tout son arbre de sous-process (le cerveau peut spawn des
// enfants). Sous Windows, p.kill() ne tue QUE le process direct → taskkill /T.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      /* déjà mort */
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* déjà mort */
    }
  }
}

// FILET DE SÉCURITÉ : tue les process runtime identifiés par leur ligne de
// commande — même orphelins d'un crash ou d'un force-close. Le motif décide de
// la portée : TOUT (cerveau + oreille) au démarrage/arrêt, ou l'OREILLE SEULE
// (sans toucher le cerveau) quand on coupe juste l'écoute.
function sweepKillMatching(pattern) {
  if (process.platform !== "win32") return;
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "python.exe" -and ($_.CommandLine -match "${pattern}") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", ps], {
      stdio: "ignore",
      timeout: 6000,
    });
  } catch {
    /* rien à tuer */
  }
}
// Portée TOTALE : garantit qu'aucun composant du runtime ne survit à l'app.
function sweepKill() {
  sweepKillMatching(
    "closepilot_ui_server|_ecoute_on|_test_micro_on|closepilot_live",
  );
}
// Portée OREILLE : coupe l'écoute (et son transcripteur enfant) sans jamais
// atteindre "closepilot_ui_server" — le cerveau reste chaud pour re-écouter.
function sweepKillEar() {
  sweepKillMatching("_ecoute_on|_test_micro_on|closepilot_live");
}

// Env du brain — aligné sur la spec d'Eliott (réponse du 26/07). Les CLÉS API
// ne sont JAMAIS ici : elles vivent dans le supabase/.env du runtime.
const BRAIN_ENV = {
  SPEAKER_SLIM_MODEL: "claude-haiku-4-5-20251001",
  BEST_OF_3: "1",
};

function config() {
  // Dossier du runtime : env, sinon ~/getyes-runtime (le vrai chez Martin ; le
  // packaging le fixera pour la distribution). Aucun chemin en dur avec un nom.
  const runtimeDir =
    process.env.GETYES_RUNTIME_DIR || path.join(os.homedir(), "getyes-runtime");
  // Mode : env, sinon AUTO — real si le runtime est présent sur la machine,
  // mock sinon (dev sans runtime).
  const present = fs.existsSync(
    path.join(runtimeDir, "closepilot_ui_server.py"),
  );
  return {
    mode: process.env.GETYES_RUNTIME_MODE || (present ? "real" : "mock"),
    runtimeDir,
    // Oreille : loopback (voix du prospect, appel réel) ou micro (test solo closer).
    // (08/09) _test_micro_on.py a été rangé dans entrainement/scripts/ côté runtime.
    earScript:
      process.env.GETYES_EAR === "mic"
        ? path.join("entrainement", "scripts", "_test_micro_on.py")
        : "_ecoute_on.py",
  };
}

// Python à utiliser : GETYES_PYTHON s'il est posé, sinon le venv .venv du runtime
// (créé en 3.11), sinon "python" (repli). Évite d'imposer un env à Martin.
function pythonFor(runtimeDir) {
  if (process.env.GETYES_PYTHON) return process.env.GETYES_PYTHON;
  // (08/09) le venv du runtime chez Martin s'appelle .venv311 (Python 3.11 —
  // le python système 3.14 n'a pas les roues psycopg2/faster-whisper) : sans
  // ce candidat, on retombait sur "python" système → crash immédiat du cerveau.
  const noms = [".venv", ".venv311"];
  for (const nom of noms) {
    const venv =
      process.platform === "win32"
        ? path.join(runtimeDir, nom, "Scripts", "python.exe")
        : path.join(runtimeDir, nom, "bin", "python");
    if (fs.existsSync(venv)) return venv;
  }
  return "python";
}

// Pose le closer_id dans getyes_settings.json AVANT de démarrer le brain : il le
// lit au boot pour charger la fiche de vente du bon compte (offers/closer_profile,
// cf. Eliott §1.4). Merge non destructif (préserve les autres réglages).
function writeCloserSettings(runtimeDir, closerId) {
  writeSettingsDans(runtimeDir, { closer_id: closerId });
}

// 🧾 (09/09, pont P1) écriture GÉNÉRALE de réglages (merge non destructif) —
// sert aussi à poser secondes_restantes (quota du mois) avant chaque écoute.
function writeSettingsDans(runtimeDir, patch) {
  const file = path.join(runtimeDir, "getyes_settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    settings = {}; // absent ou invalide → repart propre
  }
  Object.assign(settings, patch);
  try {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    onLog(`[manager] réglages posés : ${Object.keys(patch).join(", ")}`);
  } catch (e) {
    onLog(`[manager] échec écriture getyes_settings.json : ${e.message}`);
  }
}

const writeSettings = (patch) => writeSettingsDans(config().runtimeDir, patch);

// Réglages du copilote (getyes_settings.json) lus/écrits depuis les Paramètres
// du SaaS. Mêmes clés qu'Eliott (theme, bg, ear_mode, ear_sensitivity…). Le
// runtime lit ce fichier au démarrage de l'oreille ; l'écriture à chaud est
// relayée en plus via le pont WS (set_setting) côté main.
function settingsFile() {
  return path.join(config().runtimeDir, "getyes_settings.json");
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeSetting(key, value) {
  const s = readSettings();
  s[key] = value;
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
    return true;
  } catch {
    return false;
  }
}

let procs = [];
let onLog = () => {};

function pipe(proc, tag) {
  proc.stdout?.on("data", (d) => onLog(`[${tag}] ${d.toString().trimEnd()}`));
  proc.stderr?.on("data", (d) => onLog(`[${tag}] ${d.toString().trimEnd()}`));
  proc.on("error", (e) => onLog(`[${tag}] ERREUR spawn : ${e.message}`));
  proc.on("exit", (code) => onLog(`[${tag}] terminé (code ${code})`));
}

// opts.closerId : id du closer (posé au login par l'app) → fiche de vente.
function start(opts = {}) {
  if (procs.length) return { ok: true, already: true, mode: config().mode };
  const cfg = config();

  if (cfg.mode === "mock") {
    // Faux runtime via le Node embarqué d'Electron (ELECTRON_RUN_AS_NODE).
    const mock = spawn(
      process.execPath,
      [path.join(__dirname, "..", "dev", "mock-runtime.js")],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true },
    );
    pipe(mock, "mock");
    procs.push(mock);
    return { ok: true, mode: "mock" };
  }

  // ── Mode RÉEL : runtime Python d'Eliott ────────────────────────────────────
  if (!cfg.runtimeDir) {
    const error =
      "GETYES_RUNTIME_DIR non défini : impossible de trouver le runtime Python.";
    onLog(`[manager] ${error}`);
    return { ok: false, error };
  }
  const py = pythonFor(cfg.runtimeDir);
  if (opts.closerId) writeCloserSettings(cfg.runtimeDir, opts.closerId);
  // 🧾 (09/09, pont P1) solde du mois → le runtime gère avertissements/coupure.
  if (Number.isFinite(opts.secondesRestantes)) {
    writeSettingsDans(cfg.runtimeDir, { secondes_restantes: opts.secondesRestantes });
  }

  const env = { ...process.env, ...BRAIN_ENV };
  // 1) Cerveau + hub WebSocket (ws://127.0.0.1:8765). AUCUN audio ici.
  const brain = spawn(py, ["-u", "closepilot_ui_server.py"], {
    cwd: cfg.runtimeDir,
    env,
    windowsHide: true,
  });
  pipe(brain, "cerveau");
  procs.push(brain);
  // 2) Oreille : SEULEMENT si on veut écouter tout de suite. En brainOnly (ouverture
  //    du cockpit), on NE démarre PAS l'oreille → zéro écoute tant que LE bouton
  //    n'est pas cliqué (startEar appelé à ce moment-là).
  if (!opts.brainOnly) startEar();
  return { ok: true, mode: "real", python: py };
}

// Démarre l'OREILLE (l'écoute) — séparément du cerveau, pour ne capter l'audio
// qu'au moment où l'utilisateur active l'outil (LE bouton du cockpit).
function startEar() {
  const cfg = config();
  if (cfg.mode !== "real" || !cfg.runtimeDir) return;
  if (procs.some((p) => p._gyEar)) return; // déjà en route
  const ear = spawn(pythonFor(cfg.runtimeDir), ["-u", cfg.earScript], {
    cwd: cfg.runtimeDir,
    env: { ...process.env, ...BRAIN_ENV },
    windowsHide: true,
  });
  ear._gyEar = true;
  pipe(ear, "oreille");
  procs.push(ear);
}

// Coupe l'OREILLE seule (fin d'appel / pause) : tue le(s) process _gyEar et leur
// arbre, laisse le cerveau tourner. Idempotent (rien à couper = no-op).
function stopEar() {
  const keep = [];
  for (const p of procs) {
    if (p._gyEar) {
      killTree(p.pid);
      try {
        p.kill();
      } catch {
        /* déjà mort */
      }
    } else {
      keep.push(p);
    }
  }
  procs = keep;
  sweepKillEar(); // filet ciblé : aucune oreille orpheline, cerveau intact
}

function stop() {
  for (const p of procs) {
    killTree(p.pid); // tue le process ET tout son arbre
    try {
      p.kill();
    } catch {
      /* déjà mort */
    }
  }
  procs = [];
  sweepKill(); // filet : aucun orphelin ne survit
}

const isRunning = () => procs.length > 0;
// L'oreille (écoute) tourne-t-elle ? (≠ cerveau seul) — pilote l'UI/la tray.
const earRunning = () => procs.some((p) => p._gyEar);
const setLogHandler = (fn) => {
  onLog = typeof fn === "function" ? fn : () => {};
};

module.exports = {
  start,
  stop,
  startEar,
  stopEar,
  isRunning,
  earRunning,
  setLogHandler,
  writeSettings,
  config,
  sweepKill,
  readSettings,
  writeSetting,
};
