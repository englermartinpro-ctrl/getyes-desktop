# Signature Windows de l'installeur GetYes

Pourquoi : sans signature, chaque nouvelle version est un fichier inconnu pour
Windows SmartScreen. La réputation repart de zéro à chaque mise à jour et l'écran
bleu « Windows a protégé votre ordinateur » revient. Avec un certificat, la
réputation est attachée à l'éditeur (le certificat), donc toutes les versions en
héritent. Depuis 2024, un certificat EV n'a plus de passe-droit : l'écran
disparaît avec le volume de téléchargements, OV suffit.

Choix (Martin, 06/10) : **Certum « Standard Code Signing in the Cloud »**
(SimplySign). Pas de clé USB à recevoir, la clé privée vit chez Certum, on signe
depuis le PC avec un code à usage unique de l'application mobile SimplySign.

## 1. Ce que seul Martin peut faire (15 à 20 minutes, puis attente)

1. Commander : https://shop.certum.eu/data-safety/code-signing-certificates.html
   → « Standard Code Signing in the Cloud » (209 € TTC/an au 06/10/2026).
   Prendre 1 an : depuis le 27/02/2026 un certificat ne peut pas dépasser 459
   jours, un achat pluriannuel oblige de toute façon à une réémission annuelle.
2. Activer le certificat dans l'espace Certum (lien reçu par mail). Trois blocs
   à remplir : l'organisation, le souscripteur (toi), ton droit de représenter
   l'organisation. Renseigner **exactement** ce qui figure au registre : nom
   légal, adresse du siège, SIREN.
3. Pièces à tenir prêtes :
   - extrait d'immatriculation de moins de 3 mois (Kbis ou avis de situation INSEE) ;
   - pièce d'identité du dirigeant (recto-verso, lisible) ;
   - un numéro de téléphone de l'entreprise **vérifiable publiquement** (annuaire
     professionnel, site officiel, registre) — c'est la cause n° 1 des blocages ;
   - une adresse mail au nom de domaine de l'entreprise si possible.
4. Vérification Certum : contrôle du registre, appel téléphonique ou vérification
   documentaire, puis mail de confirmation. Compter 1 à 5 jours ouvrés.
5. Installer **SimplySign Desktop** sur le PC de build et l'application mobile
   SimplySign (iOS/Android) ; associer le compte avec le code d'activation reçu.
   Mode d'emploi officiel : https://www.files.certum.eu/documents/repsitory/7-doc-templates/CodeSigning-SimplySign-Instructions-for-activation-and-installation.pdf
6. Me donner le texte exact du champ « Délivré à » du certificat (visible dans
   SimplySign Desktop ou `certmgr.msc` → Personnel → Certificats). Il doit être
   recopié au caractère près dans la configuration.

## 2. Ce que Claude fait ensuite (une heure)

1. `package.json` → `build.win.signtoolOptions.certificateSubjectName` = le
   « Délivré à » exact ; `build.win.publisherName` = la même valeur.
2. Build local avec SimplySign Desktop connecté (le code à usage unique est
   demandé une fois par session). electron-builder trouve le certificat dans le
   magasin Windows et signe l'installeur, le désinstalleur et l'exécutable.
3. Vérification : `signtool verify /pa /v dist\GetYes-Setup-x.y.z.exe` doit
   répondre « Successfully verified », avec l'horodatage Certum.
4. Publication GitHub comme d'habitude. Les apps installées se mettent à jour.

## 3. Ce qu'il faut savoir sur les mises à jour

- La première version signée s'installe sans problème sur un GetYes non signé
  (0.2.4 et avant) : l'app installée ne vérifie pas encore d'éditeur.
- À partir de là, electron-updater **vérifie** que chaque mise à jour est signée
  par le `publisherName` configuré. Si le certificat change de nom légal, la
  mise à jour est refusée : il faut d'abord livrer une version qui accepte les
  deux noms (`publisherName` accepte une liste).
- Au renouvellement, garder le même nom légal et la même autorité (Certum) :
  des éditeurs ont vu leur réputation SmartScreen repartir de zéro après un
  changement de certificat. Renouveler, ne pas recommander à neuf.
- Horodatage : `http://time.certum.pl` (déjà configuré). Un fichier horodaté
  reste valide après l'expiration du certificat.

## 4. Pourquoi pas Azure Artifact Signing (9,99 $/mois)

Moins cher et sans application à lancer, mais réservé aux organisations de
l'Union européenne avec validation d'entreprise, pas aux particuliers hors
États-Unis et Canada. À reconsidérer si GetYes a une société établie et un
pipeline de build automatisé (GitHub Actions).
