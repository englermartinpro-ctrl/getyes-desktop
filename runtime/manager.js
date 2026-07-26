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

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Env du brain — aligné sur la spec d'Eliott (réponse du 26/07). Les CLÉS API
// ne sont JAMAIS ici : elles vivent dans le supabase/.env du runtime.
const BRAIN_ENV = {
  SPEAKER_SLIM_MODEL: "claude-haiku-4-5-20251001",
  BEST_OF_3: "1",
};

function config() {
  return {
    mode: process.env.GETYES_RUNTIME_MODE || "mock",
    runtimeDir: process.env.GETYES_RUNTIME_DIR || "",
    // Oreille : loopback (voix du prospect, appel réel) ou micro (test solo closer).
    earScript:
      process.env.GETYES_EAR === "mic" ? "_test_micro_on.py" : "_ecoute_on.py",
  };
}

// Python à utiliser : GETYES_PYTHON s'il est posé, sinon le venv .venv du runtime
// (créé en 3.11), sinon "python" (repli). Évite d'imposer un env à Martin.
function pythonFor(runtimeDir) {
  if (process.env.GETYES_PYTHON) return process.env.GETYES_PYTHON;
  const venv =
    process.platform === "win32"
      ? path.join(runtimeDir, ".venv", "Scripts", "python.exe")
      : path.join(runtimeDir, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python";
}

// Pose le closer_id dans getyes_settings.json AVANT de démarrer le brain : il le
// lit au boot pour charger la fiche de vente du bon compte (offers/closer_profile,
// cf. Eliott §1.4). Merge non destructif (préserve les autres réglages).
function writeCloserSettings(runtimeDir, closerId) {
  const file = path.join(runtimeDir, "getyes_settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    settings = {}; // absent ou invalide → repart propre
  }
  settings.closer_id = closerId;
  try {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    onLog("[manager] closer_id posé dans getyes_settings.json");
  } catch (e) {
    onLog(`[manager] échec écriture getyes_settings.json : ${e.message}`);
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

  const env = { ...process.env, ...BRAIN_ENV };
  // 1) Cerveau + hub WebSocket (ws://127.0.0.1:8765).
  const brain = spawn(py, ["-u", "closepilot_ui_server.py"], {
    cwd: cfg.runtimeDir,
    env,
    windowsHide: true,
  });
  pipe(brain, "cerveau");
  procs.push(brain);
  // 2) Oreille : loopback (voix prospect) ou micro (test solo).
  const ear = spawn(py, ["-u", cfg.earScript], {
    cwd: cfg.runtimeDir,
    env,
    windowsHide: true,
  });
  pipe(ear, "oreille");
  procs.push(ear);
  return { ok: true, mode: "real", python: py, ear: cfg.earScript };
}

function stop() {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* déjà mort */
    }
  }
  procs = [];
}

const isRunning = () => procs.length > 0;
const setLogHandler = (fn) => {
  onLog = typeof fn === "function" ? fn : () => {};
};

module.exports = { start, stop, isRunning, setLogHandler, config };
