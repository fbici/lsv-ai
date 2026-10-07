# LSV.ai — Studio Viral v3.3

Application créative web : **Images · Vidéos · Chat IA · Motion · Projects · Library**.

Le public n'utilise que **LSV.ai** : ni clé API à saisir, ni nom de fournisseur,
ni endpoint, ni console de debug. L'application parle à **sa propre passerelle**,
qui appelle le fournisseur de génération côté serveur avec un secret.

```text
Navigateur LSV.ai  →  LSV API Gateway (Supabase Edge)  →  Fournisseur de génération
   (aucun secret)        (clé injectée ici)                 (infra invisible)
```

Extensions en place autour de l'application (non refaite) :

- **LSV API Gateway** — proxy sécurisé + quotas configurables ;
- **Comptes utilisateurs** — inscription/connexion dans l'app (Supabase Auth) ;
- **Analytics** anonymes et non bloquants ;
- **Back-office admin** (`/admin`) avec authentification réelle **et liste blanche** ;
- **Architecture GitHub-ready** (front statique + service serverless).

```text
LSV.ai
│
├── Application créative existante (design et workflows inchangés)
│   Images · Vidéos · Chat IA · Motion · Projects · Library
│   + section « Compte » (inscription / connexion / déconnexion)
│
├── LSV API Gateway     → supabase/functions/lsv-gateway
│   Clé fournisseur côté serveur · rate limit · quotas · erreurs sanitizées
│
├── Analytics           → analytics/analytics.js
│
└── Back-office Admin   → /admin
    Connexion · Inscription · Liste blanche · Dashboard · Visiteurs
    Images · Vidéos · Chat · Motion · Activité · Erreurs · Paramètres
```

---

## 1. Architecture

```text
Navigateur (GitHub Pages — statique, aucun secret)
   │
   ├── index.html            application LSV.ai (publique)
   │      ├── génération      → LSV API Gateway   (POST /v1/…)
   │      └── analytics/analytics.js → POST asynchrone (non bloquant)
   │
   └── admin/                back-office (page publique, données protégées)
          └── Supabase JS SDK
                 │
                 ▼
        Supabase (service externe)
        ├── Edge Function : LSV API Gateway  →  clé fournisseur (secret serveur)
        ├── Auth          : e-mail + mot de passe → JWT (vérifié côté serveur)
        └── Postgres      : table analytics_events + Row Level Security
                 │
                 ▼
        Dashboard admin (lecture = compte authentifié uniquement)
```

### Arborescence

```text
lsv-ai/
│
├── index.html                 # Application LSV.ai (Gateway + UI publique)
│
├── analytics/
│   └── analytics.js           # Module Analytics indépendant et tolérant aux pannes
│
├── shared/
│   └── config.js              # URL Supabase + clé anon + URL LSV Gateway
│
├── admin/
│   ├── index.html             # Back-office (connexion + dashboard)
│   ├── admin.css              # Design admin (identité LSV.ai)
│   └── admin.js               # Auth, chargement, agrégats, graphiques
│
├── supabase/
│   ├── schema.sql             # Table + RLS + indexes (à exécuter une fois)
│   └── functions/lsv-gateway/
│       ├── index.ts           # Point d'entrée Edge Function (Deno)
│       └── core.mjs           # Cœur de la passerelle (testable sous Node)
│
├── tests/
│   ├── nonreg.test.js         # Non-régression LSV.ai + unités Analytics
│   ├── public.test.js         # Interface publique + sécurité (§25-§26)
│   ├── gateway.test.mjs       # Passerelle : routage, quotas, sanitisation
│   └── admin.test.js          # Scénarios d'accès admin
│
├── package.json               # Scripts de test (devDependency : jsdom)
├── .env.example               # Modèle de variables (aucun secret réel)
├── .gitignore
└── README.md
```

---

## 2. Changements de cette version : Gateway + comptes

### 2.1 Supprimé de l'interface publique

| Supprimé | Détail |
|---|---|
| Section / champ **clé API** | carte « Clé API Agnes », `api-input`, `api-save`, `api-status`, `api-mini`, boutons Enregistrer / Supprimer, statut de clé |
| **Stockage de clé** | `localStorage.lsv4_api_key`, `StorageService.get/set/clearApiKey`, gating des boutons sur la présence d'une clé |
| **Infos techniques visibles** | carte « État du système » : endpoint amont + noms de modèles, lien « Obtenir une clé API » |
| **Console LSV** | panneau de debug en bas de page, boutons Copier / Effacer / Collapse, logs visibles |
| **Appels directs au fournisseur** | `API_BASE` / `POLL_BASE` pointent désormais vers la Gateway |
| **En-têtes `Bearer sk-…`** | 6 en-têtes `Authorization` supprimés (le navigateur n'a plus aucune clé de génération) |
| **Erreurs brutes** | les toasts n'affichent plus `e.message` : uniquement `Utils.friendlyError()` |

Les logs internes restent en mémoire (`window.LSV.debug.entries`, bornés à 500) :
visibles pour le développeur, jamais pour l'utilisateur.

### 2.2 Conservé strictement

Design, couleurs, typographie, animations, structure, 14 onglets, galerie,
prompts, paramètres de génération, modèles, retries, batching, storyboards,
workflows, verrous, projets, bibliothèque, analytics et back-office : **inchangés**
(vérifié par `tests/nonreg.test.js` : structure + `body.innerHTML` identiques à
l'original, hors blocs volontairement supprimés).

### 2.3 Migration front → Gateway

Aucun service n'a été réécrit : `ImageService`, `VideoService`, `ChatService`,
`EnhancerService`, `BatchView` appellent les mêmes chemins, seule l'origine a
changé.

```js
// shared/config.js
LSV_GATEWAY_URL: 'https://<ref>.supabase.co/functions/v1/lsv-gateway'

// index.html
API_BASE  = LSV_GATEWAY_URL + '/v1'
POLL_BASE = LSV_GATEWAY_URL + '/agnesapi'
```

La Gateway rejoue la requête vers le fournisseur en ajoutant **côté serveur** :
`Authorization: Bearer <AGNES_API_KEY>` (secret), et retire tout `Authorization`
venu du client.

### 2.4 Déployer la Gateway

```bash
npm install -g supabase      # ou : npx supabase …
supabase login
supabase link --project-ref <votre-ref>

# 1) déployer la fonction
supabase functions deploy lsv-gateway --no-verify-jwt

# 2) injecter le SECRET (jamais dans le dépôt)
supabase secrets set AGNES_API_KEY=sk-…
```

> `--no-verify-jwt` : la Gateway s'appuie sur ses propres contrôles (CORS par
> origine, rate limit, quotas, secret côté serveur). Si vous préférez imposer
> un JWT de projet valide **au niveau de la plateforme**, redéployez sans ce
> drapeau : le front envoie déjà le JWT `anon` Supabase dans `Authorization`.

Ensuite, `shared/config.js` → `LSV_GATEWAY_URL` = `https://<ref>.supabase.co/functions/v1/lsv-gateway`.

Tests locaux de la passerelle :

```bash
npm run serve                 # http://localhost:4173
npx supabase functions serve  # gateway en local (optionnel)
```

### 2.5 Quotas et anti-abus (§15-§16)

Variables d'environnement de la fonction (Supabase → **Edge Functions → Secrets**) :

| Variable | Rôle | Défaut |
|---|---|---|
| `AGNES_API_KEY` | **secret** du fournisseur, injecté côté serveur | — (requis) |
| `AGNES_API_BASE` | base amont (secret de configuration) | valeur interne |
| `ALLOWED_ORIGINS` | origines CORS autorisées | GitHub Pages + localhost |
| `RATE_LIMIT_PER_MIN` | requêtes / minute / IP + / visiteur | `10` |
| `IMAGE_LIMIT` | images / jour / visiteur | `0` = illimité |
| `VIDEO_LIMIT` | vidéos / jour / visiteur | `0` = illimité |
| `CHAT_LIMIT` | messages / jour / visiteur | `0` = illimité |
| `MOTION_LIMIT` | motions / jour / visiteur | `0` = illimité |
| `MAX_BODY_BYTES` | taille max d'une requête | `20` Mo |

Le polling vidéo n'est pas compté comme une génération. Atteindre une limite
renvoie `429` avec un message générique :

> Vous avez atteint la limite temporaire de génération. Veuillez patienter avant
> de réessayer.

Les limites **Agnes** restent celles du compte fournisseur ; les limites **LSV**
ne protègent que notre passerelle.

### 2.6 Comptes utilisateurs + liste blanche admin (nouveau)

| Ajout | Détail |
|---|---|
| **Section « Compte »** | panneau de droite : `Se connecter / S'inscrire`, formulaire e-mail + mot de passe, `Se déconnecter` |
| **Inscription** | Supabase Auth (`/auth/v1/signup`) — le mot de passe n'est envoyé qu'à Supabase |
| **Session** | jeton d'accès + rafraîchissement stockés sur l'appareil (`localStorage.lsv4_account`), jamais le mot de passe |
| **Liste blanche admin** | table `admin_emails` + fonction SQL `is_admin()` : seul un e-mail listé voit les statistiques |
| **Bouton back-office** | affiché dans l'app **uniquement** si l'e-mail connecté est dans la liste blanche |
| **Événements** | `account_created`, `account_signed_in` (sans e-mail, sans donnée personnelle) |

Un compte créé **n'ouvre rien par lui-même** : sans figure dans `admin_emails`,
le back-office affiche « Compte non autorisé » et le tableau de bord reste vide.

---

## 3. Installation locale

```bash
git clone <url-du-repo> lsv-ai
cd lsv-ai
npm install        # uniquement pour les tests (jsdom)
npm test           # 4 suites : non-régression, interface, gateway, admin
```

Ouvrir simplement `index.html` (double-clic) : l'application s'affiche et
navigue telle quelle. **La génération nécessite la Gateway déployée** (§2.4) ;
sans elle, les boutons de génération restent inactifs. **Sans configuration
Supabase, Analytics est inactif** et le back-office affiche la page de connexion
avec un message d'explication.

Pour servir en local :

```bash
npm run serve      # http://localhost:4173
```

---

## 4. Configuration Supabase (obligatoire pour Analytics + Admin)

### 4.1 Créer le projet

1. Aller sur <https://supabase.com> → **New project** (free tier suffit).
2. Choisir une région, noter le **database password** (jamais commité).

### 4.2 Créer la table et la sécurité

1. Dashboard → **SQL Editor** → **New query**.
2. Coller le contenu de `supabase/schema.sql` → **Run**.
   *(Base déjà créée ? exécuter `supabase/upgrade-admin-whitelist.sql`.)*
3. **Ajouter son e-mail administrateur** (décommenter la dernière ligne du
   script, ou SQL direct) :

```sql
insert into public.admin_emails (email) values ('toi@exemple.com')
    on conflict (email) do nothing;
```

Ce script crée :

- la table `analytics_events` (insert anonyme autorisé, **lecture réservée aux
  comptes authentifiés et listés**, pas de UPDATE/DELETE anon) ;
- la table `admin_emails` (liste blanche, **invisible côté client** : RLS sans
   policy + droits révoqués sur `anon` et `authenticated`) ;
- la fonction SQL `is_admin()` (légitimée par le JWT de session) ;
- une **liste blanche d'événements** (un inconnu ne peut pas injecter de n'importe
  quel événement) ;
- un contrôle de taille de payload (< 4 Ko) ;
- les index nécessaires.

> ⚠️ **Sans e-mail dans `admin_emails`, personne — tien compris — n'accède aux
> statistiques.** Le back-office affiche « Compte non autorisé ».

### 4.3 Autoriser les inscriptions (comptes utilisateurs)

1. Dashboard → **Authentication** → **Sign In / Providers** → **Email** :
   provider **activé**, et **Enable Sign Ups activé** (le public peut créer un
   compte depuis la section « Compte » de l'app).
2. **Confirm email** :
   - *ON* (défaut) : l'inscrit doit cliquer le lien reçu par e-mail avant de se
     connecter — recommandé ;
   - *OFF* : connexion immédiate (utile pour tester rapidement).
3. Créer ton compte : soit depuis l'app (section « Compte »), soit depuis
   l'écran `/admin/` (bouton **Créer un compte**), puis **ajouter son e-mail
   dans `admin_emails`** (§4.2).
4. Pour ouvrir l'accès à quelqu'un d'autre : même procédure (compte + ligne SQL).
   Pour le retirer : `delete from public.admin_emails where email = '…';`

Les comptes et leurs e-mails restent visibles uniquement dans
**Authentication → Users** (Supabase) : jamais dans l'app ni dans Git.

### 4.4 Récupérer les identifiants publics

Dashboard → **Project Settings** → **API** :

- **Project URL** → `SUPABASE_URL`
- **anon / public** key → `SUPABASE_ANON_KEY`

### 4.5 Les renseigner

Éditer `shared/config.js` :

```js
window.LSV_CONFIG = {
    SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOi...',
    LSV_GATEWAY_URL: 'https://xxxxxxxx.supabase.co/functions/v1/lsv-gateway'
};
```

> Ces deux valeurs sont **publiques par conception** (clé `anon` destinée à être
> embarquée dans le navigateur). Ce ne sont **pas** des secrets : toute la
> sécurité repose sur les politiques RLS et sur Supabase Auth.
> La `service_role` key et le mot de passe base de données ne doivent **jamais**
> apparaître dans le dépôt (`.env.example` le rappelle).

---

## 5. Comptes & back-office `/admin`

### 5.1 S'inscrire / se connecter (application publique)

Dans le panneau de droite → section **Compte** :

| Situation | Résultat |
|---|---|
| Non connecté | bouton `Se connecter / S'inscrire` (formulaire fermé par défaut) |
| `Créer un compte` | e-mail + mot de passe (6 car. min.) → `signUp` |
| Confirmation e-mail activée | message « confirme ton e-mail puis connecte-toi » |
| Connecté | e-mail affiché + `Se déconnecter` |
| E-mail **dans** `admin_emails` | bouton `Ouvrir le back-office` en plus |
| E-mail **hors** liste blanche | aucun accès au back-office proposé |

Le mot de passe ne va **que** vers Supabase Auth ; l'app garde seulement une
session courte (jeton d'accès + rafraîchissement) dans `localStorage`.
Aucune donnée personnelle (ni e-mail, ni mot de passe) n'est envoyée aux
Analytics.

### 5.2 Back-office `/admin`

URL : `https://<votre-site>/admin/`

```text
/admin
   ↓
Page de connexion  (ou « Créer un compte »)
   ↓
Supabase Auth (vérification côté serveur — hachage du mot de passe)
   ↓
is_admin()  →  e-mail présent dans public.admin_emails ?
   ↓ oui                                    ↓ non
JWT de session                       « Compte non autorisé »
   ↓                                      (aucune donnée)
Dashboard (lectures soumises à la RLS)
```

Comportements attendus :

| Situation | Résultat |
|---|---|
| Non authentifié | ❌ dashboard inaccessible, page de connexion |
| Mauvais identifiants | ❌ « Identifiants incorrects » |
| Compte créé mais **hors liste blanche** | ❌ « Compte non autorisé : cet accès est réservé aux e-mails de la liste blanche. » |
| Script SQL non exécuté (`is_admin` absent) | ❌ message « exécuter supabase/upgrade-admin-whitelist.sql » |
| Session expirée | ❌ retour automatique à la connexion |
| URL connue sans compte | ❌ aucune donnée affichée (RLS refuse) |
| Supabase/CDN indisponible | ❌ message d'erreur, aucun crash |

### 5.3 Pages du dashboard

- **Vue d'ensemble** — visiteurs, sessions, images, vidéos, chat, erreurs ;
  graphique d'activité quotidienne ; utilisation par fonctionnalité ;
  activité récente ; détail visiteurs (nouveaux / récurrents).
- **Images / Vidéos / Chat / Motion** — compteurs, taux de succès, répartitions
  (modèle, résolution, ratio, style, mode, durée, segments), graphiques,
  tables de détail.
- **Activité** — flux chronologique filtrable (images / vidéos / chat / erreurs),
  sans aucune donnée privée.
- **Erreurs** — agrégation par fonctionnalité + type + signature, occurrences,
  dernière occurrence, graphique journalier.
- **Paramètres** — état de la connexion, session, fréquence d'actualisation,
  déconnexion.

Périodes : **Aujourd'hui · 7 jours · 30 jours · Tout**.

---

## 6. Analytics

### 6.1 Événements collectés

| Événement | Déclencheur | Propriétés |
|---|---|---|
| `page_view` | chargement de LSV.ai | path, lang, mobile |
| `tab_view` | changement d'onglet | tab |
| `image_generated` | image générée | model, size, ratio, style, mode, source, duration_s |
| `video_generated` | vidéo générée | model, duration, mode, segments, frames, ratio, size, source |
| `chat_used` | message envoyé | status (success/error) |
| `project_created` | projet créé | type |
| `enhancer_used` | prompt amélioré | status, type, style |
| `generation_error` | échec de génération | feature, detail |
| `motion_generated` | réservé (module à venir) | — |
| `account_created` | compte créé (app ou `/admin`) | — |
| `account_signed_in` | connexion d'un compte | — |

### 6.2 Ce qui n'est **jamais** envoyé

- prompts, contenus de conversation ;
- URLs d'images / vidéos ;
- clés API, tokens, Authorization ;
- noms de fichiers, data-URI ;
- **e-mails, mots de passe, identifiants de compte** : les événements
  `account_*` ne portent aucune propriété (les comptes restent dans Supabase).

Un assainisseur (`cleanProps`) filtre les clés interdites, tronque les chaînes à
200 caractères et masque les motifs `sk-…`, `Bearer …`, `eyJ…`.

### 6.3 Identifiants

- `visitor_id` : identifiant aléatoire stocké en `localStorage`
  (non lié à une personne, non réversible).
- `session_id` : identifiant de session `sessionStorage`, expirant après
  30 min d'inactivité.

Le dashboard parle de **visiteurs / appareils / sessions**, pas d'utilisateurs.

### 6.4 Tolérance aux pannes

```js
try { LSVAnalytics.track('image_generated', {...}); } catch (e) { /* inert */ }
```

- envoi **asynchrone** (3 s de regroupement, file d'attente locale limitée) ;
- aucun `await` bloquant dans les workflows ;
- en cas d'échec réseau : 3 tentatives puis abandon silencieux ;
- si `analytics.js` est absent : un shim rend `track()` inerte ;
- **si Supabase tombe, LSV.ai continue de fonctionner normalement.**

---

## 7. Déploiement GitHub

### 7.1 Pousser le code

```bash
git init
git add .
git commit -m "LSV.ai v3.1 : Analytics + back-office admin sécurisé"
git branch -M main
git remote add origin https://github.com/<vous>/lsv-ai.git
git push -u origin main
```

Vérifier avant commit :

```bash
git status                 # aucun .env, aucun node_modules
git grep -i "service_role" # ne doit rien trouver
```

### 7.2 Activer GitHub Pages

1. Repository → **Settings → Pages**.
2. **Source** : `Deploy from a branch`.
3. **Branch** : `main` / `(root)` → **Save**.
4. Le site est disponible sur `https://<vous>.github.io/lsv-ai/`.

> GitHub Pages est **strictement statique** : il ne peut ni stocker des
> statistiques ni vérifier un mot de passe. C'est pour cela que l'authentification
> et le stockage sont délégués à Supabase — aucune tentative de contour en
> JavaScript côté client.

### 7.3 Après le déploiement

1. **Déployer la LSV API Gateway** (§2.4) et injecter `AGNES_API_KEY`.
2. Remplir `shared/config.js` avec les vraies valeurs, committer, push.
3. **Exécuter le SQL** (§4.2) puis **ajouter son e-mail dans `admin_emails`**.
4. Ouvrir `https://<vous>.github.io/lsv-ai/` → générer une image (doit passer
   par `…/functions/v1/lsv-gateway/v1/images/generations`).
5. Ouvrir `https://<vous>.github.io/lsv-ai/admin/` → se connecter, vérifier
   que le dashboard se remplit (sinon : « Compte non autorisé » → §4.2).

**Note sur les chemins** : tous les liens sont **relatifs** (`./admin/`,
`../shared/config.js`) → le site fonctionne aussi bien à la racine que dans
un sous-dossier GitHub Pages (`/lsv-ai/`).

---

## 8. Variables et secrets

| Fichier | Contenu | Commité ? |
|---|---|---|
| `shared/config.js` | URL Supabase + clé `anon` + URL Gateway (publics) | ✅ oui |
| `.env.example` | modèle commenté | ✅ oui |
| `.env` | éventuel, hors dépôt | ❌ non (`.gitignore`) |
| `AGNES_API_KEY` | **secret de la Gateway** (Supabase Secrets) | ❌ non |
| `service_role` key | **jamais** utilisée par le front | ❌ non |
| Mot de passe base | uniquement dans Supabase | ❌ non |
| Mot de passe admin | uniquement dans Supabase Auth (haché) | ❌ non |

La clé du fournisseur de génération n'existe **que** dans les secrets de la
fonction : jamais dans `index.html`, `admin/`, `analytics/`, `shared/`,
`localStorage` ni dans Git (`tests/public.test.js` le vérifie).

---

## 9. Tests

```bash
npm test        # 191 assertions (203 avec ORIG=… voir plus bas)
```

**`tests/nonreg.test.js`** (41 assertions, **53 avec `ORIG`**) — non-régression

- structure HTML et `body.innerHTML` identiques à l'original, hors blocs
  volontairement supprimés (clé API, console, infos fournisseur) **et hors
  section « Compte » ajoutée** —
  `ORIG=/chemin/index.original.html npm test` ;
- navigation sur les 14 onglets sans exception ;
- génération d'image simulée **sans aucune clé** : succès + échec, requête
  envoyée à la Gateway, `Authorization` = JWT anon LSV, aucun `sk-` ;
- génération de vidéo simulée (création de tâche + polling) : succès ;
- Chat IA simulé (repli JSON) : conversation, réponse rendue ;
- sanitisation Analytics, config absente, panne réseau, module absent.

**`tests/public.test.js`** (66 assertions) — interface publique + sécurité

- éléments techniques absents (champ/statut/bouton de clé, console LSV) ;
- scan du contenu public contre `Agnes`, `agnes-*`, `apihub`, `Bearer`, `sk-`,
  `Authorization`, `Console LSV`, `Endpoint`, `Polling`, `Token`… ;
- génération sans clé : rien en `localStorage`, requête vers la Gateway ;
- erreur amont → toast générique (aucun code HTTP, endpoint, jeton) ;
- aucun `sk-` dans `index.html` ni dans les fichiers publics ;
- admin : pas de lien public, pas de mot de passe en dur, RLS en lecture
  authentifiée **et listée** uniquement (`is_admin`) ;
- comptes : section fermée par défaut, échec de connexion → message générique,
  connexion OK → e-mail affiché, back-office masqué hors liste blanche,
  aucune donnée secrète en `localStorage`.

**`tests/gateway.test.mjs`** (36 assertions) — passerelle

- routage (y compris préfixe `/functions/v1/lsv-gateway`), injection de la clé
  serveur, rejet de l'authorization client ;
- CORS (origine autorisée / interdite / preflight) ;
- rate limit 60 s avec `Retry-After`, quotas journaliers + réinitialisation ;
- erreurs amont sanitisées (401/500/réseau → message générique, aucun détail) ;
- clé absente → 503, aucun secret dans aucune réponse.

**`tests/admin.test.js`** (48 assertions)

- configuration absente / non authentifié → dashboard inaccessible ;
- mauvais identifiants → accès refusé ;
- identifiants valides → dashboard + KPI + graphiques rendus ;
- 8 pages + 4 plages temporelles sans exception ;
- session expirée (RLS) → retour connexion ; déconnexion → données effacées ;
- **inscription** depuis l'écran de connexion (mode, libellés, création →
  dashboard si listé, confirmation e-mail si requise) ;
- **compte hors liste blanche** → « Compte non autorisé », zéro donnée ;
- aucun mot de passe codé en dur, aucune `service_role`.

---

## 10. Limites connues (volontaires)

- **Comptes « légers »** : inscription/connexion + liste blanche pour le
  back-office, mais pas encore d'espace personnel de synchronisation (projets /
  historique dans le cloud), pas de rôles multiples, pas d'abonnement ni de
  paiement.
- **Motion Control** n'est pas encore implémenté dans LSV.ai : le dashboard
  compte les ouvertures de l'onglet ; `motion_generated` est prêt à l'emploi.
- Le volume est pensé pour quelques milliers d'événements/jour (limite de 20 000
  lignes lues par requête). Au-delà, ajouter une agrégation serveur (vue SQL).
- L'insertion anonyme est ouverte (nécessaire pour un site public) : liste
  blanche d'événements + quotas Gateway en place ; en cas d'abus, ajouter un
  rate-limit Cloudflare devant Pages.
- **Rate limit / quotas Gateway en mémoire** : efficaces contre les rafales,
  mais remis à zéro à chaque redémarrage de l'isolate Edge (plusieurs isolate
  = quota par isolate). Si LSV.ai grandit, brancher un store Supabase
  (table + service role) dans `core.mjs`.
- **Noms de modèles encore présents dans `index.html`** (constantes `MODEL_*`) :
  ils ne sont jamais affichés à l'écran (testé), mais restent lisibles dans le
  source. Pour les retirer aussi, les faire injecter par la Gateway.
- CSS des blocs supprimés (`.api-mini`, `.debug*`) conservé mais inutilisé :
  aucun rendu, purge possible ultérieurement.

---

## 11. LSV.ai — accès rapide

L'application est prête pour le public : ouvrir `index.html` et utiliser
Images, Vidéos, Chat IA, Motion, Storyboard, Workflows, Cohérence, Batch,
Projets et Bibliothèque **sans saisir aucune clé**. Seule condition : la
Gateway (§2.4) doit être déployée, sinon les boutons de génération restent
inactifs (et non pas « cassés »).
