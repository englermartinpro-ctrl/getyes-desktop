# GetYes Desktop

Application de bureau GetYes (Electron). Elle embarque le SaaS web dans une
fenêtre native et, à terme, lance le **runtime local** (le brain Python de
`getyes-runtime`) pour le copilote d'appel en direct.

> ⚠️ Phase actuelle : **local uniquement**, non distribué. On construit et on
> éprouve sur nos machines avant de sécuriser les clés puis de distribuer.

## Lancer en local

```bash
npm install        # installe Electron (~1re fois, un peu long)
npm start          # ouvre la fenêtre GetYes
```

Par défaut, la fenêtre charge **https://www.getyes.app/dashboard** — c'est-à-dire
**le produit**, pas la landing marketing. Si tu n'es pas connecté, le SaaS te
redirige vers `/login`. Pour pointer vers ton SaaS en dev :

```bash
GETYES_URL=http://localhost:3000/dashboard npm start
```

La session est **persistée** : tu restes connecté d'un lancement à l'autre.

## Feuille de route

- [x] **v0.1** — coquille Electron : fenêtre + SaaS embarqué + session persistante.
- [ ] **v0.2** — l'app lance le runtime Python en fond (remplace `GETYES.bat`).
- [ ] **v0.3** — overlay flottant connecté au WebSocket `ws://127.0.0.1:8765`.
- [ ] **v0.4** — handshake auth : l'app passe l'identité de l'utilisateur au runtime.
- [ ] **Sécu** — proxy backend pour les clés LLM + accès base (jamais dans le client).
- [ ] **Distribution** — packaging + signature Windows/Apple.

## Composants du projet GetYes

- **`closepilot-app-v3`** — le SaaS web (Next.js).
- **`getyes-runtime`** — le runtime/brain (Python, WebSocket `localhost:8765`).
- **`getyes-desktop`** — cette app (relie les deux + capte l'audio des appels).
