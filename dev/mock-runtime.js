// -----------------------------------------------------------------------------
// FAUX runtime GetYes — serveur WebSocket de DEV
// -----------------------------------------------------------------------------
// Rejoue le protocole EXACT du vrai serveur d'Eliott (closepilot_ui_server.py)
// pour développer + tester le launcher et l'overlay SANS le brain Python, ses
// dépendances, ni ses clés API. Le jour où le vrai runtime est prêt, on
// débranche ce mock et on pointe le manager sur `python closepilot_ui_server.py`
// — le protocole étant identique, l'overlay ne voit aucune différence.
//
// Protocole (cf. entête de closepilot_ui_server.py) :
//   UI → Serveur : {type:"ask",   text:"phrase prospect"}
//                : {type:"reset"}                        (fin d'appel)
//   Serveur → UI : {type:"ready"}                        (au connect)
//                : {type:"thinking",  objection:"..."}
//                : {type:"partial",   text:"mot"}        (streaming)
//                : {type:"response",  phrase, phase, intent, objection, tone,
//                                     latency_ms}
//                : {type:"postcall_report", report:{...}} (≥3 tours, au reset)
//                : {type:"session_reset"}
//                : {type:"error",     msg:"..."}
// -----------------------------------------------------------------------------

const { WebSocketServer } = require("ws");

const HOST = "127.0.0.1";
const PORT = 8765;

// Suggestions de closing canned, choisies par mots-clés → la démo ressemble à du
// réel plutôt qu'à du lorem. (Le vrai brain fait ça avec l'arsenal + Haiku.)
function suggestionPour(texte) {
  const t = (texte || "").toLowerCase();
  if (/cher|prix|budget|co[uû]te|tarif|argent/.test(t))
    return {
      phrase:
        "Je comprends. Et justement — à combien tu estimes ce que ça te coûte de rester exactement où tu en es encore six mois ?",
      intent: "Retourner l'objection prix",
      objection: "prix",
      phase: "OBSTACLE",
      tone: "posé",
    };
  if (/r[ée]fl[ée]ch|voir|temps|attendre|plus tard/.test(t))
    return {
      phrase:
        "Ok, ça s'entend. Concrètement, qu'est-ce qui te ferait dire oui aujourd'hui plutôt que dans trois semaines ?",
      intent: "Isoler la vraie hésitation",
      objection: "reflexion",
      phase: "PRECLOSE",
      tone: "direct",
    };
  if (/femme|mari|associ|partenaire|parler|conjoint/.test(t))
    return {
      phrase:
        "Bien sûr, c'est normal d'en parler. Si on met l'avis extérieur de côté deux minutes : toi, tu le sens comment ce projet ?",
      intent: "Ramener à SA décision",
      objection: "tiers",
      phase: "ENGAGEMENT",
      tone: "chaleureux",
    };
  if (/d[ée]j[àa] essay|marche pas|[ée]chou/.test(t))
    return {
      phrase:
        "Et si ce qui n'a pas marché avant, c'était pas toi, mais la méthode ? Qu'est-ce qui était différent dans ce que tu avais testé ?",
      intent: "Désamorcer le passé",
      objection: "deja_essaye",
      phase: "VALEUR",
      tone: "rassurant",
    };
  return {
    phrase:
      "Dis-m'en un peu plus — qu'est-ce qui t'a fait accepter cet appel aujourd'hui, précisément ?",
    intent: "Faire émerger la douleur",
    objection: "",
    phase: "DOULEUR",
    tone: "curieux",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wss = new WebSocketServer({ host: HOST, port: PORT });
console.log(`[mock-runtime] WebSocket ${HOST}:${PORT} — protocole GetYes (DEV)`);

wss.on("connection", (ws) => {
  console.log("[mock-runtime] overlay connecté");
  ws.send(JSON.stringify({ type: "ready" }));
  let tours = 0;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: "error", msg: "JSON invalide" }));
    }

    if (msg.type === "reset") {
      if (tours >= 3) {
        ws.send(
          JSON.stringify({
            type: "postcall_report",
            report: {
              score: 78,
              duree_min: 14,
              duree_sec: 32,
              n_echanges: tours,
              profil: {
                disc: "I",
                mbti: "ENFP",
                ei: "E",
                emotion: "enthousiaste",
                conseil_reabord: "Relancer sous 48h, ton chaleureux, rappeler le rêve exprimé.",
              },
              trajectoire: "réchauffé",
              points_forts: ["Bon lien créé", "Douleur bien identifiée"],
              axes_amelioration: ["Closer plus tôt sur le signal d'achat"],
              prochaine_etape: "Envoyer le récap + créneau de signature.",
            },
          }),
        );
      }
      tours = 0;
      return ws.send(JSON.stringify({ type: "session_reset" }));
    }

    if (msg.type !== "ask" || !msg.text) return;
    tours++;
    const t0 = Date.now();
    const s = suggestionPour(msg.text);

    ws.send(JSON.stringify({ type: "thinking", objection: s.objection }));
    await sleep(350); // le brain "chauffe" (~classifier + retrieval)

    // Streaming mot à mot, comme le vrai speaker Haiku.
    for (const mot of s.phrase.split(" ")) {
      await sleep(42);
      ws.send(JSON.stringify({ type: "partial", text: mot }));
    }

    ws.send(
      JSON.stringify({
        type: "response",
        phrase: s.phrase,
        phase: s.phase,
        intent: s.intent,
        objection: s.objection,
        tone: s.tone,
        latency_ms: Date.now() - t0,
      }),
    );
  });

  ws.on("close", () => console.log("[mock-runtime] overlay déconnecté"));
});

process.on("SIGTERM", () => wss.close(() => process.exit(0)));
process.on("SIGINT", () => wss.close(() => process.exit(0)));
