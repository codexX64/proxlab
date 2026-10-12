# ProxLab

La grappe Proxmox VE sous les yeux : machines et conteneurs, consoles,
instantanés, sauvegardes, disponibilité et alertes — auto-hébergé, sur le socle
commun des services.

Projet [CodexX64](https://github.com/CodexX64). Licence AGPL-3.0 ou ultérieure.

## Ce que fait ProxLab

- **Vue d'ensemble** : invités en marche, ce qui reste à traiter, stockage
  occupé, sauvegardes des dernières 24 heures ; trafic réseau de la grappe
  (1 h, 24 h, 7 jours) ; état de chaque nœud ; répartition des invités ;
  calendrier des sauvegardes sur vingt-huit nuits et carte de disponibilité
  heure par heure sur sept jours ; occupation de chaque stockage.
- **Machines** : machines virtuelles et conteneurs de tous les nœuds, filtrés
  et cherchés ; une fiche par machine avec ses relevés (processeur, mémoire,
  réseau, disque), ses instantanés, ses sauvegardes, sa configuration et sa
  console texte.
- **Gestes** : démarrer, arrêter proprement, redémarrer, suspendre, prendre un
  instantané, lancer une sauvegarde (membre) ; arrêt forcé, réinitialisation,
  migration, configuration, retour à un instantané, suppressions (administrateur,
  sous renfort récent). Chaque geste est un événement, signé de son auteur.
- **Nœuds** : ressources, interfaces réseau et shell d'un nœud (administrateur,
  sous renfort, journalisé).
- **Stockage** et **Tâches** : contenu de chaque stockage, tâches de la grappe
  et leur journal ; arrêt d'une tâche (administrateur, sous renfort).
- **Surveillance** : à chaque passe, l'état est comparé au précédent ; une
  machine qui tombe, un nœud perdu, un seuil franchi (stockage, mémoire,
  processeur), une création, une destruction, une restauration, un démarrage
  échoué devient un événement. Un arrêt demandé depuis ProxLab ne sonne pas.
- **Alertes** : chaque panne part, si un administrateur l'a réglé, vers un
  récepteur HTTP de tickets, avec une clé d'en-tête et une signature HMAC ;
  le Hub les relève aussi (déclencheur « Nouvelle alerte »), et SYNAPSE les
  garde en mémoire s'il est installé.

## Comptes et sécurité

ProxLab repose sur le socle commun : comptes nominatifs, rôles (`admin`,
`membre`, `lecture`), et au moins deux facteurs pour se connecter.

- **Clé d'accès** (Touch ID, Face ID, Windows Hello, clé USB) — exigée pour un
  administrateur quand ProxLab est servi en HTTPS.
- **Application d'authentification** (TOTP), configurée par un QR code généré
  localement dans le navigateur.
- **Mot de passe** (Argon2id), selon la politique choisie.
- **Dix codes de secours** à usage unique.

Sessions côté serveur, cookies `HttpOnly` et `SameSite=Strict`, en-tête CSRF,
politique de contenu stricte avec nonce (aucun script en ligne, aucune
bibliothèque tierce), limitation des tentatives, journal de sécurité chaîné.
Toute route exige une session (ou le jeton de service du Hub, comparé en temps
constant), un rôle déclaré et vérifié ; `/api/health` ne rend que `{ ok: true }`.

**Liaison à Proxmox.** Le trafic vers Proxmox n'est jamais envoyé sans
vérification TLS : soit le certificat est reconnu par les autorités du système,
soit son empreinte SHA-256 est épinglée. La lecture du certificat (« Lire le
certificat », administrateur sous renfort) montre le sujet, l'émetteur,
l'échéance et l'empreinte, à comparer avec celle que Proxmox affiche ; ensuite,
la connexion n'est rendue au client HTTP qu'après la comparaison de l'empreinte,
avant le premier octet applicatif. Chaque segment d'adresse (nœud, VMID,
instantané, stockage, tâche) est validé contre le format de Proxmox avant de
partir. La configuration d'une machine montrée à l'écran exclut ses secrets
(mots de passe cloud-init, clés SSH).

**Secrets.** Le secret du jeton d'API et le mot de passe de Proxmox, la clé et
le secret de signature du récepteur d'alertes sont scellés au repos
(AES-256-GCM, sous-clé par usage, liés à leur réglage) et ne ressortent jamais
de l'API après enregistrement — l'interface affiche « inchangé ». Un secret ne
suit jamais un changement de destination sans être ressaisi.

**Console.** Une console s'ouvre sur une passe d'une minute, à usage unique,
tirée sous la session (où le rôle et le renfort sont vérifiés) et présentée à
la mise à niveau WebSocket, qui vérifie l'origine et revérifie la session.
Seules la saisie et la taille passent du navigateur à Proxmox, bornées ; la
session est revérifiée chaque minute et la console se ferme avec elle.

**Droits à donner dans Proxmox.** Un utilisateur dédié (par exemple
`proxlab@pve`) et un jeton d'API à séparation de privilèges, avec les rôles
`PVEAuditor` (lecture) et `PVEVMUser` (alimentation, console) sur `/`, plus
`PVEDatastoreUser` sur les stockages de sauvegarde ; ajouter `PVEVMAdmin` pour
la migration, la configuration et les instantanés. Le mot de passe de cet
utilisateur ne sert qu'à la console. Le shell d'un nœud exige `Sys.Console`.

Les clés d'accès n'existent que sur une page HTTPS. Sans HTTPS, `SOCLE_HTTP=1`
ouvre un mode dégradé, affiché comme tel partout : réservé à un réseau de
confiance, le temps de servir ProxLab en HTTPS.

**Tourner la clé maîtresse.** Dans le Hub (réglages avancés de ProxLab) ou dans
`.env` : la clé actuelle dans `SOCLE_CLE_ANCIENNE`, une neuve
(`openssl rand -base64 32`) dans `SOCLE_CLE`, puis redémarrer. ProxLab rescelle
chaque secret TOTP et chaque secret de la liaison et des alertes, et l'écrit
dans ses journaux. Vider ensuite `SOCLE_CLE_ANCIENNE` et redémarrer. Une clé
que la base ne connaît pas arrête le démarrage au lieu de perdre les secrets.
`node outils/exercice-rotation.mjs` rejoue toute la rotation sur une instance
lancée comme en production.

## Installation par le Hub

Dans le Hub : Extensions → ProxLab → Installer. Le Hub génère la clé maîtresse,
le jeton de service et le jeton d'administration des comptes, et les garde
dans son coffre. Les comptes de ProxLab se gèrent ensuite aussi depuis
« Comptes des services ».

Au premier démarrage, ProxLab écrit son **jeton d'installation** dans ses
journaux (bouton Journaux du service). Il ne sert qu'une fois : à créer le
premier compte administrateur. Puis Réglages → Liaison à Proxmox.

## Installation seule

La clé maîtresse vit dans un secret Docker, hors du volume de données, lisible
par l'utilisateur du conteneur (10001) seul. Garder une copie hors ligne de
`secrets/socle_cle` : sans elle, une sauvegarde de la base ne rouvre ni les
secrets TOTP ni ceux de la liaison.

```bash
cp .env.example .env
# renseigner PROXLAB_HUB_TOKEN si un Hub doit lire ProxLab (openssl rand -hex 24)
mkdir -p secrets && openssl rand -base64 32 > secrets/socle_cle && : > secrets/socle_cle_ancienne
sudo chown 10001:10001 secrets/socle_cle secrets/socle_cle_ancienne && sudo chmod 400 secrets/socle_cle secrets/socle_cle_ancienne
docker compose up -d --build
docker compose logs proxlab | grep "Jeton d'installation"
```

Le port n'est publié que sur la boucle locale : placer un relais HTTPS devant
(voir « Derrière un relais inverse »). Sans Docker : Node 24.7 ou plus récent,
puis `npm start` (aucune dépendance à installer) ; sans `SOCLE_CLE` ni
`SOCLE_CLE_FILE`, la clé est créée dans `DATA_DIR/cles`, ce qui ne convient
qu'au développement.

Vérifications : `npm test` (serveur, faux Proxmox en HTTPS avec certificats
tirés à la volée, WebSocket de console, récepteur d'alertes), `npm run
test:socle`, `node outils/exercice-rotation.mjs`, `node outils/exercice-incident.mjs`
(runbook d'incident joué sur une instance lancée comme en production), et
`node outils/vitrine.mjs` puis `node outils/parcours-navigateur.mjs <url>
<jeton> <hôte:port>` (parcours dans Chromium, sept largeurs, avec Playwright).

## Sauvegardes

Une sauvegarde est un instantané cohérent de la base, chiffré pour une clé
publique RSA (3072 bits au moins) dont la clé privée ne vit **pas** sur la
machine de ProxLab.

```bash
# Une fois, sur le poste qui gardera la clé privée :
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out proxlab-sauvegarde.pem
openssl pkey -in proxlab-sauvegarde.pem -pubout -out proxlab-sauvegarde.pub
# Chaque jour, sur l'hôte de ProxLab (la clé publique suffit) :
docker exec -i <proxlab> node src/cli.js sauvegarde < proxlab-sauvegarde.pub > proxlab-$(date -u +%F).sauv
# Restauration, sur le poste de la clé privée, dans un fichier neuf :
node src/cli.js restaurer proxlab-sauvegarde.pem proxlab.db < proxlab-AAAA-MM-JJ.sauv
```

Copier chaque sauvegarde hors de l'hôte et la garder trente jours. Remettre la
base dans le volume, ProxLab arrêté : `proxlab.db` au propriétaire 10001, en
`0600`, sans les fichiers `-wal` et `-shm` d'avant.

## Configuration

Chaque variable secrète peut aussi être lue d'un fichier : `NOM_FILE=/chemin`.
Une valeur invalide arrête ProxLab au démarrage avec la liste des erreurs.

| Variable | Rôle | Défaut |
|---|---|---|
| `PROXLAB_HUB_TOKEN` | jeton du Hub : état, événements, alertes, démarrer / arrêter proprement / redémarrer — jamais les comptes, la liaison ni les alertes | — |
| `PROXLAB_INTERVAL` | passe de surveillance (s, 15 à 3600) | `60` |
| `PROXLAB_EVENTS_DAYS` | rétention des événements (jours, 1 à 365 ; 20 000 au plus) | `30` |
| `SOCLE_JETON_ADMIN_HUB` | jeton d'administration des comptes par le Hub ; dans le Hub, généré (`HUB_ADMIN_TOKEN`) | — |
| `SOCLE_THEME` | gamme de l'interface : `soma`, `console` ou `exploitation` ; dans le Hub, choisie dans la page Thème | `soma` |
| `DATA_DIR` | dossier de `proxlab.db` | `/app/data` |
| `PORT` / `HOTE` | écoute | `8140` / `0.0.0.0` |
| `SOCLE_CLE` | clé maîtresse, 32 octets en base64 (en conteneur : `SOCLE_CLE_FILE`) | — |
| `SOCLE_CLE_ANCIENNE` | pendant une rotation seulement : la clé remplacée | — |
| `SOCLE_HTTP` | `1` : mode dégradé sans HTTPS | `0` |
| `SOCLE_PROXYS` | relais inverses de confiance (CIDR) | — |
| `SOCLE_ORIGINES` | origines acceptées en plus de celle de la page | — |
| `SOCLE_JETON_INSTALLATION` | jeton du premier compte ; vide : tiré au démarrage | — |
| `SOCLE_URL_PUBLIQUE` | adresse publique (`https://…`) des liens de courriel | — |
| `SOCLE_SMTP_HOTE` / `_PORT` / `_SECURITE` | relais des alertes de sécurité : `tls` (465) ou `starttls` (587) | — / 465 / `tls` |
| `SOCLE_SMTP_UTILISATEUR` / `_MOTDEPASSE` / `_DE` | identifiants du relais et adresse d'expédition | — |

La liaison à Proxmox et le récepteur d'alertes se règlent dans l'interface
(Réglages), pas dans l'environnement : leurs secrets sont scellés en base.

## Derrière un relais inverse

Déclarer l'adresse du relais dans `SOCLE_PROXYS` ; sans cela, ProxLab ignore
`X-Forwarded-For` et `X-Forwarded-Proto`. Le relais doit transmettre
`X-Forwarded-For`, `X-Forwarded-Proto` et `Host`, et laisser passer la mise à
niveau WebSocket sur `/ws/console`.

## Sécurité

Les données conservées et leur finalité sont décrites dans
`web/confidentialite.txt`, servi à `/confidentialite.txt`.

En cas d'incident : fermer toutes les sessions et forcer une réinitialisation
depuis la page Comptes, régénérer le jeton du Hub au redéploiement, retirer la
liaison (`node src/cli.js liaison retirer`) et révoquer le jeton d'API dans
Proxmox, tourner la clé maîtresse, restaurer depuis une sauvegarde.
`node outils/exercice-incident.mjs` joue ce déroulé de bout en bout.
L'exploitant notifie une violation de données dans les 72 heures si le droit
applicable l'exige.

Une faille se signale en privé, par un avis de sécurité GitHub sur le dépôt
(`Security → Advisories → Report a vulnerability`), jamais dans une issue
publique.
