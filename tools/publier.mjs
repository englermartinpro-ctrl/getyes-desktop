#!/usr/bin/env node
// PUBLICATION D'UNE VERSION DE L'APP — vérifiée, puis progressive (2026-10-07).
//
// Pourquoi : la 0.2.4 est partie cassée chez TOUS les utilisateurs (paquet
// app.asar corrompu par un journal de build qui grossissait pendant
// l'empaquetage) parce qu'elle n'avait jamais été lancée avant publication.
// Ce script rend la vérification obligatoire et la diffusion progressive :
//
//   node tools/publier.mjs fabriquer          build Windows (journal HORS du dossier de l'app)
//   node tools/publier.mjs verifier           paquet lisible + l'app fabriquée tient 15 s debout
//   node tools/publier.mjs publier --pct 10   vérifie, puis publie pour 10 % des installations
//   node tools/publier.mjs elargir --pct 100  élargit la version en cours (25, 50, 100…)
//
// La diffusion progressive est native d'electron-updater : le champ
// `stagingPercentage` de latest.yml ; chaque installation a un identifiant
// stable et ne reçoit la mise à jour que si elle tombe dans le pourcentage.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RACINE = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PKG = JSON.parse(readFileSync(join(RACINE, "package.json"), "utf8"));
const VERSION = PKG.version;
const DEPOT = `${PKG.build.publish[0].owner}/${PKG.build.publish[0].repo}`;
const DIST = join(RACINE, "dist");
const EXE = join(DIST, `GetYes-Setup-${VERSION}.exe`);
const LATEST = join(DIST, "latest.yml");

// L'éditeur (VS Code) lance ses terminaux avec ELECTRON_RUN_AS_NODE=1 : l'app
// démarrerait en mode Node et « planterait » — faux diagnostic garanti.
const ENV_PROPRE = { ...process.env };
delete ENV_PROPRE.ELECTRON_RUN_AS_NODE;

// Sous Windows on passe par le shell (npx/npm sont des .cmd) : il découpe les arguments
// sur les espaces → « --title GetYes 0.2.6 » cassait la publication (10/10). On les cite.
const SHELL = process.platform === "win32";
const citer = (a) => (SHELL && /\s/.test(a) ? `"${a}"` : a);
const lancer = (cmd, args, opts = {}) =>
  execFileSync(cmd, args.map(citer), { stdio: "inherit", shell: SHELL, env: ENV_PROPRE, ...opts });

function arg(nom, defaut) {
  const i = process.argv.indexOf(nom);
  return i > 0 ? process.argv[i + 1] : defaut;
}

function pourcentage() {
  const p = Number(arg("--pct", "10"));
  if (!Number.isInteger(p) || p < 1 || p > 100) throw new Error("--pct doit être un entier entre 1 et 100");
  return p;
}

function fabriquer() {
  const journal = join(tmpdir(), `getyes-build-${VERSION}.log`);
  console.log(`▶ fabrication ${VERSION} (journal : ${journal})`);
  lancer("npx", ["electron-builder", "--win", "--publish", "never"], { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(EXE) || !existsSync(LATEST)) throw new Error("installeur ou latest.yml absent après le build");
  console.log(`✓ ${EXE}`);
}

async function verifier() {
  // 1) le paquet de l'app se lit et porte la bonne version
  const tmp = mkdtempSync(join(tmpdir(), "getyes-asar-"));
  try {
    lancer("npx", ["--yes", "@electron/asar", "extract", join(DIST, "win-unpacked", "resources", "app.asar"), tmp], { stdio: "ignore" });
    const lu = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
    if (lu.version !== VERSION) throw new Error(`le paquet porte ${lu.version}, attendu ${VERSION}`);
    for (const f of ["main.js", "preload.js", "runtime/manager.js"]) {
      if (!existsSync(join(tmp, f))) throw new Error(`fichier absent du paquet : ${f}`);
    }
    console.log("✓ paquet lisible, version et fichiers clés présents");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // 2) l'app fabriquée démarre et TIENT debout (la 0.2.4 mourait en 1 s, code 1)
  const app = spawn(join(DIST, "win-unpacked", "GetYes.exe"), [], { env: ENV_PROPRE, detached: false, stdio: "ignore" });
  let morte = null;
  app.on("exit", (code) => (morte = code));
  await new Promise((r) => setTimeout(r, 15000));
  if (morte !== null) throw new Error(`l'app s'est arrêtée seule (code ${morte}) : NE PAS PUBLIER`);
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* déjà fermée */
  }
  console.log("✓ l'app fabriquée démarre et reste ouverte 15 s");
}

function avecPourcentage(yml, pct) {
  const sans = yml.replace(/^stagingPercentage:.*\r?\n?/m, "");
  return pct >= 100 ? sans : sans.trimEnd() + `\nstagingPercentage: ${pct}\n`;
}

function notesVersion() {
  const md = readFileSync(join(RACINE, "CHANGELOG.md"), "utf8");
  const m = md.match(new RegExp(`## ${VERSION.replace(/\./g, "\\.")}\\s*\\n([\\s\\S]*?)(\\n## |$)`));
  if (!m) throw new Error(`pas d'entrée ## ${VERSION} dans CHANGELOG.md`);
  const f = join(tmpdir(), `getyes-notes-${VERSION}.md`);
  writeFileSync(f, m[1].trim() + "\n");
  return f;
}

async function publier() {
  const pct = pourcentage();
  await verifier();
  writeFileSync(LATEST, avecPourcentage(readFileSync(LATEST, "utf8"), pct));
  lancer("gh", ["release", "create", `v${VERSION}`, "-R", DEPOT, "--latest", "--title", `GetYes ${VERSION}`,
    "--notes-file", notesVersion(), EXE, `${EXE}.blockmap`, LATEST]);
  console.log(`✓ v${VERSION} publiée pour ${pct} % des installations. Élargir : node tools/publier.mjs elargir --pct 100`);
}

function elargir() {
  const pct = pourcentage();
  const tmp = mkdtempSync(join(tmpdir(), "getyes-yml-"));
  lancer("gh", ["release", "download", `v${VERSION}`, "-R", DEPOT, "-p", "latest.yml", "-D", tmp]);
  const f = join(tmp, "latest.yml");
  writeFileSync(f, avecPourcentage(readFileSync(f, "utf8"), pct));
  lancer("gh", ["release", "upload", `v${VERSION}`, "-R", DEPOT, f, "--clobber"]);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ v${VERSION} diffusée à ${pct} % des installations`);
}

const actions = { fabriquer, verifier, publier, elargir };
const action = actions[process.argv[2]];
if (!action) {
  console.log("usage : node tools/publier.mjs fabriquer | verifier | publier --pct 10 | elargir --pct 100");
  process.exit(1);
}
try {
  await action();
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
