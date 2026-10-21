# Code quality record — ProxLab

Method: Project Baseline Requirements & Security Manual, Part III (chapters 37-49)
Reviewed: 2026-10-12 (2.0), 2026-10-19 (delta 2.1, `v2.1.2..v2.1.10`)   ·   Owner: Codex64

## Behaviour freeze
Point de départ de la passe : `c66719a`, dernier commit de code de la phase de sécurité. Ensemble de référence relevé avant la passe : 83 essais — 17 du service (`test/proxlab.test.js`, faux Proxmox en HTTPS aux certificats tirés à la volée, vraie console WebSocket, vrai récepteur d’alertes, ligne de commande lancée pour de bon) et 66 du socle embarqué — tous verts. Relancés à la génération de ce fichier : les mêmes, un à un, tous verts ; la passe n’a ajouté ni retiré aucun essai, elle en a renforcé trois de quatre assertions (voir « Tests »). Depuis, 1 de plus : « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » (`fccd211`), essai de l’écran des machines virtuelles, fonction ajoutée après la passe (2.1.0). Aucun essai de caractérisation n’a été nécessaire : l’essai « autorisation » balaie déjà chaque route du routeur sans session, avec le jeton du Hub, en lecture et en membre, et chaque route a son parcours.

Diff de l’API publique sur la passe : vide. L’inventaire de la surface publique (`proxlab/surface.mjs`, hors dépôt) est identique ligne à ligne entre `c66719a` et `4bedc07`, fin de la passe, et identique à celui relevé avant la passe : 34 routes avec leurs options et leurs schémas de requête, 16 schémas de corps, le chemin WebSocket de la console, 6 variables de configuration, 18 réglages, 2 déclencheurs, 3 actions et 5 sondes du manifeste du Hub, 4 commandes de la ligne de commande — 89 lignes. Après la passe, 2 lignes changées, déclarées : étiquette d’image par défaut du manifeste alignée sur la version (2.1.1) (`3db545f`) ; champ « mode » (texte ou écran) de la console, pour l’écran des machines virtuelles (`fccd211`).

Démarrage et parcours de bout en bout, sur l’arbre final, le 2026-10-12 : `outils/exercice-rotation.mjs` → 21 vérifications réussies ; `outils/exercice-incident.mjs` → 22 vérifications réussies ; `outils/parcours-navigateur.mjs` contre `outils/vitrine.mjs` (installation par clé d’accès virtuelle, liaison par l’interface avec lecture du certificat et empreinte épinglée, vue d’ensemble, machines, fiche et ses onglets, écran d’une machine virtuelle ouvert et saisi au clavier, dialogue d’instantané, console ouverte et saisie, nœuds et shell, stockage et son contenu, tâches et journal, événements, sécurité, comptes ; vingt écrans à sept largeurs, de 360 à 1920 pixels), en gamme SOMA et en gamme Exploitation → 140 écrans×largeurs chacune, 0 défaut de mise en page, 0 erreur de console ; sondage exploratoire de SECURITY.md → rejoué sur une instance neuve à chaque génération de ce relevé-là.

Delta 2.1 (`v2.1.2..v2.1.10`), le 2026-10-19 : 21 essais du service et 67 du socle, tous verts, et 28 vérifications dans un vrai navigateur sur le faux Proxmox (écran, presse-papiers dans les deux sens, frappe AZERTY et QWERTY, raccourcis Mac, console, onglets gardés ouverts, presse-papiers démesuré ; `ps2.mjs`, hors dépôt). Déclarations de routes et de schémas comparées entre `v2.1.2` et l’arbre final : deux routes ajoutées (`POST …/acces`, `GET …/clavier`) et le schéma `acces`, aucune route ni aucun schéma existants changés ; la fiche gagne `config` et `enAttente`. Changement de comportement voulu : `POST /api/console` d’une VM sans port série répond 409 avant Proxmox.

## Layer status
| Chapter | Subject | Status | What changed |
|---|---|---|---|
| 39 | Comment layer | DONE | quatorze marqueurs de section retirés (`src/api.js`, `web/app.js`), deux gardés en phrase quand ils disaient ce que le code ne dit pas (la liaison, sous renfort et scellée ; les routes du Hub, jamais une session) ; densité moyenne 8.7 %, les fichiers au-dessus de 25 % relus un à un (`src/config.js`, `src/tls.js`) : les trois garanties de la sonde TLS, le rôle de chaque variable de configuration — des invariants et des raisons, aucune narration |
| 40 | Naming and vocabulary | DONE | vocabulaire du domaine en français partout (nœud, machine, liaison, passe, instantané, sauvegarde, surveillance) ; champs de Proxmox gardés tels quels là où ils traversent (`vmid`, `node`, `maxmem`, `upid`) ; aucun nom générique hors `res` (réponse HTTP de Node) et `ev.data` (API du DOM) |
| 41 | Formatting, layout and whitespace | DONE | aucun formateur dans le dépôt, aucun introduit ; 2 espaces, apostrophes simples, points-virgules, comme le socle ; `git diff --check` depuis l’arbre vide : propre ; aucun caractère invisible |
| 42 | Gratuitous abstraction | DONE | aucune interface à une seule implémentation, aucune fabrique ; duplications repliées : la validation d’un stockage, d’une tâche et d’un instantané (deux copies chacune, une aide par objet à côté de `machine` et `noeud`), l’ouverture d’une ligne de tableau au clic et au clavier (trois copies, et une quatrième ligne qui ne s’ouvrait qu’à la souris) |
| 43 | Defensive noise | DONE | 133 `catch` rangés ci-dessous selon ce que fait leur bloc, aucun hors classe (76 dans le code de ProxLab, les autres dans le socle, relus dans son propre dépôt) ; aucun message vague, aucune journalisation d’entrée ou de sortie de fonction |
| 44 | Control flow and idiom | DONE | retours anticipés ; validation en tête de chaque route, avant toute lecture de corps ; boucles indexées là où l’indice porte le sens (démasquage des trames WebSocket, cellules du terminal, points d’une courbe) |
| 45 | Types, signatures and data shapes | DONE | JavaScript sans TypeScript ; un contrat d’erreur : `ErreurHttp` du socle, `ErreurProxmox` traduite une seule fois par `versClient` (cause courte et référence au client, détail au journal du serveur) ; schémas de corps et de requête déclaratifs, champ inconnu refusé ; réponses construites champ par champ |
| 46 | Dependencies, configuration, fitting the repository | DONE | aucune dépendance npm ; chacune des 15 variables de `.env.example` a un lecteur ; code mort retiré (abonnés aux événements jamais branchés) ; exports sans lecteur ramenés à leur module (`NOEUD`, `MAX_EVENEMENTS`, `transaction`) ; aucun import inutilisé (liaisons de 66 fichiers JavaScript analysées) |
| 47 | Tests | DONE | 23 cassures volontaires, chacune détectée (ci-dessous) ; quatre passaient d’abord inaperçues et ont renforcé un essai : « .. » au milieu d’un segment, une taille de terminal démesurée (l’essai la vérifiait avant qu’elle n’arrive), la base remise dans le volume avec d’autres droits, et un refus de console sans trace — ce dernier a révélé deux défauts réels, corrigés dans leurs propres commits : un refus par adresse et par minute seulement, et des détails de journal vidés par le filtre des secrets du socle (« motif » et « jeton » y passent pour des secrets) |
| 48 | Documentation, furniture and version control | DONE | README, `.gitignore`, `.dockerignore`, `LICENSE`, `Dockerfile`, Compose, manifeste du Hub, vérification CI et en-tête des outils relus ; un sujet par commit, sans mention d’outil, en UTC |

Delta 2.1, chapitre par chapitre : 39, commentaires des nouveaux modules relus, chacun dit une raison (protocole RFB, agent QEMU, `lock_key_sync` de QEMU), aucun ne raconte le code ; 40, vocabulaire du dépôt gardé (`presse`, `disposition`, `passe`, `vivant`), noms du protocole gardés là où ils traversent (`ClientCutText`, `keysym`) ; 41, `git diff --check` propre ; 42, l’adresse versionnée `/v/<version>/` réécrite dans `src/main.js` remplacée par `cheminVersionne` du socle, qui la portait déjà ; 43, 27 `catch` nouveaux classés ci-dessous, un qui avalait un presse-papiers refusé le dit maintenant ; 44, la route du clavier lisait ses paramètres sous condition et laissait passer un paramètre inconnu : lus en tête, comme partout ; 45, un seul contrat d’erreur conservé (`ErreurHttp`, raisons de détection rendues en `{ disposition: null, raison, message }`) ; 46, aucune dépendance ajoutée, décompression par `DecompressionStream` du navigateur ; 47, 15 cassures volontaires du delta, toutes détectées ; 48, README (droits de l’agent, console sans Entrée automatique) et SECURITY.md mis à jour, un sujet par commit.

`catch` restants, par raison (2.0 ; le delta 2.1 suit le tableau) :

| Raison | Nombre | Où |
|---|---|---|
| montrée à l’écran ou rendue au demandeur, avec sa cause | 33 | `socle/`, `src/alerte.js`, `web/app.js` |
| sans effet voulu, la raison écrite dans le bloc | 31 | `outils/`, `socle/`, `src/alerte.js`, `src/base.js`, `src/console.js`, `src/ecran.js`, `src/main.js`, `src/pve.js` et 2 autres |
| relevée, traduite en erreur du domaine (ErreurHttp, ErreurProxmox) ou transmise | 24 | `socle/`, `src/api.js`, `src/base.js`, `src/cli.js`, `src/ecran.js`, `src/main.js` |
| valeur de repli explicite (donnée externe illisible, objet disparu, service absent) | 23 | `socle/`, `src/api.js`, `src/base.js`, `src/console.js`, `src/ecran.js`, `test/`, `web/app.js` |
| tâche d’arrière-plan facultative : son échec n’a rien à montrer, l’action suivante le montre | 11 | `socle/`, `web/app.js` |
| journalisée, ou portée dans l’état du service | 5 | `socle/`, `src/main.js` |
| connexion rompue : fermée ou retirée, rien d’autre à faire | 4 | `src/main.js`, `src/websocket.js`, `web/ecran.js` |
| rapportée dans le résultat de l’étape | 2 | `socle/` |

Delta 2.1 : `rg -o 'catch\s*\(\s*\w*\s*\)\s*\{|catch\s*\{|\.catch\(' . -g '!SECURITY.md' -g '!NO-VIBE.md' | wc -l` → 123 à `4bedc07`, 150 sur l’arbre final ; les 27 nouveaux : montrée à l’écran ou rendue au demandeur avec sa cause, 9 (`src/clavier.js`, `web/app.js`, `web/ecran.js`, `web/terminal.js`) ; connexion rompue, fermée ou retirée, 5 (`src/ecran.js`) ; tâche facultative dont l’échec n’a rien à montrer, 4 (plein écran, copie différée vers le presse-papiers local, abandon d’un flux) ; relevée ou transmise, 3 (`src/api.js`, `src/ecran.js`) ; valeur de repli explicite, 3 (statut de l’agent illisible, stockage du navigateur absent, message illisible) ; sans effet voulu, raison écrite, 3.

## Tests
Cassures volontaires (REQ-CODE-005) : chacune posée seule, la suite du service lancée en entier, le fichier rétabli (`mutations_proxlab.py`, hors dépôt), sur l’arbre de la passe.

| Cassure | Fichier | Essais en échec | Premier essai qui échoue |
|---|---|---|---|
| un membre force l’arrêt d’une machine | `src/api.js` | 1 | « alimentation : le membre démarre et arrête proprement ; forcer exige l'admin sous renfort ; chaque geste est un événement » |
| un certificat qui n’est pas celui épinglé passe | `src/tls.js` | 5 | « TLS épinglé : la socket n'est rendue qu'après l'empreinte, jamais avec une autre » |
| la fiche rend les secrets cloud-init et les clés SSH | `src/api.js` | 1 | « état de la grappe et fiche d'une machine : champs choisis, rien de sensible de la configuration » |
| un segment contenant « .. » part vers Proxmox | `src/pve.js` | 1 | « chemins : un segment hors format n'atteint jamais Proxmox » |
| une passe de console sert à une autre session | `src/api.js` | 1 | « console : passe à usage unique liée à la session, origine contrôlée, shell d'un nœud sous renfort » |
| une passe de console resert | `src/api.js` | 1 | « console : passe à usage unique liée à la session, origine contrôlée, shell d'un nœud sous renfort » |
| une console s’ouvre depuis une autre origine | `src/main.js` | 1 | « console : passe à usage unique liée à la session, origine contrôlée, shell d'un nœud sous renfort » |
| le récepteur d’alertes vise les métadonnées du nuage | `src/api.js` | 4 | « Hub : jeton de service, état et événements en lecture, seulement trois gestes d'alimentation » |
| les tickets partent sans signature | `src/alerte.js` | 2 | « surveillance : une machine tombée est un événement et un ticket signé ; un arrêt depuis ProxLab ne sonne pas » |
| un arrêt demandé depuis ProxLab sonne comme une panne | `src/surveillance.js` | 2 | « surveillance : une machine tombée est un événement et un ticket signé ; un arrêt depuis ProxLab ne sonne pas » |
| les jetons du Hub devinés ne comptent plus | `src/api.js` | 1 | « Hub : jeton de service, état et événements en lecture, seulement trois gestes d'alimentation » |
| le Hub force l’arrêt d’une machine | `src/api.js` | 1 | « Hub : jeton de service, état et événements en lecture, seulement trois gestes d'alimentation » |
| une erreur de Proxmox rend le chemin de l’hyperviseur | `src/api.js` | 1 | « instantanés, sauvegardes, configuration, migration : rôle, renfort et validation » |
| un compte supprimé reste nommé dans les événements | `src/base.js` | 1 | « données d'un compte : ses gestes exportés, neutralisés à sa suppression » |
| une taille de terminal démesurée part vers Proxmox | `src/console.js` | 1 | « console : passe à usage unique liée à la session, origine contrôlée, shell d'un nœud sous renfort » |
| un membre ouvre le shell d’un nœud | `src/api.js` | 1 | « console : passe à usage unique liée à la session, origine contrôlée, shell d'un nœud sous renfort » |
| un secret suit la liaison vers une autre destination | `src/api.js` | 1 | « liaison : sonde, empreinte épinglée, essai en direct, secrets scellés, jamais rendus » |
| la base et son journal WAL lisibles par tous | `src/base.js` | 1 | « en-têtes de sécurité, nonce, sonde publique minimale, security.txt » |
| un refus de console échappe au journal | `src/main.js` | 1 | « console : passe à usage unique liée à la session, origine contrôlée, shell d'un nœud sous renfort » |
| un message RFB inconnu passe vers Proxmox | `src/ecran.js` | 1 | « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » |
| le ticket de vncproxy part vers le navigateur | `src/ecran.js` | 1 | « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » |
| la réponse VNC oublie l’inversion des bits de la clé | `src/des.js` | 1 | « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » |
| un conteneur ouvre un écran VNC | `src/api.js` | 1 | « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » |

Delta 2.1 (`mutations21.py`, hors dépôt), sur l’arbre final : 15 cassures, 15 détectées ; une passait d’abord inaperçue (la sortie de la VM sous sa forme « système » n’était plus bornée) et a ajouté un essai.

| Cassure | Fichier | Essais en échec | Premier essai qui échoue |
|---|---|---|---|
| un presse-papiers étendu démesuré passe vers Proxmox | `src/ecran.js` | 2 | « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » |
| un message envoyé avant ClientInit atteint Proxmox | `src/ecran.js` | 1 | « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » |
| le ticket VNC est demandé avec le jeton du service, pas au nom de l’utilisateur | `src/ecran.js` | 2 | « écran d'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d'un client RFB passent » |
| la console texte d’une VM sans port série part vers Proxmox | `src/api.js` | 1 | « console d'une VM sans port série : refus clair avant Proxmox, ajout par l'administrateur, presse-papiers branché sur l'affichage » |
| un administrateur sans renfort change l’accès d’une VM | `src/api.js` | 1 | « console d'une VM sans port série : refus clair avant Proxmox, ajout par l'administrateur, presse-papiers branché sur l'affichage » |
| le presse-papiers est branché sur un affichage qxl | `src/api.js` | 1 | « console d'une VM sans port série : refus clair avant Proxmox, ajout par l'administrateur, presse-papiers branché sur l'affichage » |
| l’écriture de l’accès ne porte plus l’empreinte de la configuration lue | `src/api.js` | 1 | « clavier de la VM : demandé à l'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l'administrateur » |
| la lecture seule lit le clavier de la VM | `src/api.js` | 2 | « autorisation : chaque route refuse l'anonyme, la lecture et le membre selon son rôle déclaré, et le Hub ne vaut jamais session » |
| le clavier se relit sans attendre cinq secondes | `src/api.js` | 1 | « clavier de la VM : demandé à l'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l'administrateur » |
| une lecture du clavier échappe au journal | `src/api.js` | 1 | « clavier de la VM : demandé à l'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l'administrateur » |
| un paramètre de requête inconnu passe sur le clavier | `src/api.js` | 1 | « clavier de la VM : demandé à l'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l'administrateur » |
| la sortie de la VM n’est plus bornée | `src/clavier.js` | 1 | « clavier de la VM : demandé à l'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l'administrateur » |
| une variante à touches mortes passe pour l’AZERTY | `src/clavier.js` | 1 | « clavier de la VM : demandé à l'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l'administrateur » |
| un droit Proxmox manquant passe pour un agent absent | `src/clavier.js` | 1 | « clavier de la VM : demandé à l'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l'administrateur » |
| un fichier d’une autre version est gardé un an | `src/main.js` | 1 | « en-têtes de sécurité, nonce, sonde publique minimale, security.txt » |

Le faux Proxmox est un vrai serveur HTTPS à autorité et feuille tirées à la volée, qui parle l’API et le termproxy ; les essais passent par les routes, avec de vraies sessions, de vrais renforts, le vrai jeton du Hub, un vrai récepteur d’alertes. Ils portent sur les frontières et les chemins d’erreur : chaque route par rôle et par jeton, segments de chemin piégés, champs et paramètres inconnus, corps géants, CSRF et origine, empreinte fausse, secrets jamais rendus, passe rejouée ou volée, refus journalisés, rotation de la clé, sauvegarde et restauration, retrait de la liaison.

## Repository style profile
Node 24, modules ES, aucune dépendance npm. Serveur : `node:http` sous le portail du socle, `node:sqlite` avec requêtes préparées, `node:tls` pour la liaison (autorité ou empreinte comparée avant la première écriture), WebSocket écrit à la main, client et serveur. Interface : DOM construit par `h` du socle, graphiques du socle construits nœud par nœud, terminal écrit ici et rendu par `textContent` ; jamais de balisage injecté avec une donnée, aucun style en ligne. Vocabulaire : français pour le domaine, champs de Proxmox tels qu’ils arrivent. Erreurs : `ErreurHttp(status, message)` écrite pour l’opérateur ; une erreur de Proxmox perd ses chemins avant le client. Configuration : `lireConfigProxlab` sur un schéma, arrêt au démarrage avec toutes les erreurs, secrets par `_FILE` ; la liaison et les alertes se règlent dans l’interface et se scellent en base. Journaux : `log.*` pour l’exploitation, `Journal` du socle pour qui a fait quoi (chaîné), événements de la grappe pour l’interface et le Hub. Frontières : `src/` (routes, liaison, client, console, surveillance, alertes), `web/`, `socle/` (commun embarqué, modifié dans son propre dépôt seulement), `test/`, `outils/`. Aides reprises plutôt que réécrites : `chemin`, `machine`/`noeud`/`stockageDe`/`tacheDe`/`instantane`, `versClient`, `lookupGarde`/`hoteInterdit`, `valider` et `Portail.exiger` du socle, `ouvrable` et `champ` dans l’interface.

## Detection sweep
Relancé à chaque génération de ce fichier (bash, LC_ALL=C.UTF-8) ; un résultat différent de celui qui a été relu arrête la génération. Annexe B.5 et contrôles des chapitres 41 à 48, sur tout le dépôt hors des deux fichiers de conformité.

| # | Commande | Résultat | Justification |
|---|---|---|---|
| B.5.1 | `rg -n '^\s*(#\|//)\s*(Step \d\|Initialize\|Loop through\|Create (a\|an\|the)\|Return the\|Set the\|Get the\|Check if\|Now we\|First,\|Finally,)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.2 | `rg -n '^\s*(//\|#\|\*)\s*(Étape \d\|Initialise\|On boucle\|Boucle sur\|Retourne (le\|la\|les\|l.)\|Crée (un\|une\|le\|la)\|Vérifie si\|Maintenant,\|D.abord,\|Enfin,)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | la même recherche dans la langue du dépôt |
| B.5.3 | `rg -n '^\s*(#\|//)\s*[-=*_#─]{10,}' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.4 | `rg -n '^\s*(#\|//)\s*(─{3,}\|-{4} )' src web outils test` | 0 ligne | les bannières plus courtes et les marqueurs « ---- titre ---- », que la recherche précédente ne voit pas (quatorze retirés par la passe) |
| B.5.5 | `rg -n -t js -t css -t html '^\s*[-=*_#─]{10,}\s*(\*/)?$' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.6 | `rg -n 'simplified (implementation\|version)\|in a (real\|production) (system\|app)\|for (demo\|illustration) purposes\|this is just an example' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.7 | `rg -n --pcre2 '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `1` | un mot de passe fait d’emoji dans un essai du socle |
| B.5.8 | `rg -n '\b(def\|function\|func\|fn)\s+\w*(process\|handle\|manage\|perform\|execute\|do)_?\w*\s*\(' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.9 | `rg -o '\b\w+(Manager\|Service\|Handler\|Provider\|Factory\|Helper\|Util\|Wrapper\|Processor\|Engine)\b' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| cut -d: -f2- \| sort -u` | 0 ligne |  |
| B.5.10 | `find . -path ./node_modules -prune -o -type f -regextype posix-extended -regex '.*/(utils?\|helpers?\|common\|misc\|shared)\.(py\|ts\|js\|go\|rb\|java)' -print` | 0 ligne |  |
| B.5.11 | `rg -n '\b(data\|result\|output\|temp\|tmp\|res\|ret\|val\|obj\|item)\b\s*=' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `4` | `res`, la réponse HTTP de Node dans les rappels de `https.request` (client de Proxmox, émetteur d’alertes) ; `ev.data`, la donnée d’un message WebSocket du navigateur (API du DOM) ; `res`, la réponse simulée d’un essai du socle |
| B.5.12 | `rg -n 'catch\s*\(\s*(e\|err\|error)\s*\)\|catch\s*\{' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `99` | relus un à un avec les `.catch(` : 133 au total en 2.0, 27 de plus en 2.1, par raison ci-dessus |
| B.5.13 | `rg -n 'An error occurred\|Something went wrong\|Unexpected error\|Une erreur est survenue\|Quelque chose s.est mal passé' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.14 | `rg -n 'except\s*:\|except Exception\s*:' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | aucun Python dans le dépôt |
| B.5.15 | `rg -n 'logger\.(info\|debug)\(f?["\x27](Starting\|Entering\|Finished\|Exiting\|Called)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 41.1.1 | `git diff --check $(git hash-object -t tree /dev/null) HEAD -- . ':!SECURITY.md' ':!NO-VIBE.md'` | 0 ligne | depuis l’arbre vide : aucune espace en fin de ligne, aucune ligne vide de trop |
| 41.2.1 | `rg -n --pcre2 '[\x{200B}-\x{200D}\x{FEFF}\x{00A0}\x{2028}\x{2029}]' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | aucun caractère invisible ; la ponctuation typographique française (« », ’, …) est celle de tout le dépôt |
| 45.1.1 | `rg -n ':\s*any\b\|as unknown as' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | JavaScript sans TypeScript |
| 47.1.1 | `rg -n 'assert\.ok\(true\)\|toBeDefined\(\)\|assert\(true\)\|assertTrue\(True\)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 48.3.1 | `rg -n -i 'your-api-key-here\|TODO: implement\|FIXME: AI\|lorem ipsum\|example\.com/api' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 48.3.2 | `rg -n -i 'placeholder' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `20` | attributs `placeholder` des champs (dont la zone d’envoi du presse-papiers de l’écran) de l’interface et du socle, leur style, et le champ `placeholder` du manifeste du Hub (une adresse de la plage de documentation) |
| 48.3.3 | `rg -n '\b(TODO\|FIXME\|XXX\|HACK)\b' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 48.4.1 | `git log --all --format='%B' \| rg -i 'co-authored-by\|generated with'` | 0 ligne | tout l’historique |

## Report (chapter 49.6)
Comptes : 14 marqueurs de section retirés dont 2 gardés en phrase, 1 morceau de code mort et 3 exports sans lecteur retirés, 2 duplications repliées (6 copies), 1 ligne rendue joignable au clavier, 3 essais renforcés, 2 défauts de journalisation corrigés, 0 dépendance ajoutée. Fichiers laissés tels quels : les autres — leur densité de commentaires, leurs noms et leur gestion d’erreurs relèvent du profil ci-dessus.

Choix non faits, et pourquoi :
- Les champs de Proxmox (`vmid`, `maxmem`, `upid`, `netin`) ne sont pas traduits dans les réponses : ce sont les noms que l’opérateur retrouve dans Proxmox et que le Hub expose déjà dans ses actions ; les traduire ajouterait une table sans rien clarifier.
- `web/app.js` reste un seul module : ses pages partagent l’état, la coque et les aides de mise en forme ; le couper en fichiers multiplierait les imports sans frontière réelle.
- Les méthodes internes `_recevoir`, `_trame`, `_envoyer`, `_finir` du WebSocket gardent leur tiret bas : il marque ce qu’aucun appelant ne doit toucher.

Commits de la passe :
- `c9f4fb1 commentaires : marqueurs de section retirés, deux gardés en phrase`
- `c33ff55 base : abonnés jamais branchés retirés, exports sans lecteur ramenés à leur module`
- `bc52787 routes : le motif des nœuds n'est plus exporté, personne ne le lit`
- `6bb8557 routes : stockage, tâche et instantané validés par une aide chacun, plus de copie`
- `73438d1 interface : une ligne ouvrable au clic comme au clavier, une seule fois écrite`
- `d585769 journal : refus de console gardés par motif, sous une clé que le filtre des secrets laisse passer`
- `e057ce5 journal : la liaison dit si un jeton d'API est posé, sous une clé que le filtre des secrets laisse passer`
- `4bedc07 essais : « .. » au milieu d'un segment, taille hors bornes avant une valide, chaque motif de refus de console, base refermée à l'ouverture`

## Suivi du 2026-10-19 (2.1.11)
Un commit de correction : la garde des paramètres de requête devient commune à toutes les routes (`api.js`, après le gestionnaire). 22 essais du service, verts ; retirer la garde fait échouer « paramètres : un paramètre inconnu est refusé ». Surface publique inchangée.

## Suivi du 2026-10-19 (2.1.12)
Deux commits de fonction (plein écran qui remplit l'écran ; VM ajustée à la fenêtre) et la version. 22 essais du service, verts ; parcours du navigateur : les 28 vérifications de l'écran et de la console, et 14 nouvelles (refus en « std » dit une fois, passage en VirtIO-GPU, taille suivie à l'ouverture, au redimensionnement et en plein écran, image agrandie jusqu'aux bords sans ajustement, souris au bon pixel dans les bandes), toutes vertes. Surface publique : un champ ajouté (`ajustement` de `…/acces`, `vgaSuivant` de la fiche), rien de changé.

## Suivi du 2026-10-19 (2.1.13)
Deux commits (qualité nette ; borne de trame selon le sens) et la version. 23 essais du service, verts ; parcours du navigateur : 28 + 17 vérifications (trois nouvelles sur un écran ×2 : VM aux pixels réels, plein écran, option coupée), vertes. Surface publique inchangée.

## Suivi du 2026-10-19 (2.1.14)
Un commit d'interface et la version. 23 essais verts ; parcours du navigateur 28 + 20 vérifications (taille fixe affichée, bouton dans la barre), vertes.

## Suivi du 2026-10-19 (2.1.15)
Trois commits (plein écran dans la fenêtre ; « fr-azerty » ; console série muette) et la version. 24 essais verts ; parcours du navigateur 28 + 20 + 10 vérifications (mode fenêtre, Échap dans la VM, aide de la console muette, activation par l'agent, invite qui répond), vertes. L'exécution par l'agent est factorisée (`executer`, partagée par le clavier et la console) au lieu d'être recopiée.

## Suivi du 2026-10-19 (2.1.16)
Un commit d'interface et la version. 24 essais verts ; parcours du navigateur 28 + 20 + 13 vérifications (fenêtre à part : seulement l'écran, à sa taille, barre flottante, fermeture), vertes.

## Suivi du 2026-10-19 (2.1.17)
Un commit d'interface et la version. 24 essais verts ; parcours du navigateur 28 + 20 + 16, verts deux fois de suite.

## Suivi du 2026-10-19 (2.1.18)
Trois commits d'interface et la version. 24 essais verts ; parcours du navigateur 28 + 23 + 16 (plafond 4K, retour à 1280 × 800 sans réajustement, réveil proposé), verts deux fois de suite.

## Suivi du 2026-10-20 (2.2.0)
Deux fonctions demandées (images ISO, suppression d'une machine), le socle 7a14615 embarqué, en commits d'un sujet. Comportement existant inchangé : aucune route ni aucun schéma existants modifiés, la suite de 2.1.18 passe telle quelle ; 26 essais du service (dont deux nouveaux, ISO et suppression) et 76 du socle, verts. Style du dépôt repris : routes déclarées dans `src/api.js` avec leur rôle et leur schéma, appels à Proxmox par `chemin()` et `pve()`, erreurs `ErreurHttp` dites en clair ; deux modules neufs (`src/sortie.js`, `src/images.js`) parce que l'envoi et l'importation partagent un chemin que `src/api.js` ne doit pas porter ; aides du socle reprises (`dialogue`, `renforcer`, et `confirmerIdentite` ajoutée au socle pour la confirmation dans le dialogue de suppression). 22 cassures volontaires des nouvelles barrières (nom recopié, machine arrêtée, confirmation fraîche et à usage unique, journal, signature d'image, taille, somme, nom, adresse publique, IPv6 portant une IPv4, redirection revérifiée, https, longueur de la somme, rôle des importations, flux trop long, volume hors stockage, image tenue par une VM, conteneur sans lecteur), toutes détectées ; une seule mutation équivalente écartée (retirer `renfort: true` de la suppression, que la confirmation à usage unique couvre déjà). Balayage B.5 : un bandeau de section ajouté puis remis en phrase ; les autres résultats sont ceux de 2.1.18.

## Suivi du 2026-10-20 (2.3.0)
Créer une VM et nommer une image, en commits d'un sujet (serveur puis interface pour chacune, parcours, documentation). Comportement existant inchangé : l'inventaire des images gagne un champ (`alias`), aucune route existante ne change. Style du dépôt repris : la configuration d'une VM neuve est une fonction pure exportée (`configurationNeuve`), le reste dans les routes, avec `chemin()`, `pve()`, `ErreurHttp` ; le dialogue reprend `dialogue`, les champs étiquetés et les vues segmentées de la page. 14 cassures volontaires (ressources, stockage, place, pont, image, démarrage, renfort, rôle des options, journal, échec de tâche, motif et nettoyage du nom, nœud du nom), toutes détectées ; la quatorzième (échec de la tâche de création) passait d'abord inaperçue et a donné son essai.

## Verification (chapter 49)
- [x] Full suite passes and matches the baseline — les 83 essais de la référence, verts avant et après la passe, relancés à la génération de ce fichier ; delta 2.1 : 88 essais (21 du service, 67 du socle), verts sur l’arbre final
- [x] Public API diff empty — inventaire de la surface publique identique ligne à ligne ; delta 2.1 : ajouts seuls, aucune route ni aucun schéma existants changés (« Behaviour freeze »)
- [x] Characterisation tests deleted after use — aucun n’a été écrit
- [x] Read-aloud test passed — les 5 fichiers de code touchés par la passe, relus aux endroits touchés, autour de chaque fonction dont une instruction a changé ; delta 2.1 : les fichiers touchés par les commits de l’audit (`src/api.js`, `src/clavier.js`, `src/main.js`, `web/app.js`, `web/ecran.js`), relus de la même façon
- [x] Blind-comparison test passed — les passages touchés, commentaires compris, ont la forme de ceux qui les entourent et du socle : même langue, phrases courtes, raisons plutôt que descriptions
- [x] Commit history: one concern per commit, repository style, no attribution trailers
- [x] REQ-CODE-001 to REQ-CODE-006 all PASS

## Suivi du 2026-10-20 (2.4.0)

Étiquettes : une seule fonction `etiqueter` sert les quatre genres et l'ancienne route `/api/isos/nom`, gardée pour les clients d'avant. Les interfaces quittent la page Nœuds pour une page Réseau. Comportement d'avant inchangé : 28 essais d'avant verts, un seul ajusté (le champ `alias` ajouté à l'état de la grappe).

## Suivi du 2026-10-20 (2.5.0)

Duplication : une route, un dialogue partagé par la fiche (menu ⋯) et l'onglet Instantanés. 29 essais d'avant verts sans retouche.

## Suivi du 2026-10-20 (2.6.0)

Battement des connexions écran et console, reprise de l'écran au retour. Les 30 essais d'avant restent verts sans retouche.

## Suivi du 2026-10-20 (2.7.0)

Verr. Maj de l'invité aligné sur les voyants annoncés par QEMU. Les 31 essais restent verts sans retouche.

## Suivi du 2026-10-20 (2.8.0)

Taille de l'écran : agrandir seulement, rapetisser à la demande, revenir à la plus grande taille vue ; voyant Verr. Maj. Les 31 essais restent verts sans retouche.

## Suivi du 2026-10-20 (2.9.0)

Ouverture de l'écran refaite jusqu'à la première image ; plein écran rempli. Les 31 essais restent verts sans retouche.

## Suivi du 2026-10-21 (2.10.0)

Décodeur Tight dans le client d'écran, sans dépendance (zlib par DecompressionStream, JPEG par createImageBitmap). Le faux Proxmox parle Tight comme QEMU. Les 31 essais restent verts sans retouche.

## Suivi du 2026-10-21 (2.11.0)

Inflate maison à la place de DecompressionStream, double tampon de l'écran, frappe cadencée. Les 31 essais d'avant restent verts sans retouche ; un essai ajouté.

## Suivi du 2026-10-21 (2.12.0)

« Qualité nette » coupée par défaut, retour de taille, frappe plus lente. Les 32 essais restent verts sans retouche.

## Suivi du 2026-10-21 (2.13.0)

Barre du plein écran cachée, montrée au bord gauche. Les 32 essais restent verts sans retouche.

## Suivi du 2026-10-21 (2.14.0)

Sonde d'image au retour, reprise après la fenêtre à part. Les 32 essais restent verts sans retouche.

## Suivi du 2026-10-21 (2.15.0)

Écrans gardés en continu, reconnexion sans écran noir. Les 32 essais restent verts sans retouche.

## Suivi du 2026-10-21 (2.16.0)

Repeint depuis l'image hors écran, taille sans noir. Les 32 essais restent verts sans retouche.

## Suivi du 2026-10-21 (2.17.0)

Taille de la VM : suit la fenêtre dans les deux sens. Les 32 essais restent verts sans retouche.
