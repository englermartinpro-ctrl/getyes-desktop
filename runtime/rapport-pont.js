// -----------------------------------------------------------------------------
// PONT RAPPORT POST-APPEL — desktop → SaaS (chantier du 09/09, contrat :
// closepilot-app-v3/docs/pont-rapport-appel.md — LE lire avant de modifier).
// -----------------------------------------------------------------------------
// À la fin d'un appel, le runtime local émet `postcall_report` en WebSocket ;
// ce module POSTe le champ `report` TEL QUEL sur /api/rapport-appel (Bearer).
// Règles du contrat :
//  • payload STRICTEMENT identique à chaque retry (l'idempotence SaaS repose
//    sur le sha-256 du corps) → on fige la chaîne JSON UNE fois, à la réception ;
//  • retry backoff (5 s, 30 s, 2 min) sur 5xx/réseau UNIQUEMENT, puis file
//    persistée → nouvel essai à la prochaine ouverture de l'app ;
//  • 400/413 : jamais de retry — payload journalisé pour diagnostic ;
//  • 401 : rafraîchir la session puis UN retry ; sinon on garde en file.
// -----------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");

const BACKOFF_MS = [5_000, 30_000, 120_000];

let cfg = null; // { dossier, origine, obtenirToken, rafraichirSession, log, fetcher, backoff }
let file = []; // [{ corps, recu_le }]
let envoiEnCours = false;

const fichierFile = () => path.join(cfg.dossier, "rapports-en-attente.json");
const fichierRejets = () => path.join(cfg.dossier, "rapports-rejetes.log");
const log = (m) => cfg?.log?.(`[rapport-pont] ${m}`);

function persister() {
  try {
    fs.writeFileSync(fichierFile(), JSON.stringify(file), "utf8");
  } catch (e) {
    log(`persistance impossible : ${e.message}`);
  }
}

function journaliserRejet(entree, statut, detail) {
  try {
    fs.appendFileSync(
      fichierRejets(),
      `--- ${new Date().toISOString()} HTTP ${statut} ${detail}\n${entree.corps}\n`,
      "utf8",
    );
  } catch {
    /* le diagnostic ne doit jamais casser le pont */
  }
}

// Un envoi. Renvoie "fini" (retirer de la file), "retry" (panne passagère)
// ou "attendre" (401 persistant → prochaine ouverture).
async function envoyerUne(entree) {
  const jeton = await cfg.obtenirToken();
  const poster = (t) =>
    cfg.fetcher(`${cfg.origine}/api/rapport-appel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t ?? ""}`,
        "Content-Type": "application/json",
      },
      body: entree.corps,
    });
  let res;
  try {
    res = await poster(jeton);
    if (res.status === 401) {
      // Session expirée : le middleware SaaS rafraîchit les cookies sur un
      // simple appel authentifié → on relit le jeton et on retente UNE fois.
      await cfg.rafraichirSession();
      res = await poster(await cfg.obtenirToken());
    }
  } catch (e) {
    log(`réseau KO (${e.message}) — retry planifié`);
    return "retry";
  }
  if (res.status === 200) {
    const j = await res.json().catch(() => ({}));
    log(j.dejaRecu ? "déjà reçu côté SaaS — terminé" : "rapport enregistré");
    return "fini";
  }
  if (res.status === 400 || res.status === 413) {
    const detail = await res.text().catch(() => "");
    log(`rejeté (${res.status}) — journalisé, pas de retry`);
    journaliserRejet(entree, res.status, detail.slice(0, 300));
    return "fini";
  }
  if (res.status === 401) {
    log("401 persistant — on garde en file pour la prochaine ouverture");
    return "attendre";
  }
  log(`HTTP ${res.status} — retry planifié`);
  return "retry"; // 5xx et le reste : panne passagère
}

// Déroule la file : chaque entrée tente ses backoffs ; « attendre » stoppe la
// passe (la file persiste, reprise à la prochaine ouverture de l'app).
async function derouler() {
  if (envoiEnCours || !cfg) return;
  envoiEnCours = true;
  try {
    while (file.length > 0) {
      const entree = file[0];
      let sort = null;
      for (let essai = 0; essai <= cfg.backoff.length; essai++) {
        sort = await envoyerUne(entree);
        if (sort !== "retry") break;
        if (essai < cfg.backoff.length) {
          await new Promise((r) => setTimeout(r, cfg.backoff[essai]));
        }
      }
      if (sort === "fini") {
        file.shift();
        persister();
      } else {
        break; // retry épuisé ou 401 persistant → prochaine ouverture
      }
    }
  } finally {
    envoiEnCours = false;
  }
}

function init(options) {
  cfg = {
    fetcher: globalThis.fetch,
    backoff: BACKOFF_MS,
    log: () => {},
    ...options,
  };
  try {
    file = JSON.parse(fs.readFileSync(fichierFile(), "utf8"));
    if (!Array.isArray(file)) file = [];
  } catch {
    file = [];
  }
}

// Reçoit le champ `report` du message WS. La chaîne JSON est figée ICI et ne
// changera plus jamais (idempotence par empreinte du corps, cf. contrat).
function recevoir(report) {
  if (!cfg || !report || typeof report !== "object") return;
  file.push({ corps: JSON.stringify(report), recu_le: Date.now() });
  persister();
  void derouler();
}

// À l'ouverture de l'app : repartir sur ce qui n'a pas pu partir.
function reprendre() {
  if (file.length > 0) {
    log(`${file.length} rapport(s) en attente — reprise`);
    void derouler();
  }
}

module.exports = { init, recevoir, reprendre, _interne: { envoyerUne } };
