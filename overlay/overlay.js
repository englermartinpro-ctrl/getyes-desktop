// Overlay copilote GetYes — client du serveur WebSocket du runtime.
// Parle le protocole d'Eliott (closepilot_ui_server.py) : identique en mock ou
// en réel, donc ce code ne change pas quand on branche le vrai brain.

const WS_URL = "ws://127.0.0.1:8765";
const DEV = new URLSearchParams(location.search).get("dev") === "1";

const card = document.getElementById("card");
const dot = document.getElementById("dot");
const intentEl = document.getElementById("intent");
const phraseEl = document.getElementById("phrase");
const metaEl = document.getElementById("meta");
const devform = document.getElementById("devform");
const devinput = document.getElementById("devinput");

let ws = null;
let stream = ""; // accumulateur du streaming mot à mot

function setState(state) {
  card.dataset.state = state;
}

function setPhrase(text, { placeholder = false, streaming = false } = {}) {
  phraseEl.textContent = text;
  phraseEl.classList.toggle("placeholder", placeholder);
  phraseEl.classList.toggle("streaming", streaming);
}

function setIntent(text) {
  intentEl.textContent = text || "";
}

function chip(label, accent = false) {
  const el = document.createElement("span");
  el.className = "chip" + (accent ? " accent" : "");
  el.textContent = label;
  return el;
}

function renderMeta({ objection, tone, latency_ms }) {
  metaEl.innerHTML = "";
  if (objection) metaEl.appendChild(chip("objection : " + objection, true));
  if (tone) metaEl.appendChild(chip("ton : " + tone));
  if (typeof latency_ms === "number")
    metaEl.appendChild(chip(latency_ms + " ms"));
}

function esc(s) {
  return String(s ?? "—").replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}

function renderReport(r) {
  setIntent("Fin d'appel");
  metaEl.innerHTML = "";
  const p = r.profil || {};
  phraseEl.classList.remove("placeholder", "streaming");
  // Rendu DANS #phrase (on ne détache pas l'élément, il reste réutilisable).
  phraseEl.innerHTML =
    `<span class="report"><span class="score">${esc(r.score)}/100</span> · ` +
    `${esc(r.duree_min)}min ${esc(r.duree_sec)}s · ${esc(r.n_echanges)} échanges<br>` +
    `Profil <b>${esc(p.disc)} · ${esc(p.mbti)}</b> — ${esc(p.emotion)} · ` +
    `trajectoire <b>${esc(r.trajectoire)}</b><br>` +
    `Prochaine étape : <b>${esc(r.prochaine_etape)}</b></span>`;
}

function handle(msg) {
  switch (msg.type) {
    case "ready":
      setState("ready");
      setPhrase("Prêt. J'écoute le prospect…", { placeholder: true });
      break;
    case "thinking":
      setState("thinking");
      stream = "";
      setPhrase("…", { placeholder: true });
      if (msg.objection) setIntent("objection : " + msg.objection);
      break;
    case "partial":
      setState("streaming");
      stream += (stream ? " " : "") + msg.text;
      setPhrase(stream, { streaming: true });
      break;
    case "response":
      setState("done");
      setPhrase(msg.phrase || stream);
      setIntent(msg.intent || "");
      renderMeta(msg);
      stream = "";
      break;
    case "postcall_report":
      setState("done");
      renderReport(msg.report || {});
      break;
    case "session_reset":
      setState("ready");
      setIntent("");
      metaEl.innerHTML = "";
      setPhrase("Nouvel appel. J'écoute…", { placeholder: true });
      break;
    case "error":
      setState("off");
      setPhrase("⚠ " + (msg.msg || "erreur runtime"), { placeholder: true });
      break;
  }
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => {
    dot.title = "connecté";
    setState("ready");
  });
  ws.addEventListener("message", (ev) => {
    try {
      handle(JSON.parse(ev.data));
    } catch {
      /* ignore les trames non-JSON */
    }
  });
  ws.addEventListener("close", () => {
    setState("off");
    dot.title = "déconnecté — reconnexion…";
    setPhrase("Copilote hors ligne. Reconnexion…", { placeholder: true });
    setTimeout(connect, 1500); // le runtime met ~20s à chauffer au démarrage
  });
  ws.addEventListener("error", () => ws.close());
}

// Saisie de dev (mode mock) : simule la voix du prospect → envoie un "ask".
if (DEV) {
  devform.hidden = false;
  devform.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = devinput.value.trim();
    if (!text || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "ask", text }));
    devinput.value = "";
  });
}

// Bouton masquer → délègue au process principal (preload overlayAPI).
document.getElementById("hide").addEventListener("click", () => {
  window.overlayAPI?.hide();
});

connect();
