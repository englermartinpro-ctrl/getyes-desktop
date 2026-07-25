// -----------------------------------------------------------------------------
// Runtime manager — le "launcher" GetYes (remplace GETYES.bat / GETYES_STOP.bat)
// -----------------------------------------------------------------------------
// Démarre / arrête le runtime de closing et pipe ses logs. Deux modes :
//   mock : faux serveur WS Node (dev/mock-runtime.js) — zéro dépendance, sert à
//          développer l'overlay sans le brain. C'est le défaut aujourd'hui.
//   real : le vrai runtime Python d'Eliott (closepilot_ui_server.py + oreille).
// Tout est paramétrable par variables d'env — AUCUN chemin en dur (le GETYES.bat
// d'Eliott pointait « c:\Users\Eliot\ClosePilot », impossible à distribuer).
// -----------------------------------------------------------------------------

const { spawn } = require("child_process");
const path = require("path");

// Variables d'env du brain (cf. HANDOFF §7 d'Eliott). Les CLÉS API ne sont
// JAMAIS ici : elles vivent dans le supabase/.env du runtime, hors de l'app.
const BRAIN_ENV = {
  SPEAKER_SLIM: "1",
  SPEAKER_SLIM_MODEL: "claude-haiku-4-5-20251001",
  EMBED_PROVIDER: "gemini",
  BEST_OF_3: "1",
  AUTO_ARSENAL: "1",
};

function config() {
  return {
    // mock tant que le vrai runtime d'Eliott n'est pas configuré sur la machine.
    mode: process.env.GETYES_RUNTIME_MODE || "mock",
    runtimeDir: process.env.GETYES_RUNTIME_DIR || "", // dossier du runtime (real)
    python: process.env.GETYES_PYTHON || "python", // exécutable Python (real)
  };
}

let procs = [];
let onLog = () => {};

function pipe(proc, tag) {
  proc.stdout?.on("data", (d) => onLog(`[${tag}] ${d.toString().trimEnd()}`));
  proc.stderr?.on("data", (d) => onLog(`[${tag}] ${d.toString().trimEnd()}`));
  proc.on("error", (e) => onLog(`[${tag}] ERREUR spawn : ${e.message}`));
  proc.on("exit", (code) => onLog(`[${tag}] terminé (code ${code})`));
}

function start() {
  if (procs.length) return { ok: true, already: true, mode: config().mode };
  const cfg = config();

  if (cfg.mode === "mock") {
    // Faux runtime lancé via le Node embarqué d'Electron (ELECTRON_RUN_AS_NODE) →
    // aucun Node système requis. Teste quand même le vrai chemin de spawn.
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
  const env = { ...process.env, ...BRAIN_ENV };
  // 1) Cerveau + hub WebSocket (ws://127.0.0.1:8765).
  const brain = spawn(cfg.python, ["-u", "closepilot_ui_server.py"], {
    cwd: cfg.runtimeDir,
    env,
    windowsHide: true,
  });
  pipe(brain, "cerveau");
  procs.push(brain);
  // 2) Oreille : capture loopback (voix du prospect) + Whisper local.
  const ear = spawn(cfg.python, ["-u", "_ecoute_on.py"], {
    cwd: cfg.runtimeDir,
    env,
    windowsHide: true,
  });
  pipe(ear, "oreille");
  procs.push(ear);
  return { ok: true, mode: "real" };
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
