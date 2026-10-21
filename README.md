# LSV.ai — Studio Viral v3.16.8

Application créative web : **Images · Vidéos · Chat IA · Motion · Projects · Library · LSV Studio (montage vidéo)**.

Le public n'utilise que **LSV.ai** : ni clé API à saisir, ni nom de fournisseur,
ni endpoint, ni console de debug. L'application parle à **sa propre passerelle**,
qui appelle le fournisseur de génération côté serveur avec un secret.

**Création = compte** : toute génération (images, vidéos, chat, enhancer, batch)
exige un **compte connecté** (inscription gratuite, page de connexion plein
écran ouverte depuis la section « Compte »). Un
visiteur non connecté conserve l'accès à la consultation, mais rien n'est envoyé
ni consommé.

```text
Navigateur LSV.ai  →  LSV API Gateway (Supabase Edge)  →  Fournisseur de génération
   (aucun secret)        (clé injectée ici)                 (infra invisible)
```

Extensions en place autour de l'application (non refaite) :

- **LSV API Gateway** — proxy sécurisé + quotas configurables ;
- **Comptes utilisateurs** — inscription/connexion dans l'app (Supabase Auth) ;
- **Analytics** anonymes et non bloquants ;
- **Back-office admin** (`/admin`) avec authentification réelle **et liste blanche** ;
- **Contact** (`/contact/` + formulaire du créateur sur `/a-propos/`) via la
  Edge Function `lsv-contact` (§2.14) ;
- **Architecture GitHub-ready** (front statique + service serverless).

```text
LSV.ai
│
├── Application créative existante (design et workflows inchangés)
│   Images · Vidéos · Chat IA · Motion · Projects · Library
│   + section « Compte » (page de connexion plein écran : inscription / connexion / déconnexion)
│
├── LSV API Gateway     → supabase/functions/lsv-gateway
│   Clé fournisseur côté serveur · rate limit · quotas · erreurs sanitizées
│   Image de référence (§2.15) : URL de bibliothèque → image encodée amont
│
├── Contact             → supabase/functions/lsv-contact
│   /contact/ (marque) + /a-propos/ (créateur) · 2 canaux · e-mails Brevo/Resend
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
├── index.html                 # SQUELETTE HTML uniquement (~1 200 lignes) :
│                              #   head (SEO) + markup accueil/dashboard + liens
│                              #   vers styles/ et scripts/ — aucun CSS ni JS
│                              #   applicatif en dur dedans
│
├── styles/                    # Feuilles de style (une responsabilité chacune)
│   ├── base.css               #   reset, variables CSS, barre haute
│   ├── sidebar.css            #   navigation latérale + responsive
│   ├── studio.css             #   dashboard de création (chat, cards, fields…)
│   ├── account.css            #   modale de connexion / inscription
│   ├── welcome.css            #   page d'accueil des visiteurs + footer
│   ├── contact.css            #   pages Contact / À propos (créateur, formulaires, footer)
│   └── views.css              #   projets, bibliothèque, historique, mobile-nav
│
├── scripts/                   # Application JS (scripts classiques, dans l'ordre)
│   ├── constants.js           #   GATEWAY_URL + styles d'enhancer
│   ├── core.js                #   Utils, Storage, Projects, Assets, History,
│   │                          #   Conversation, Lock, Debug, Timing, WakeLock
│   ├── account.js             #   Gateway, AccountService, AccountView, WelcomeView
│   ├── media.js               #   Provider, Prompt, Image, Video, File, Runtime,
│   │                          #   UIState, Enhancer
│   ├── ui.js                  #   contrôleur UI (toasts, panneaux, rendu global)
│   ├── chat.js                #   ChatService, ChatActions, ChatView
│   ├── views.js               #   Dashboard, Projets, Bibliothèque, Historique,
│   │                          #   Avancé, Enhancer, Storyboard, Workflows,
│   │                          #   Verrous, Batch
│   └── handlers.js            #   Handlers + restauration + init + window.LSV
│
├── analytics/
│   └── analytics.js           # Module Analytics indépendant et tolérant aux pannes
│
├── shared/
│   ├── config.js              # URL Supabase + clé anon + URL LSV Gateway
│   └── contact.js             # envoi des formulaires → Edge Function lsv-contact
│
├── admin/
│   ├── index.html             # Back-office (connexion + dashboard)
│   ├── admin.css              # Design admin (identité LSV.ai)
│   └── admin.js               # Auth, chargement, agrégats, graphiques
│
├── studio/                   # LSV Studio — montage vidéo 100 % local (§12)
│   ├── index.html            #   UI de l'éditeur
│   ├── main.js               #   bootstrap
│   ├── studio.css            #   design de l'éditeur
│   ├── core/ render/ storage/ ui/   # modules (16 fichiers)
│
├── a-propos/                 # Page « À propos » (URL propre : /a-propos/)
│   └── index.html            #   LeStudioViral · Salaou Souleyman · section
│                             #   créateur · formulaire personnel · boutiques
├── contact/                  # Page Contact de la marque (URL propre : /contact/)
│   └── index.html            #   Formulaire → canal « site », footer 4 colonnes
├── assets/showcase/          # 1.jpg…6.jpg + V1.mp4 + V2.mp4 (créations réelles) + replis SVG
├── lsv.jpg                   # Logo officiel de la marque
├── robots.txt               # SEO : robots autorisés, /admin/ interdit, sitemap
├── sitemap.xml              # SEO : plan du site (studio + à propos)
│
├── supabase/
│   ├── schema.sql             # Tables + RLS + indexes (à exécuter une fois)
│   ├── upgrade-admin-whitelist.sql  # Migration : liste blanche admin
│   ├── upgrade-profiles.sql   # Migration : noms des comptes (profiles)
│   ├── upgrade-activity-logs.sql    # Migration : user_id + admin_logs
│   ├── upgrade-quotas.sql     # Migration : quotas journaliers + usage_counters
│   ├── upgrade-multi-key.sql  # Migration : clés du fournisseur par outil
│   ├── upgrade-contact.sql    # Migration : contact_messages + RPC submit_contact
│   ├── email-confirm-signup.html    # Modèle d'e-mail « confirme ton compte »
│   ├── email-reset-password.html    # Modèle d'e-mail « mot de passe oublié »
│   ├── functions/lsv-gateway/
│   │   ├── index.ts           # Point d'entrée Edge Function (Deno)
│   │   └── core.mjs           # Cœur de la passerelle (testable sous Node)
│   └── functions/lsv-contact/
│       ├── index.ts           # Point d'entrée (env + dépendances injectables)
│       ├── core.mjs           # Validation, anti-spam, routage des 2 canaux
│       └── templates.mjs      # Modèles d'e-mail (notification + accusé)
│
├── tests/
│   ├── nonreg.test.js         # Non-régression LSV.ai + unités Analytics
│   ├── public.test.js         # Interface publique + sécurité (§25-§26)
│   ├── gateway.test.mjs       # Passerelle : routage, quotas, sanitisation
│   ├── admin.test.js          # Scénarios d'accès admin
│   ├── studio.test.js         # LSV Studio (montage vidéo local)
│   └── contact.test.mjs       # Formulaires + Edge Function lsv-contact
│
├── package.json               # Scripts de test (devDependency : jsdom)
├── .env.example               # Modèle de variables (aucun secret réel)
├── .gitignore
└── README.md
```

---

## 2. Changements de version

Chaque §x.y documente une vague de travail. §2.13 = v3.13.0, §2.14 = v3.14.0,
§2.15 = v3.15.0, §2.16 = v3.16.0 à v3.16.5, §2.17 = v3.16.6, §2.18 = v3.16.7, §2.19 = v3.16.8.

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

# 2) donner la clé du fournisseur à la passerelle — 2 possibilités :
#    a) RECOMMANDÉ : back-office → Paramètres (§5.3) — une clé dédiée par
#       outil (images / vidéos / chat) + une clé partagée de secours (§2.12)
#    b) secret de la fonction (secours / usage CLI) :
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
| *(table `app_settings`)* | **clé du fournisseur + quotas journaliers, saisis dans le back-office** — prioritaires, relus toutes les 30 s | voir §2.11 |
| `AGNES_API_KEY` | **secret serveur de secours**, utilisé si la table est vide | — (recommandé) |
| `AGNES_API_BASE` | base amont (secret de configuration) | valeur interne |
| `ALLOWED_ORIGINS` | origines CORS autorisées | GitHub Pages + localhost |
| `RATE_LIMIT_PER_MIN` | requêtes / minute / IP + / visiteur | `10` |
| `MAX_CONCURRENT_PER_USER` | générations **simultanées** max par compte | `3` |
| `IMAGE_LIMIT` / `VIDEO_LIMIT` / `CHAT_LIMIT` / `MOTION_LIMIT` | **secours uniquement** si `app_settings` est injoignable — les quotas par compte de la base priment | `0` = illimité |
| `QUOTA_GLOBAL_DAILY` | **secours** : limite globale journalière | `0` = illimitée |
| `MAX_BODY_BYTES` | taille max d'une requête | `20` Mo |

Ordre de résolution de la clé côté serveur : **`app_settings` (saisie dans le
back-office)** → sinon **`AGNES_API_KEY` (secret)**. Une lecture groupée de la
table au plus toutes les 30 s et par isolate ; la valeur n'est jamais renvoyée
au navigateur. Les quotas journaliers suivent exactement le même chemin et se
règlent depuis **/admin → Limites et quotas**.

Le polling vidéo n'est pas compté comme une génération. Atteindre une limite
renvoie `429` avec un message générique :

> Vous avez atteint la limite temporaire de génération. Veuillez patienter avant
> de réessayer.

Les limites **Agnes** restent celles du compte fournisseur ; les limites **LSV**
ne protègent que notre passerelle.

### 2.6 Comptes utilisateurs + liste blanche admin (nouveau)

| Ajout | Détail |
|---|---|
| **Section « Compte »** | panneau de droite : `Se connecter / S'inscrire` → **page de connexion plein écran** (carte centrée, champs icônes + libellés, œil afficher/masquer, fermeture par le fond / `Échap`), formulaire **nom complet + e-mail + mot de passe**, `Se déconnecter` |
| **Inscription** | Supabase Auth (`/auth/v1/signup`) — le nom complet part dans `user_metadata`, le mot de passe va uniquement à Supabase |
| **Session** | jeton d'accès + rafraîchissement stockés sur l'appareil (`localStorage.lsv4_account`), jamais le mot de passe |
| **Liste blanche admin** | table `admin_emails` + fonction SQL `is_admin()` : seul un e-mail listé voit les statistiques |
| **Nom en base** | table `profiles` (`full_name`, `email`, `last_sign_in_at`) remplie par trigger à chaque inscription/connexion, affichée dans la page **Utilisateurs** du back-office |
| **Création = compte** | `AgnesProvider.fetch` + `ChatService.send` appellent `AccountView.ensure()` : sans compte, **aucune requête** de génération n'est émise (image, vidéo, chat, enhancer, batch) — le formulaire Compte s'ouvre avec le message « Connecte-toi à ton compte pour créer. » |
| **Bouton back-office** | affiché dans l'app **uniquement** si l'e-mail connecté est dans la liste blanche |
| **Clés du fournisseur** | back-office → **Paramètres** : une clé dédiée par outil (images / vidéos / chat) **plus** une clé partagée de secours → table `app_settings` (RLS : **liste blanche uniquement**, aucun droit pour `anon`) ; la Gateway choisit la bonne par requête, avec priorité sur le secret `AGNES_API_KEY` (§2.12) |
| **Événements** | `account_created`, `account_signed_in` (sans e-mail, sans donnée personnelle) |

Un compte créé **n'ouvre rien par lui-même** : sans figure dans `admin_emails`,
le back-office affiche « Compte non autorisé » et le tableau de bord reste vide.

### 2.7 Marque, page « À propos » & SEO (nouveau)

| Ajout | Détail |
|---|---|
| **`a-propos/`** | page publique de la marque **LeStudioViral** (URL propre `…/a-propos/`) : le fondateur **Salaou Souleyman** (développeur d'applications web & mobile, créateur de contenu), ses savoir-faire, ses boutiques et le studio LSV.ai — design cohérent avec l'app, responsive |
| **Lien dans le studio** | sidebar → pied de page : « À propos · LeStudioViral » → `a-propos/` |
| **SEO de l'app** | `index.html` : `meta description` / `keywords` / `author` / `canonical` + Open Graph + Twitter Card + **JSON-LD** (`WebSite` → `Organization` LeStudioViral → `Person` Salaou Souleyman) |
| **SEO de la page** | titre + description + canonical + `og:profile` + **JSON-LD** `Person` / `Organization` / `WebSite` (le fondateur est ainsi exposé aux moteurs de recherche) |
| **`robots.txt` + `sitemap.xml`** | indexés par Google/Bing sur GitHub Pages ; le back-office `/admin/` est interdit aux robots |
| **Site officiel de la marque** | 2 liens `https://lestudioviral.com` dans `a-propos/`, repérables par le commentaire `SITE_OFFICIEL` : les remplacer par l'URL réelle du site officiel quand il sera en ligne |

### 2.8 Page d'accueil, URL propres & boutiques (nouveau)

| Ajout | Détail |
|---|---|
| **Page d'accueil** | premier écran à l'ouverture de l'app (première visite), inspiré des grandes plateformes : barre de marque, héros avec logo officiel `lsv.jpg`, titre géant, double CTA (Commencer / J'ai déjà un compte) |
| **Galerie « Créé avec LSV.ai »** | 1 **vidéo** en grand (V1) + 6 images + 2ᵉ vidéo (V2) en bas de page — visuels réels `assets/showcase/1.jpg`…`6.jpg`, `V1.mp4`, `V2.mp4`, SVG de repli inclus |
| **Sections complètes** | fonctionnalités (6 cartes), « Comment ça marche » (3 étapes), bandeau de stats, **boutiques**, CTA final, pied de marque |
| **Première visite → compte** | « Commencer » sans compte ouvre l'inscription ; le dashboard de création n'apparaît qu'une fois le compte créé (drapeau `localStorage.lsv4_welcome`) |
| **Déconnexion → accueil** | à la déconnexion, renvoi automatique vers la page d'accueil |
| **Visiteur déconnecté** | l'accueil s'affiche à chaque visite sans compte (le drapeau `lsv4_welcome` ne masque plus l'accueil aux visiteurs) |
| **Galerie épurée** | plus de badges ni de légendes sur les visuels : seuls les visuels et leurs `alt` SEO restent |
| **Boutiques en ligne** | liens réels sur l'accueil **et** sur la page À propos : [Boutique LeStudioViral](https://rxorzera.mychariow.shop) (`SHOP_1_URL`) et [Académie Digital](https://blgbiwds.mychariow.shop) (`SHOP_2_URL`) |
| **URL propres** | plus aucun lien interne vers `index.html` : accueil `…/lsv-ai/`, à propos `…/a-propos/`, back-office `…/admin/` |
| **Page À propos épurée** | seul le logo du header reste visible ; logos héros/avatar supprimés |
| **SEO renforcé** | `og:image` + `twitter:image` (carte large) sur les 2 pages, `robots` (index/follow, large images), `apple-touch-icon`, `preload` du logo, JSON-LD enrichi (`SoftwareApplication` + logo de l'Organization), `llms.txt` (index IA), `sitemap.xml` daté (`lastmod`), images avec `alt`, `loading="lazy"`, `width`/`height` (anti-CLS) |
| **Onglets du navigateur** | titres de pages explicites + favicon `lsv.jpg` |
| **Texte sous les formulaires retiré** | la mention « Les mots de passe sont vérifiés… » sous la page de connexion a été supprimée |
| **Erreurs d'inscription plus claires** | échec d'envoi de la confirmation ou limite d'inscription : messages **génériques** pour l'utilisateur (« réessaie dans quelques instants ») — aucun détail de configuration n'est jamais affiché |

### 2.9 Architecture modulaire (refonte du code)

`index.html` n'est plus un fichier monolithique : c'est un **squelette HTML**
(~1 200 lignes au lieu de ~7 000) qui ne contient que le `head` SEO, le markup
de l'accueil et du dashboard, et des liens vers des fichiers dédiés.

| avant | après |
|---|---|
| tout le CSS dans un `<style>` de 2 470 lignes | 6 feuilles dans `styles/`, une responsabilité chacune |
| tout le JS dans un `<script>` de 3 300 lignes | 8 modules dans `scripts/`, chargés dans un ordre fixe |
| `index.html` : 6 995 lignes / ~250 Ko | `index.html` : ~1 230 lignes / 62 Ko |

**Découpage des modules** (`scripts/`, scripts classiques dans cet ordre — les
`const` de niveau supérieur partagent le scope global, comme avant) :

1. `constants.js` — `GATEWAY_URL`, styles d'enhancer
2. `core.js` — `Utils`, `StorageService`, `ProjectService`, `AssetService`,
   `HistoryService`, `ConversationService`, `LockService`, `DebugService`,
   `TimingService`, `WakeLockService`
3. `account.js` — `Gateway`, `AccountService`, `AccountView`, `WelcomeView`
4. `media.js` — provider, prompts, images, vidéos, fichiers, `Runtime`,
   `UIState`, `EnhancerService`
5. `ui.js` — contrôleur UI (toasts, panneaux, rendu global)
6. `chat.js` — `ChatService`, `ChatActions`, `ChatView`
7. `views.js` — dashboard, projets, bibliothèque, historique, avancé,
   enhancer, storyboard, workflows, verrous, batch
8. `handlers.js` — `Handlers`, restauration des résultats, `init()`, `window.LSV`

Le shim de sécurité Analytics (`window.LSVAnalytics = … || {track: inerte}`)
reste **inline** dans `index.html` : c'est le filet de sécurité qui doit
toujours être présent, même si `analytics.js` ne se charge pas.

**Ce qui ne bouge pas** : `window.LSV` expose exactement les mêmes propriétés
(`config`, `services`, `views`, `actions`, `utils`), l'API publique est
identique, et aucun test n'a eu besoin d'être adapté sur le plan fonctionnel.

**Garde-fous ajoutés aux tests** : `public.test.js` §12 vérifie que
`index.html` reste léger, qu'aucun `<style>` ni script volumineux n'y revient,
que les 14 modules existent, sont tous référencés et dans le bon ordre.
Les scans de sécurité (§5) portent désormais sur **tout le bundle**
(`index.html` + `scripts/` + `styles/` + `shared/` + `analytics/`), pas
seulement sur le HTML — la couverture sécurité n'a donc pas été réduite par la
modularisation.

### 2.10 Actions par utilisateur & Journal d'audit (nouveau)

Deux pages s'ajoutent au back-office, côté section **Système** :

| page | objectif |
|---|---|
| **Actions** | Détail de l'activité **de chaque compte** (images, vidéos, chat, projets, autres, erreurs, dernière action) pour la période sélectionnée |
| **Journal** | Qui a fait quoi et quand dans le back-office lui-même — trace d'audit **écriture seule** |

**Actions** lit la table `analytics_events` en ne gardant que les événements
portés par un `user_id` (donc émis par un compte connecté), les agrège par
compte et croise les identifiants avec `profiles` (e-mail + nom complet). Les
piles horaires (jour / 7 j / 30 j / tout) fonctionnent comme ailleurs.

**Journal** lit et écrit la table `admin_logs`. Chaque action sensible du
back-office (modification / retrait de la clé fournisseur, etc.) y dépose une
ligne : `action`, `cible`, `détail` (JSON, **jamais la valeur de la clé**) et
l'auteur. L'auteur est **forcé côté serveur** par un trigger PostgreSQL à
partir du jeton JWT — un administrateur ne peut donc pas se faire passer pour
un autre. La table est en **insert + select uniquement** (pas d'update, pas de
delete) via les policies RLS.

**Migration à exécuter** (une seule fois, dans le SQL Editor Supabase) :

```bash
# Dashboard Supabase → SQL Editor → New query → coller le contenu de :
supabase/upgrade-activity-logs.sql
supabase/upgrade-quotas.sql
supabase/upgrade-multi-key.sql   # clés du fournisseur par outil (§2.12)
```

Ce fichier est idempotent : il ajoute la colonne `user_id` à
`analytics_events` (si absente), crée la table `admin_logs`, le trigger
`set_log_actor()`, les policies RLS et les grants. Le schéma complet de
référence reste `supabase/schema.sql`.

### 2.11 Quotas journaliers par compte (nouveau)

Chaque **compte connecté** dispose de ses propres limites quotidiennes,
remises à zéro **automatiquement à minuit UTC** :

| Outil | Quota par défaut | Pondération |
|---|---|---|
| **Images** | **20 unités** | 1K = 1 unité · 2K = 2 · 3K = 3 |
| **Vidéos** | **8** | 1 vidéo = 1 unité |
| **Chat IA** | **30 messages** | 1 message = 1 unité |

Un quota de 20 images autorise donc 20 images en 1K, **10 en 2K**, ou
**6 en 3K** (+ 2 en 1K). Le poids est calculé côté **serveur** à partir du
champ `size` de la requête — le client ne peut pas le modifier.

**Les 5 règles appliquées**

1. **Quota individuel** — la passerelle vérifie le jeton Supabase du compte
   (`/auth/v1/user`) : chaque compte a ses propres compteurs, stockés dans
   `public.usage_counters`. Un visiteur non connecté ne peut rien générer.
2. **Remise à zéro à minuit UTC** — les compteurs sont indexés sur la date
   UTC ; aucun compteur ne survit au jour.
3. **Contrôle côté serveur** — tout se passe dans la fonction Supabase Edge
   `lsv-gateway`. L'interface n'affiche que le résultat : impossible de
   contourner le compteur en modifiant le navigateur.
4. **Compteur visible** — la sidebar affiche « Quota du jour »
   (`Images 4/20 · Vidéos 2/8 · Chat 11/30`) et un toast prévient quand une
   réserve est épuisée. Chaque réponse de la passerelle renvoie les restants
   dans des en-têtes, donc le compteur est toujours exact.
5. **Protections globales** — en plus du quota par compte : une **limite
   globale journalière** (0 = illimitée), un **débit** par IP/visiteur, et un
   plafond de **générations simultanées** par compte. Tout est réglable.

**Gestion des échecs et de la concurrence**

- Une génération **refusée ou échouée** chez le fournisseur est
  **remboursée** (`refund_quota`) : seul un lancement réel consomme.
- La consommation est **atomique** (`select … for update` dans
  `consume_quota`) : deux requêtes simultanées ne peuvent pas dépasser le
  quota. Le plafond de concurrence par compte évite en plus les
  enchaînements parallèles entre deux verrous.
- Le **polling vidéo** (`/agnesapi`) n'est **pas** compté : il appartient à
  la même génération.
- Un quota épuisé renvoie un `429` marqué `x-lsv-quota` : le client **cesse
  immédiatement** de réessayer au lieu d'attendre inutilement.

**Back-office → « Limites et quotas »** permet de :

- modifier les quotas journaliers par outil (images / vidéos / chat / motion) ;
- définir une **limite globale** journalière ;
- consulter la **consommation du jour** par compte (du plus grand
  consommateur au moins grand) ;
- **suspendre / réactiver** toutes les générations en un clic (urgence) ;
- fixer des **quotas différents pour les administrateurs** (vide = quota
  standard).

Chaque modification est tracée dans le **journal d'audit** (`admin_logs`).
Les valeurs sont lues par la passerelle avec un cache de 30 s : un changement
est effectif en moins d'une minute, sans redéploiement.

#### Concurrence multi-utilisateurs

Rien n'est partagé côté client : `localStorage` est **par navigateur**, donc
deux utilisateurs ne peuvent pas se marcher dessus. Le seul point partagé est
la table `usage_counters`, et elle est protégée côté serveur.

`consume_quota` est une fonction `SECURITY DEFINER` qui, **en une seule
transaction** :

1. verrouille la ligne du compteur avec `SELECT … FOR UPDATE`
   (Postgres sérialise alors les requêtes simultanées) ;
2. vérifie la limite (par compte + éventuelle limite globale) ;
3. incrémente par `UPDATE … SET units = units + n`, avec un repli
   `ON CONFLICT DO UPDATE` si la ligne n'existe pas encore.

Deux appels simultanés ne peuvent donc pas faire dépasser la limite :
le second attend le verrou du premier. Le compteur global (plafond partagé)
est verrouillé séparément, dans le même ordre, pour éviter tout interblocage.

Enfin, la fonction n'est **invoquable que par la Gateway** (`service_role`) :
`revoke … from public, anon, authenticated`. Un client ne peut ni consommer
son quota deux fois, ni le consommer sans passer par la Gateway. Vérifié par
`tests/gateway.test.mjs` §20 (store mémoire) et §22 (schéma SQL).

---

### 2.12 Clés du fournisseur par outil (nouveau)

Trois clés **dédiées**, une par outil, saisies dans le back-office :

| Clé `app_settings` | Utilisée pour |
|---|---|
| `provider_api_key_image` | toutes les générations d'images |
| `provider_api_key_video` | les générations de vidéo **et** leur polling |
| `provider_api_key_chat` | le chat IA et l'amélioration de prompts |
| `provider_api_key` | **clé partagée de secours** : outils dont la clé dédiée est vide, et le module Motion |

**Résolution** (par requête, côté serveur uniquement) :

```
clé dédiée de l'outil  →  clé partagée  →  secret serveur AGNES_API_KEY
```

**Intérêt.** Chaque outil a alors son propre **budget** et son propre
**rate limit** chez le fournisseur : un lot de 50 images n'épuise **pas** la
clé vidéo, et la panne ou la révocation d'une clé n'arrête **qu'un seul outil**.
Le débit total devient la somme des débits des trois clés.

**Inconvénients à garder en tête.** Trois clés = trois postes chez le
fournisseur (suivi du coût, de la facturation, des plafonds). Sans cela, il
vaut mieux ne renseigner que la clé partagée.

**Sécurité.** Les trois clés vivent dans `app_settings` (RLS : **liste blanche
uniquement**, aucun droit pour `anon`), sont lues par la passerelle avec la clé
de **service** du projet, **jamais** renvoyées au navigateur, et le back-office
n'affiche que les **4 derniers caractères**. Le journal d'audit enregistre
l'opération **sans les valeurs**.

Interface : `/admin → Paramètres → « Clés du fournisseur par outil »` —
un champ par outil, `Enregistrer les 3 clés` (champ vide ignoré) et
`Tout retirer`. Migration : `supabase/upgrade-multi-key.sql`.

> Rien ne casse si seule l'ancienne clé partagée est renseignée : c'est le
> comportement par défaut, et le repli automatique.

### 2.13 Sélecteur de ratio visuel (nouveau) — v3.13.0

Les deux `<select>` de ratio (image et vidéo) sont remplacés par une grille de
boutons, chacun représenté par **un rectangle aux proportions réelles** — comme
sur les plateformes d'IA grand public. Plus rapide à lire qu'une liste
`16:9 / 9:16 / 1:1`.

| | Image | Vidéo |
|---|---|---|
| Ratios | 16:9, **9:16**, 1:1, 4:3, 3:4 | 16:9, **9:16**, 1:1 |
| Défaut | **9:16** | **9:16** |

Implémentation : `UI.renderRatioGrid()` (`scripts/ui.js`) auto-remplit des
`<div class="ratio-grid" id="image-ratio">` vides — `index.html` ne contient
donc plus de `<select>` de ratio, et la table `RATIOS` (`scripts/constants.js`)
décrit chaque format. Accessible : `role="radiogroup"` + `aria-checked`.
Vérifié par `tests/public.test.js` §13 (11 assertions).

### 2.14 Espace créateur, page Contact & formulaires (nouveau) — v3.14.0

Deux pages de contact distinctes, un auteur identifiable, et une passerelle
d'envoi qui ne laisse aucun message se perdre.

| | `/a-propos/` | `/contact/` |
|---|---|---|
| Canal | `founder` | `site` |
| Destinataire | Salaou Souleyman | LeStudioViral |
| Formulaire | dans la section « Créateur » | objet de la page |

**Espace créateur** (`#createur` dans `a-propos/index.html`) : portrait
(`assets/showcase/pdg.png`), le texte officiel « Un créateur. Plusieurs
disciplines. Un univers. », les deux paragraphes de présentation et la ligne de
disciplines `SOFTWARE · AI · 3D · CONTENT · DIGITAL PRODUCTS`. L'ancienne carte
`.founder` (texte + avatar) est remplacée par cette section, dont le style vit
dans `styles/contact.css` (`.creator`, `.creator-photo`, `.disciplines`).

**Visionneuse du portrait** : la vignette est un vrai `<button class="photo-zoom">`
(atteignable au clavier, `aria-haspopup="dialog"`) et ouvre un
`<dialog class="lightbox">` plein écran. La source fait **1672×941** et la
vignette l'affiche recadrée en 4:5 (`object-fit: cover`) ; la visionneuse
montre donc le cliché **complet**, sans recadrage. Fermeture par le bouton,
le clic sur le fond, ou `Échap` — ces deux derniers sont assurés par
`<dialog>` lui-même ; le focus revient ensuite sur la vignette. Le repli
`setAttribute('open')` couvre les moteurs sans `showModal` (et jsdom, utilisé
par les tests).

**Formulaire personnel du créateur** : champ honeypot `website` invisible,
4 champs (`nom`, `e-mail`, `objet`, `message`), et `data-contact="founder"` qui
choisit le destinataire **côté serveur** — le client n'envoie jamais d'adresse
de destination, donc personne ne peut faire écrire au formulaire.

**Page `/contact/`** : même structure, plus un `aside` avec les deux adresses
officielles, un JSON-LD `ContactPage`, et un footer à 4 colonnes partagé avec
`/a-propos/` (`.site-footer`, `styles/contact.css`). `/sitemap.xml` et `llms.txt`
listent la nouvelle page ; la sidebar de l'app gagne le lien « Contact ».

**Footer de l'accueil** : le `.w-foot` en `<div>` devient un vrai
`<footer class="w-foot">` à 4 colonnes (marque + 2 `<nav>` + contact), avec
`.w-foot-bottom` (mentions) et `.w-foot-seo` (phrases pour l'indexation).
Le mot « clé API » disparaît du pied de page public.

**Edge Function `lsv-contact`** — `supabase/functions/lsv-contact/` :

- `core.mjs` (testable sous Node) : validation (bornes 2/120, 5/200, 3/160,
  10/4000), honeypot, anti-bot temporel (< 3 s = robot), rate limit mémoire
  (3/min, 20/j par IP) **puis** rate limit persistant en SQL ;
- `templates.mjs` : notification (HTML + texte) et accusé de réception, thème
  `#0d9488`, tout le contenu utilisateur échappé ;
- `index.ts` : simple câblage d'env, logique testable séparément.

Ordre de traitement, qui est le point important :

```text
validation → honeypot/anti-bot → rate limit mémoire
    → INSERT en base (rate limit SQL)     ← PORTE D'ENTRÉE : rien ne passe avant
    → notification au destinataire du canal
    → mise à jour du statut (sent / stored / unconfigured)
    → accusé de réception à l'expéditeur
```

Aucun e-mail ne part avant que la base ait accepté le message : un bot ne peut
donc pas faire consommer des envois puis se voir refuser. Si le fournisseur
d'e-mail n'est pas configuré, la réponse reste `200 {ok:true, reason:'stored'}` —
le message est journalisé, rien n'est perdu et rien n'est simulé. Ni base ni
e-mail → `502`, jamais de faux acquittement.

**Canaux** : `founder` → `salaousouleyman@gmail.com`, `site` →
`lestudioviral@gmail.com`. Fournisseurs **`brevo`** ou **`resend`** (HTTP API,
sans dépendance) ; `EMAIL_FROM` au format `Nom <adresse@domaine>`.

**Déploiement** (une fois) :

```bash
# 1) migration (table contact_messages + RPC submit_contact)
#    Dashboard Supabase → SQL Editor → coller supabase/upgrade-contact.sql

# 2) déployer la fonction
npx supabase functions deploy lsv-contact

# 3) secrets du fournisseur d'e-mail
npx supabase secrets set \
  EMAIL_PROVIDER=brevo \
  EMAIL_API_KEY=... \
  EMAIL_FROM="LeStudioViral <no-reply@ton-domaine>"

# optionnel
npx supabase secrets set CONTACT_AUTO_REPLY=1 CONTACT_RATE_PER_MIN=3 CONTACT_RATE_PER_DAY=20
```

La RPC `submit_contact` est `SECURITY DEFINER` mais **retirée de `anon` et
`authenticated`** : la fonction n'y accède qu'avec la clé de service, comme le
vérifie `tests/contact.test.mjs` §8.

Vérifié par `tests/contact.test.mjs` (154 assertions) : validation, canaux,
CORS, honeypot, double rate limit, pannes et replis, modèles d'e-mail,
migration SQL, **et le rendu réel des deux pages sous jsdom** (chargement sans
erreur, auto-initialisation, parcours de soumission, footer, portrait).

**Checklist manuelle** (l'envoi réel d'e-mail n'est pas automatisable) :

1. `/contact/` → soumettre un message → « Message bien reçu. Je te réponds
   sous 48 h. » → `lestudioviral@gmail.com` reçoit la notification **et**
   l'expéditeur son accusé de réception.
2. `/a-propos/` → même parcours, mais la notification arrive sur
   `salaousouleyman@gmail.com`.
3. Soumettre 4 fois en 2 minutes → la 4ᵉ affiche « Trop de messages en peu de
   temps ». Vérifier aussi `contact_messages` dans Supabase : le 4ᵉ n'y est pas.
4. Vide `EMAIL_API_KEY` puis resoumettre → le visiteur est acquitté, la ligne
   apparaît avec `status = 'unconfigured'`. Rien n'est perdu.

### 2.15 Image de référence depuis la bibliothèque — v3.15.0

Une image d'image-en-vidéo ne vient plus seulement du disque de l'utilisateur :
elle peut être **une création déjà générée sur LSV.ai**. Le sélecteur de la
carte « Images sources » comporte désormais deux onglets.

| Onglet | Contenu | Plafond |
|---|---|---|
| Mon appareil | zone d'upload historique (inchangée) | 1 en Image→Vidéo, 2 en Keyframes |
| Bibliothèque | grille des créations `type: image` | identique |

**Le navigateur ne télécharge jamais l'image.** Une création est stockée comme
`{id, type, url, …}` (`AssetService`, `scripts/core.js`) : l'URL seule ne peut
pas être lue depuis une autre origine (CORS) ni convertie en `File`. Le client
pousse donc dans `UIState.videoRefs` une référence `{assetId, source:'library',
name, dataUri: <url>, preview: <url>}` et laisse la conversion à la passerelle,
qui a le droit de faire ce téléchargement.

Côté passerelle (`supabase/functions/lsv-gateway/core.mjs`) :

- `resolveMediaRef(value)` — renvoie un `data:` tel quel, sinon télécharge
  l'URL (`image/*` uniquement, 20 Mo max) et la renvoie en `data:<mime>;base64,…` ;
- `resolveVideoRefs(bodyText)` — applique `resolveMediaRef` aux champs **`first_frame`
  et `last_frame` seulement** (un seul générateur d'image à la fois, deux
  keyframes), en préservant tous les autres champs du corps. (Ces champs ont
  porté le nom `image`/`last_frame` jusqu'à la §2.16 : le fournisseur n'a jamais
  connu que `first_frame`.) ;
- étape **« 6. Image de référence »** du handler : pour `type === 'video'` uniquement,
  juste avant l'appel fournisseur. URL morte → `400` avec un message lisible
  (`MSG_MEDIA`), **remboursement du quota**, libération du verrou d'inflight,
  et aucun détail technique ni URL de CDN dans la réponse. `/v1/images/generations`
  n'est pas touché.

Le fichier de l'appareil continue de circuler **en base64 depuis le navigateur**,
sans modification ni téléchargement supplémentaire.

Vérifié par `tests/gateway.test.mjs` §23 (23 assertions) et
`tests/public.test.js` §14 (26 assertions : rendu des onglets, état vide de la
bibliothèque, sélection, dédup, plafond par mode, parcours fichier intact).

### 2.16 Vidéo réparée + diagnostic d'échec traçable — v3.16.0 à v3.16.5

**L'incident.** Toute génération de vidéo échouait avec
`HTTP 503 — {"error":{"message":"Impossible de générer le contenu pour le
moment…"}}`, alors que les images et le chat fonctionnaient.

**La cause.** `MODEL_VIDEO` valait `agnes-video-v2.0`, un modèle **qui n'existe
plus** chez le fournisseur. Le diagnostic définitif tient en une commande :

```bash
curl -s https://<ref>.supabase.co/functions/v1/lsv-gateway/v1/models \
  -H 'origin: https://<vous>.github.io' | python -m json.tool
```

La liste réelle ne contenait ni `agnes-video-v2.0`, ni aucun `*-v2.*` : les
modèles vidéo s'appellent `agnes-video-2.5-flash` et `agnes-video-2.5`. Le
fournisseur répond **503 pour tout modèle inconnu** — d'où un « service
indisponible » qui ne disait rien de la vraie faute.

| Outil | Modèle | État vérifié |
|---|---|---|
| Image | `agnes-image-2.1-flash` | 200 |
| Chat | `agnes-2.5-flash` | 200 |
| Vidéo | `agnes-video-2.5-flash` | **corrigé** (`scripts/constants.js`) |

> **Règle** : un nom de modèle n'est jamais deviné. `GET /v1/models` fait foi,
> et le test de non-régression le verrouille.

**Pourquoi on n'avait rien pu voir.** Le détail réel (statut amont + extrait de
sa réponse) partait **uniquement** dans les journaux de la fonction Edge, sans
aucun lien avec ce que le navigateur enregistrait. Quatre correctifs, du plus
large au plus fin :

1. **`Access-Control-Expose-Headers` manquant** (`core.mjs`). En cross-origin,
   le navigateur masque tous les en-têtes non listés : les compteurs
   `x-lsv-quota-*` envoyés par la passerelle étaient donc **invisibles** pour
   `QuotaService.applyHeaders` — le « il te reste N images » ne se mettait
   jamais à jour. Corrigé pour `x-lsv-*` et `retry-after`.
2. **Identifiant de requête** : chaque réponse porte `x-lsv-request-id`, et la
   même valeur est écrite dans les journaux à côté du **vrai** statut amont et
   d'un extrait de 300 caractères — `amont-status 503 /v1/videos <id> <extrait>`.
   Un échec du back-office devient retrouvable ligne à ligne.
3. **Le client transmet le détail** (`AgnesProvider.fail`) : les messages
   d'erreur portent maintenant `HTTP <code> [<id>] — <message>`, pour l'image,
   la vidéo, le chat et l'enhancer. Le texte affiché à l'utilisateur reste
   strictement générique (`Utils.friendlyError`, §11) — seul le journal
   d'analyse reçoit le détail.
4. **Le back-office affiche le détail en entier** (`admin.js`). La signature
   était tronquée à 70 caractères, ce qui coupait le message exactement là où
   il devenait intéressant. Colonnes ajoutées **HTTP** (badge) et signature qui
   se replie ; identifiant de requête isolé dessous ; renvoi explicite vers la
   ligne `amont-status` des journaux. Surtout : les **503 et 502 sont désormais
   regroupés séparément** — la normalisation les fusionnait en une signature
   unique indistincte.

Par ailleurs, un sondage (`poll`) qui échoue ne détruit plus une génération
déjà acceptée : il est journalisé et retenté à l'itération suivante, et la
raison d'un échec renvoyée par le fournisseur est conservée dans le message.

Vérifié par `tests/gateway.test.mjs` §24 (21 assertions), `tests/admin.test.js`
§E2 (8 assertions) et `tests/nonreg.test.js` (verrouillage du modèle).

**Deuxième cause : `num_frames` est un champ interdit.** Le 503 parti, le
fournisseur a répondu `400` — et le journal a livré la phrase exacte :

```json
{"code":"invalid_request",
 "message":"num_frames is a forbidden field (request id: 2026…4VDlQFDZL)",
 "data":{"param":"num_frames"}}
```

`VideoService.createTask` envoyait `{model, prompt, num_frames, frame_rate}`.
Les deux derniers champs sont **interdits** par l'API vidéo : la durée ne se
régle pas en nombre d'images. Ils ont été retirés. Aucune estimation de durée
n'est envoyée pour l'instant — `frames` ne sert plus qu'à caler le temps du
sondage.

**Troisième cause : `mode` est obligatoire.** Une fois `num_frames` retiré, le
refus suivant fut `{"message":"invalid mode","data":{"param":"mode"}}` — et
`mode` n'était envoyé nulle part. Il est **exigé** par le fournisseur, qui ne
daigne pas lister les valeurs admises.

Les valeurs ont donc été déterminées par élimination, **sans jamais lancer une
génération** : chaque candidat était associé à `n:-1`, un champ contrôlé *après*
`mode`. Le verdict se lit alors dans le paramètre signalé — `param: mode` signifie
« candidat refusé », `param: n` signifie « candidat accepté, le contrôle a passé
au champ suivant ». Aucun risque de création : `n:-1` est invalide dans tous les
cas.

| Valeur testée | Verdict |
|---|---|
| `t2v`, `i2v`, `image`, `img`, `img2vid`, `image_url`, `first_frame` | refusé |
| `text-to-video`, `image-to-video`, `text2video`, `text_to_video` | refusé |
| `openai`, `Zz-probe` | refusé |
| **`text`** | **accepté** |

`text` n'est pourtant **pas** universel : le fournisseur refuse tout champ média
en mode `text` — « text mode cannot include media fields ». Une seconde valeur,
`keyframe`, porte au contraire les images : c'est elle qui accepte `first_frame`
et `last_frame`. **Le champ `image` n'existe pas** côté fournisseur — il était
pourtant celui que l'application envoyait depuis sa première version.

Le corps de création est donc, selon le cas :

```jsonc
// prompt seul
{ "model": "agnes-video-2.5-flash", "mode": "text", "prompt": "…" }

// avec image de départ (et éventuellement d'arrivée)
{ "model": "agnes-video-2.5-flash", "mode": "keyframe", "prompt": "…",
  "first_frame": "data:image/png;base64,…", "last_frame": "data:image/png;base64,…" }
```

| Situation | `mode` | Champs média |
|---|---|---|
| prompt seul | `text` | **aucun** — leur simple présence est refusée |
| image de départ | `keyframe` | `first_frame` (+ `last_frame` si fin) |
| image d'arrivée seule | `text` | aucun (une fin sans début n'a pas de sens) |

Valeurs refusées en `mode` : `t2v`, `i2v`, `image`, `img`, `img2vid`,
`image_url`, `first_frame`, `media`, `frame`, `frames`, `picture`,
`source_image`, `text-to-video`, `image-to-video`, `text2video`,
`text_to_video`, `openai`. Champs interdits : `num_frames`, `frame_rate`, `n`.

> **Résolution.** Une fois la forme exacte obtenue, la validation passe — plus
> aucun `x-lsv-upstream-param` — et le 503 restant s'est révélé n'être **pas**
> un défaut de payload :
>
> ```json
> {"code":"video_queue_full",
>  "message":"video queue is full, please retry later (request id: 2026…m)"}
> ```
>
> Le contrat est donc correct et l'application envoie désormais le bon corps ;
> ce qui reste tient à la **capacité du fournisseur**, pas au code. (La même
> réponse de 503, vue avec un modèle retiré du catalogue, porte `model_not_found`
> — « no available channel for model … » : deux causes très différentes sous un
> même statut.) Le code amont est désormais remonté aussi sur le **503**, ce
> qui rend la distinction lisible dans le back-office sans ouvrir les journaux.

> **Piège relevé au passage** : l'événement d'analytique `video_generated`
> transporte une propriété `mode: "text-to-video"` depuis l'origine du projet.
> Ce libellé **n'a aucun rapport** avec le champ `mode` du fournisseur — l'un
> va dans Supabase, l'autre part vers l'API vidéo. Ne jamais les confondre.

Le corps de création est verrouillé par `tests/nonreg.test.js` : `mode` `text`
sans aucun média, `mode` `keyframe` avec `first_frame` / `last_frame`, et
**aucun** champ interdit. Chaque écart est un 400 silencieux côté utilisateur.

**La passerelle est maintenant auto-diagnostiquante.** Renvoyer un simple
« Impossible de générer » rendait chaque integration cassée indiagnostiquable :
il fallait ouvrir les journaux à la main, à chaque erreur. La passerelle extrait
donc quelques informations **structurées** du corps amont et les renvoie en
en-têtes, exposés au navigateur :

| En-tête | Quand | Contenu | Exemple |
|---|---|---|---|
| `x-lsv-upstream-status` | **toute** erreur amont | vrai statut amont, 3 chiffres | `404` |
| `x-lsv-upstream-code` | 400, 429, **503** | `code`, filtré `[A-Za-z0-9_-]`, 40 max | `video_queue_full` |
| `x-lsv-upstream-param` | 400 | `data.param`, filtré `[A-Za-z0-9_.-]`, 60 max | `num_frames` |
| `x-lsv-upstream-reason` | 400 | nature du refus, énuméré fermé | `forbidden` |
| `x-lsv-upstream-allowed` | 400 | valeurs admises, 8 × 16 max | `720x1280,1080x1920` |

**`x-lsv-upstream-status` est ajouté en v3.16.8** et c'est le seul qui ne dépend
d'aucune lecture du corps amont. Il existe parce que `safeStatus` ramène tout
statut hors {400, 429, 503} en `502` : le client voyait donc « 502 » — aussi
creux que le message générique — sans savoir si l'amont avait répondu `401`
(clé refusée), `404` (chemin disparu) ou `500` (panne). Le journal en avait la
réponse, mais seulement si on ouvrait le dashboard. Chiffres seuls, aucun texte,
et il est rappelé dans la signature d'erreur **uniquement s'il diffère** du
statut affiché.

Le **`code` seul** circule aussi sur un 503 parce que c'est lui qui distingue
deux causes totalement différentes sous un même statut : `video_queue_full`
(« attendez, la file est pleine ») et `model_not_found` (« ce modèle n'a aucun
canal ») appellent des réactions opposées. C'est un unique jeton filtré —
pas de modèle, pas de message, pas d'identifiant.

`reason` et `allowed` sortent de `classifyValidation` (`core.mjs`) : un
**énuméré fermé** (`forbidden` / `required` / `invalid`) et, **uniquement si le
message l'énonce explicitement**, la liste des valeurs admises. Le nom du champ
lui-même en est exclu — « "size" must be one of ["720x1280","1080x1920"] »
donne `allowed=720x1280,1080x1920`, jamais `size`. Pas d'énumération dans le
message : pas de liste inventée. Aucune phrase n'est jamais reprise telle quelle.

Le message affiché à l'utilisateur reste strictement générique ; seul le
journal d'analyse reçoit
`HTTP 400 [<id>] (invalid_request · num_frames · forbidden) — …` ou
`HTTP 503 [<id>] (video_queue_full) — …`. Le corps amont n'est jamais transmis,
ni aucun détail de modèle, d'identifiant ou de phrase.

Vérifié par `tests/gateway.test.mjs` §25 (38 assertions) : remontée des quatre
champs, filtrage, exclusion du nom du champ, absence de liste inventée, plafond
de 8 valeurs, `code` sur 503 avec et sans corps exploitable, absence sur un
corps non JSON, sur un tableau et sur un 401, et **aucun texte libre du
fournisseur dans la réponse**.

> **Déploiement** : les v3.16.0 à v3.16.5 touchent `core.mjs` et doivent être
> redéployées (`§7.3`) —
> `npx supabase functions deploy lsv-gateway --no-verify-jwt`. Tant que
> l'ancienne version tourne, ni l'id de requête, ni l'exposition des en-têtes,
> ni le remontage du paramètre refusé, ni la résolution de `first_frame` côté
> serveur n'existent côté navigateur.

---

### 2.17 Quotas : remboursement aligné sur la consommation - v3.16.6

**Symptôme** (visible dans Supabase → Edge Functions → `lsv-gateway` → Logs,
avant cette version) :

```
quota-rpc-status 400
```

`dbConsume` appelle `POST {supaUrl}/rest/v1/rpc/consume_quota` avec la clé de
service. Un statut `400` renvoie `null`, ce qui bascule silencieusement sur le
compteur mémoire (`store.consumeDaily`) : l'utilisateur continue de générer,
sans le savoir, dans une base qui **ne compte plus rien**.

**Le bug corrigé ici n'était pas cette bascule — c'était son pendant.**
Tous les chemins d'échec (image de référence injoignable, panne réseau amont,
erreur amont) appelaient :

```js
if (consumed && user) await dbRefund(user, type, units);
```

c'est-à-dire **toujours** `refund_quota` en base, alors que l'unité venait
d'être prélevée **en mémoire**. Le remboursement SQL était donc sans effet :
chaque tentative qui n'aboutit pas à une génération coûtait définitivement une
unité — et précisément quand la base était indisponible, donc en permanence.
Un compte bloqué à `x/1` ne pouvait plus rien faire jusqu'au prochain redémarrage
de l'instance.

**Correctif**

| Élément | Rôle |
|---|---|
| `createMemoryStore().refundDaily(key, now)` | Rend une unité prélevée en mémoire, même fenêtre UTC |
| `dbConsumed` / `memoryRefunds` | Mémorise **où** l'unité a été prélevée (base ou mémoire) |
| `refundQuota()` | Restitue au même endroit, sur les 3 chemins d'échec |
| `store.leave` des visiteurs | Les non connectés sont remboursés eux aussi (clé par IP/visiteur) |
| `refund-rpc-status` (journal) | `refund_quota` échouait aussi en silence — désormais tracé |
| `quota-rpc-status 400 <corps>` | Le corps PostgREST (PGRST202, privilège, syntaxe) était jeté ; il est maintenant journalisé sur 200 caractères |

Les requêtes **réussies** ne sont pas affectées : `dbConsumed` reste `true` et
le remboursement reste SQL, comme avant.

**Ce qui reste ouvert**

La **cause racine** du `400` n'est pas identifiée. Le schéma local est
conforme (`supabase/schema.sql` l.369 et `supabase/upgrade-quotas.sql` l.78
déclarent `consume_quota(p_user, p_email, p_kind, p_units, p_global)`, grant
`service_role`), les arguments envoyés correspondent. Pour lever le doute il
faut le corps de la réponse : déclencher **une seule** génération authentifiée,
puis recopier la ligne `quota-rpc-status 400 …` des logs.

Hypothèses restantes : fonction absente de la base live (migration non
appliquée), cache de schéma PostgREST, privilège manquant.

**Vérifié par** `tests/gateway.test.mjs` §26 (5 assertions) : RPC SQL en échec →
repli mémoire actif, tentative suivante **acceptée** après échec (elle serait
refusée sans remboursement mémoire), et mêmes garanties pour un visiteur non
connecté. Gateway : **220/220**.

> **Déploiement** : `core.mjs` est modifié → `§7.3`
> (`npx supabase functions deploy lsv-gateway --no-verify-jwt`). Sans ce
> déploiement, les générations échouées continuent de consommer le quota.

---

### 2.18 Droits PostgREST : vérification avant le 30/10 - v3.16.7

Supabase ne confère plus automatiquement les droits des tables du schéma
`public` aux **nouvelles** tables (à compter du 30 octobre). Les tables
existantes conservent leurs droits : le projet actuel n'est pas impacté, ni
l'application, ni les clés. Ce qui change concerne :

- toute table créée **après** cette date ;
- les migrations qui **recréent** le schéma (`supabase db reset`, branches de
  prévisualisation, nouveau projet).

Sans `GRANT` explicite, `supabase-js` / PostgREST renvoient
`permission denied` (le message contient la requête à exécuter).

**Ce que fait le dépôt**

| Élément | État |
|---|---|
| `admin_emails` | `revoke` volontaire lu **via `SECURITY DEFINER` uniquement** — aucun accès client souhaité |
| `analytics_events` | `grant insert` à anon + authenticated, `grant select` à authenticated |
| `app_settings` | `grant select, insert, update, delete` à authenticated, `all` à service_role |
| `admin_logs`, `profiles`, `usage_counters` | grants explicites présents |
| `contact_messages` | accès par `submit_contact` (`SECURITY DEFINER`), pas d'accès client direct |
| `consume_quota`, `refund_quota`, `get_quota` | `grant execute … to service_role` |

Tous les droits dont l'application a besoin sont donc **déjà explicites** dans
`supabase/schema.sql` et les `supabase/upgrade-*.sql`.

**Le fichier de vérification** : `supabase/check-grants.sql` (lecture seule, à
coller dans le SQL Editor) — deux blocs :

1. **A. Fonctions de quota** — existe-t-elles et `service_role` peut-il les
   appeler ? C'est directement lié à l'anomalie ouverte
   `quota-rpc-status 400` : si PostgREST ne trouve pas la fonction (absente ou
   sans `GRANT EXECUTE`), il répond `PGRST202` et la passerelle bascule en
   silence sur le compteur mémoire. Un résultat vide = `upgrade-quotas.sql` n'a
   jamais été exécuté sur la base live.
2. **B. Tables publiques** — droits `anon` / `authenticated` / `service_role`
   table par table.

**Règle à appliquer** dès la prochaine table (modèle prêt à copier dans le
fichier) : poser les trois `GRANT` **dans la même migration qui crée la
table**.

> Aucun redéploiement nécessaire : ce changement n'ajoute que de la
> documentation et un script de contrôle.

---

### 2.19 Statut amont exposé : fin du « 502 » opaque - v3.16.8

**Constat repris sur la passerelle en production**, en conditions réelles, avec
le corps exact que produit l'application :

| Heure | Corps envoyé | Réponse | En-tête |
|---|---|---|---|
| 19:29 | `{model:"agnes-video-2.5-flash", mode:"text", prompt:…}` | 503 | `x-lsv-upstream-code: video_queue_full` |
| 19:31 | idem | 503 | `video_queue_full` |
| 19:41 | idem | 503 | `video_queue_full` |
| 20:17 (après 12 min) | idem | 503 | `video_queue_full` |
| 20:20 (+15 min) | idem | 503 | `video_queue_full` |
| — | `{model:"agnes-video-2.5", mode:"text", prompt:…}` | **502** | **aucune** |

**Ce que ces tentatives ont prouvé côté sain** (donc écarté d'emblée) :

- la clé du fournisseur est valide : `{model,mode}` sans `prompt` remonte
  `400 · invalid_request · prompt · required` — authentification et contrat OK ;
- les deux modèles vidéo ont un canal (`prompt required` pour l'un comme pour
  l'autre, là où un modèle inconnu donne 502) ;
- réseau et route OK, quota OK, sanitisation OK.

**Le problème** : `agnes-video-2.5` répond 502, donc un statut amont hors
{400, 429, 503} — `401`, `404`, `422`, `500`… — et `safeStatus` l'a **réduit en
502**. Le client, le back-office et l'en-tête `x-lsv-upstream-code` ne donnent
plus rien : la seule source d'information redevenait le dashboard des journaux.
Exactement le problème que §2.16 avait résolu pour les 400 et les 503.

**Correctif** : `x-lsv-upstream-status`, posé sur **toute** erreur amont, ne
dépendant ni du corps ni du statut retenu — trois chiffres `[1-5][0-9]{2}`.
Ajouté à `Access-Control-Expose-Headers`, lu par `AgnesProvider.fail` et
inséré en tête des parenthèses de la signature **uniquement s'il diffère** du
statut affiché :

```
HTTP 502 [ikezcv-tnvbzf] (amont 404) — {…}
```

Rien n'est transmis du texte amont : `code`, `param`, `reason` et `allowed`
gardent leurs règles (§2.16), et le test `401 → aucun code ni paramètre`
reste verrouillé.

**Vérifié par** `tests/gateway.test.mjs` §25 (+8 assertions) : vrai statut
exposé sur un 401 masqué en 502, sur un 500 masqué en 502, sur un 400 et un
503 (statut identique), sur un corps non JSON, présence dans
`Access-Control-Expose-Headers`, forme à trois chiffres, et aucun code ni phrase
du fournisseur en plus. Gateway : **220/220**.

> **Déploiement** : `core.mjs` et `media.js` modifiés → `§7.3`
> (`npx supabase functions deploy lsv-gateway --no-verify-jwt`) + rafraîchir
> le navigateur pour `media.js`.

---

## 3. Installation locale

```bash
git clone <url-du-repo> lsv-ai
cd lsv-ai
npm install        # uniquement pour les tests (jsdom)
npm test           # 6 suites : non-régression, interface, gateway, admin, studio, contact
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
   *(Base déjà créée ? exécuter, dans cet ordre : `upgrade-admin-whitelist.sql`,
   `upgrade-profiles.sql`, `upgrade-activity-logs.sql`, `upgrade-quotas.sql`,
   `upgrade-multi-key.sql` — toutes idempotentes.)*
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
- la table `app_settings` (clés du fournisseur saisies dans le back-office :
   une dédiée par outil + une clé partagée de secours, et les quotas
   journaliers ; RLS activée, **aucun droit pour `anon`**, lecture/écriture
   réservées à `is_admin()`) ;
- la table `profiles` (**nom complet, e-mail et dernière connexion de chaque
  compte**, recopiés de `auth.users` par un trigger à chaque inscription et
  chaque connexion — aucun secret, aucun mot de passe ; lecture : soi-même ou
  liste blanche ; `anon` n'y accède pas ; source de la page **Utilisateurs**
  du back-office) ;
- la fonction SQL `is_admin()` (légitimée par le JWT de session) ;
- une **liste blanche d'événements** (un inconnu ne peut pas injecter de n'importe
  quel événement) ;
- un contrôle de taille de payload (< 4 Ko) ;
- les index nécessaires.

Voir les noms enregistrés :

```sql
select u.email, p.full_name, p.created_at
from public.profiles p join auth.users u on u.id = p.id
order by p.created_at desc;
```

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
**Authentication → Users** (Supabase) et dans la table `public.profiles`
(nom + e-mail, page **Utilisateurs** du back-office) : jamais dans l'app
publique ni dans Git.

> ⚠️ **E-mail de confirmation jamais reçu** (message « confirme ton e-mail »
> puis « Identifiants incorrects ») : le serveur d'e-mail **intégré** de
> Supabase n'envoie **qu'aux membres de l'équipe du projet** (2 e-mails/heure) —
> un visiteur ne reçoit donc jamais rien, et son compte reste non confirmé.
> Vraie solution : **brancher un SMTP gratuit** (Brevo / Resend) et coller les
> modèles aux couleurs de LSV.ai → voir **§4.6** (cela déverrouille aussi
> l'édition des modèles).
>
> En attendant, débloquer un compte déjà bloqué : **Authentication → Sign In /
> Providers → Email → Confirm email = OFF**, puis confirmer à la main :
>
> ```sql
> update auth.users set email_confirmed_at = now(), confirmation_token = null
> where email_confirmed_at is null;
> ```
>
> Vérifier ensuite dans **Utilisateurs** (back-office) que le compte y apparaît,
> puis **réactiver** *Confirm email* une fois le SMTP en place.

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

### 4.6 E-mails de confirmation & lien de retour

Deux réglages Supabase (une seule fois) pour que l'e-mail de confirmation
porte le nom **LSV.ai** et que le lien de confirmation revienne sur l'app
en ligne (et non sur `localhost`) :

> ⚙️ **Prérequis : SMTP personnalisé.** L'édition des modèles est **verrouillée**
> par Supabase tant qu'aucun SMTP n'est configuré (« Set up custom SMTP to edit
> templates »). C'est aussi la cause des e-mails jamais reçus : le serveur
> intégré de Supabase n'envoie **qu'aux membres de l'équipe du projet**
> (2 e-mails/heure). Solution gratuite sans domaine à acheter :
> [Brevo](https://www.brevo.com) (300 e-mails/jour) ou
> [Resend](https://resend.com/docs/send-with-supabase-smtp).
>
> 1. Brevo → *Settings → Senders & IP → Add* : valider ton adresse d'expéditeur
>    (un lien de confirmation t'est envoyé).
> 2. Brevo → *Settings → SMTP & API → onglet SMTP* → *Generate a new SMTP key*
>    (le mot de passe, **pas** l'API key).
> 3. Supabase → [Authentication → SMTP settings](https://supabase.com/dashboard/project/_/auth/smtp)
>    → *Enable custom SMTP* puis remplir **champ par champ** :
>
>    | Champ Supabase | Valeur |
>    |---|---|
>    | Sender Email | l'adresse d'expéditeur **validée** dans Brevo (étape 1) |
>    | Sender Name | `LSV.ai` |
>    | Host | `smtp-relay.brevo.com` |
>    | Port | `587` (secours `2525`, ou `465` + SSL) |
>    | User | le **SMTP login** affiché sur la page SMTP de Brevo |
>    | Password | la **SMTP key** générée dans Brevo — c'est elle qui va dans « Password » (ni le mot de passe du compte Brevo, ni l'API key) |
>    | Admin Email | ton adresse (alertes Supabase) |
>
>    → Save.
> 4. Optionnel : *Authentication → Rate Limits → Email sending* (départ à
>    30 e-mails/heure) → relever si besoin.
> 5. Puis **réactiver** *Confirm email* (Authentication → Sign In / Providers)
>    : les e-mails arrivent maintenant réellement.

1. **Modèles d'e-mails** — Dashboard → **Authentication → Emails** :
   - *Confirm signup* → coller le contenu de `supabase/email-confirm-signup.html`
     → **Save** ;
   - *Reset Password* (bouton « Mot de passe oublié ? » de l'app) → coller
     `supabase/email-reset-password.html` → **Save**.
   Le lien `{{ .ConfirmationURL }}` est généré par Supabase ; les modèles
   mentionnent déjà LSV.ai et le studio (images / vidéos / chat IA).
2. **Adresse de retour** — Dashboard → **Authentication → URL Configuration** :
   - **Site URL** → `https://fbici.github.io/lsv-ai/` ;
   - **Redirect URLs** → ajouter `https://fbici.github.io/lsv-ai/*`
     (et `http://localhost:4173/*` pour tester en local avec `npm run serve`).

Après le clic sur le lien, l'app affiche « E-mail confirmé : connecte-toi »
(et « Lien invalide ou expiré » si le lien est expiré), puis nettoie l'URL.

---

## 5. Comptes & back-office `/admin`

### 5.1 S'inscrire / se connecter (application publique)

Dans le panneau de droite → section **Compte** : le bouton ouvre la
**page de connexion plein écran** (`#auth-modal`, `role="dialog"`, overlay
flouté) qui reste affichée tant qu'elle n'est pas fermée (bouton ✕, clic
sur le fond, `Échap` ou `Annuler`) :

| Situation | Résultat |
|---|---|
| Non connecté | bouton `Se connecter / S'inscrire` (page fermée par défaut) |
| Non connecté **+ création** | ❌ aucune requête envoyée : toast « Connecte-toi à ton compte pour créer. » + page de connexion ouverte automatiquement (le champ de saisie est conservé) |
| `Créer un compte` | **nom complet** (obligatoire) + e-mail + mot de passe (6 car. min.) → `signUp` ; le champ nom n'apparaît qu'en mode inscription (titre, badge et texte changent avec le mode) |
| `Mot de passe oublié ?` | e-mail saisi → `POST /auth/v1/recover` ; réponse générique (aucune révélation d'existence de compte) |
| Confirmation e-mail activée | message « confirme ton e-mail puis connecte-toi » |
| Connexion réussie | la page se referme + toast « Connexion réussie. » |
| Connecté | `nom complet · e-mail` affichés + `Se déconnecter` |
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

- **Mode clair / sombre** — bouton en haut à droite du dashboard **et** sur
  l'écran de connexion. Le choix est mémorisé dans `localStorage`
  (`lsv_admin_theme`), appliqué **avant le premier rendu** (script inline en
  `<head>`, aucun clignotement blanc) et, à la première visite, on suit la
  préférence du système (`prefers-color-scheme`). Palette alignée sur celle de
  l'application principale (`styles/base.css`).
- **Favicon** — le logo `lsv.jpg` est désormais affiché aussi dans l'onglet du
  back-office (il manquait le `<link rel="icon">`).
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
- **Utilisateurs** — table des comptes créés (`public.profiles`) : nom complet,
  e-mail, date d'inscription, dernière connexion + compteurs (total, avec nom,
  déjà connectés, créés cette semaine). Source = trigger Supabase ; lecture
  réservée à la liste blanche, aucun mot de passe ni secret affiché.
- **Actions** — activité **par compte** : agrège `analytics_events` (images,
  vidéos, chat, projets, enhancer, batch, erreurs) pour chaque `user_id`,
  croise avec `profiles` pour afficher nom et e-mail, indique la dernière
  action. Ne voit que les événements produits par un compte connecté.
- **Limites et quotas** — quotas journaliers par outil (images pondérées par
  résolution : 1K = 1, 2K = 2, 3K = 3), quotas distincts pour les
  administrateurs, **limite globale** journalière, **interruption d'urgence**
  (suspend / réactiver toutes les générations), et **consommation du jour**
  par compte. Toute modification est journalisée.
- **Journal** — trace d'audit du back-office (`public.admin_logs`) : date,
  administrateur (auteur forcé côté serveur par trigger), action, cible,
  détail. Insert + select uniquement ; la modification / retrait de clé
  y laisse automatiquement une entrée, **jamais la valeur de la clé**.
- **Paramètres** — état de la connexion, session, fréquence d'actualisation,
  déconnexion, et les **clés du fournisseur** :
  - *« Clés du fournisseur par outil »* — 3 champs (images / vidéos / chat),
    compteur `n / 3 actives`, aperçu `••••1234` uniquement,
    `Enregistrer les 3 clés` (champ vide = on garde la clé partagée) et
    `Tout retirer` ;
  - *« Clé partagée (secours) »* — état « aucune clé / configurée » masquée
    `••••1234`, champ pour enregistrer une nouvelle clé, bouton
    `Retirer la clé`.

  Les clés sont stockées dans `app_settings` : visibles et modifiables
  **uniquement** par les comptes de la liste blanche, jamais renvoyées aux
  visiteurs ; effective côté passerelle sous ~30 s.

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
git commit -m "v3.16.6 : remboursement de quota aligne sur la consommation (memoire ou base)"
git branch -M main
git remote add origin https://github.com/<vous>/lsv-ai.git
git push -u origin main
```

Vérifier avant commit :

```bash
git status                    # aucun .env, aucun node_modules
npm test                      # 969 assertions, 6 suites
git grep -n "service_role" -- scripts shared analytics admin studio *.html
                              # ne doit rien trouver : `service_role` n'existe
                              # que dans supabase/ et tests/ (SQL + Edge Functions)
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

1. **Déployer la LSV API Gateway** (§2.4), puis saisir la **clé du
   fournisseur** dans `/admin/` → **Paramètres** (ou injecter `AGNES_API_KEY`).
2. **Déployer `lsv-contact`** (§2.14) : migration SQL + fonction + secrets du
   fournisseur d'e-mail.
3. Remplir `shared/config.js` avec les vraies valeurs, committer, push.
4. **Exécuter le SQL** (§4.2) puis **ajouter son e-mail dans `admin_emails`**.
5. Ouvrir `https://<vous>.github.io/lsv-ai/` → générer une image (doit passer
   par `…/functions/v1/lsv-gateway/v1/images/generations`) et soumettre un
   message depuis `/contact/` (§2.14).
6. Ouvrir `https://<vous>.github.io/lsv-ai/admin/` → se connecter, vérifier
   que le dashboard se remplit (sinon : « Compte non autorisé » → §4.2).
7. **Redéployer la Gateway** après toute modification de
   `supabase/functions/lsv-gateway/` — §2.15 (image de référence depuis la
   bibliothèque) en fait partie : sans redéploiement, une URL de création
   transmise à l'amont reste une URL et n'est pas encodée.

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
| `AGNES_API_KEY` | **secret serveur de secours** de la Gateway (Supabase Secrets) | ❌ non |
| Clés du fournisseur | saisies dans `/admin` → Paramètres → table `app_settings` (RLS liste blanche) : une dédiée par outil + une clé partagée | ❌ non |
| `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `EMAIL_FROM` | fournisseur d'e-mail de `lsv-contact` (Brevo ou Resend) — la clé ne quitte jamais le serveur | ❌ non |
| `CONTACT_AUTO_REPLY` / `CONTACT_RATE_PER_*` | réglages optionnels de `lsv-contact` | ❌ non |
| `service_role` key | **jamais** utilisée par le front | ❌ non |
| Mot de passe base | uniquement dans Supabase | ❌ non |
| Mot de passe admin | uniquement dans Supabase Auth (haché) | ❌ non |

Les clés du fournisseur de génération n'existent **que** côté serveur : secret
de la fonction ou table `app_settings` (protégée par RLS, lue par la passerelle
avec la clé de service) — une dédiée par outil **plus** une clé partagée de
secours (§2.12). Jamais dans `index.html`, `admin/`, `analytics/`, `shared/`,
`localStorage` ni dans Git (`tests/public.test.js` le vérifie) — dans le
back-office elles n'apparaissent masquées que sous forme `••••1234`.

---

## 9. Tests

```bash
npm test        # 969 assertions (6 suites, hors ORIG=… voir plus bas)
```

**`tests/nonreg.test.js`** (54 assertions, **66 avec `ORIG`**) — non-régression

- structure HTML et `body.innerHTML` identiques à l'original, hors blocs
  volontairement supprimés (clé API, console, infos fournisseur) **et hors
  section « Compte » + page de connexion ajoutées** —
  `ORIG=/chemin/index.original.html npm test` ;
- navigation sur les 14 onglets sans exception ;
- génération d'image simulée **sans aucune clé** : succès + échec, requête
  envoyée à la Gateway, `Authorization` = JWT anon LSV, aucun `sk-` ;
- génération de vidéo simulée (création de tâche + polling) : succès ;
- Chat IA simulé (repli JSON) : conversation, réponse rendue ;
- sanitisation Analytics, config absente, panne réseau, module absent.

**`tests/public.test.js`** (228 assertions) — interface publique + sécurité

- éléments techniques absents (champ/statut/bouton de clé, console LSV) ;
- scan du contenu public contre `Agnes`, `agnes-*`, `apihub`, `Bearer`, `sk-`,
  `Authorization`, `Console LSV`, `Endpoint`, `Polling`, `Token`… ;
- génération sans clé : rien en `localStorage`, requête vers la Gateway ;
- erreur amont → toast générique (aucun code HTTP, endpoint, jeton) ;
- aucun `sk-` dans `index.html` ni dans les fichiers publics ;
- admin : pas de lien public, pas de mot de passe en dur, RLS en lecture
  authentifiée **et listée** uniquement (`is_admin`), table `app_settings`
  sans aucun droit pour `anon` ;
- comptes : section fermée par défaut, échec de connexion → message générique,
  connexion OK → e-mail affiché, back-office masqué hors liste blanche,
  aucune donnée secrète en `localStorage` ;
- **inscription avec nom complet** : champ masqué en mode connexion, visible
  en inscription, refus sans nom (zéro requête), `full_name` bien transmis,
  nom affiché avec l'e-mail ;
- **page de connexion plein écran** : fermée par défaut, ouverte par le bouton
  et par « création sans compte », fermée après connexion / par le fond /
  `Échap`, titres et champs suivent le mode, œil afficher-masquer,
  mot de passe oublié (refus sans e-mail, `POST /recover` simulé) ;
- **création bloquée sans compte** : aucune requête image/chat émise, toast
  d'invitation, page de connexion ouverte, champ de saisie conservé ;
- **profils (noms)** : table `profiles` liée à `auth.users` (nom, e-mail, dernière
  connexion), RLS sans aucun droit `anon`, lecture « soi-même ou liste blanche »,
  remplissage automatique par trigger, aucune colonne secrète ;
- **messages d'erreur** : codes GoTrue (`email_not_confirmed`, `weak_password`…)
  traduits en messages clairs, sans détail technique ;
- **retour des liens Supabase** : confirmation (`?code=`) → toast « E-mail
  confirmé », lien expiré → « Lien invalide ou expiré », URL nettoyée, modale
  fermée, aucune fuite de détail technique ;
- **marque & SEO** : lien « À propos » dans le studio, `a-propos/` (LeStudioViral,
  Salaou Souleyman, métiers, boutiques, JSON-LD Person/Organization), meta/canonical/OG de
  l'app, `robots.txt` (admin interdit) et `sitemap.xml` ;
- **page d'accueil & boutiques** : accueil de première visite (héros, galerie
  V1 + 6 images + V2 en bas de page, fonctionnalités, étapes, stats, boutiques,
  CTA), visiteur toujours renvoyé à l'accueil, déconnexion renvoyant à
  l'accueil, galerie sans badges ni légendes, liens réels des boutiques
  (`rxorzera` / `blgbiwds`), aucun lien interne `index.html`, page À propos
  épurée, erreurs d'inscription génériques.
- **SEO renforcé** (recherche Google 2026 appliquée) : `og:image` +
  `twitter:image` (carte large) sur les 2 pages, `robots` (index, follow,
  max-image-preview:large), `apple-touch-icon`, `preload` logo (LCP), JSON-LD
  `WebSite` + `Organization` (avec logo) + `SoftwareApplication`, `llms.txt`
  (indexation IA), `sitemap.xml` avec `lastmod`, images avec `alt` descriptifs,
  `loading="lazy"` + `decoding="async"` + `width`/`height` (anti-CLS).
- **image de référence depuis la bibliothèque** (§2.15) : onglets
  appareil/bibliothèque avec `role="tab"` + `aria-selected`, état vide
  orientant vers l'onglet Image, grille limitée aux créations d'image,
  sélection unique en Image→Vidéo et double en Keyframes, dédup, refus
  annoncé par toast, parcours fichier historique intact — et **aucun `fetch`
  de l'URL côté client**.
- **architecture modulaire** : `index.html` réduit à un squelette HTML
  (~1 230 lignes au lieu de ~7 000) ; CSS en 6 fichiers `styles/`, JS en 8
  modules `scripts/` chargés dans un ordre fixe ; `window.LSV` et toute l'API
  publique inchangés ; scans de sécurité étendus à tout le bundle ; §12 de
  `public.test.js` verrouille la structure (pas de `<style>` ni de gros script
  inline, 14 modules présents et ordonnés).

**`tests/gateway.test.mjs`** (220 assertions) — passerelle

- routage (y compris préfixe `/functions/v1/lsv-gateway`), injection de la clé
  serveur, rejet de l'authorization client ;
- CORS (origine autorisée / interdite / preflight) ;
- rate limit 60 s avec `Retry-After`, quotas journaliers + réinitialisation ;
- erreurs amont sanitisées (401/500/réseau → message générique, aucun détail) ;
- clé absente → 503, aucun secret dans aucune réponse ;
- **clé du back-office** : lue dans `app_settings` (une lecture par minute —
  cache), injectée dans l'en-tête amont, jamais renvoyée au client ; table
  vide ou lecture en échec → repli sur le secret serveur ; ni l'un ni l'autre
  → 503 ; clé de service lue dans `SUPABASE_SERVICE_ROLE_KEY` ou
  `SUPABASE_SECRET_KEYS` ;
- **image de référence** (§2.15) : `data:` transmis tel quel, URL http(s)
  téléchargée une seule fois, borne de 20 Mo, refus d'un corps non image ou
  vide, échec réseau/HTTP signalé ; `resolveVideoRefs` ne convertit que
  `first_frame` et `last_frame`, JSON illisible sans effet de bord ; dans le handler,
  fichier d'appareil inchangé, `/v1/images/generations` non converti, URL
  morte → 400 **avant** tout appel au fournisseur et sans fuite de détail ;
- **identifiant de requête** (§2.16) : `x-lsv-request-id` présent sur chaque
  réponse, `Access-Control-Expose-Headers` couvrant tous les en-têtes `x-lsv-*`
  (les compteurs de quota étaient auparavant invisibles du navigateur),
  identifiant repris dans les journaux `amont-status` / `amont-reseau` avec le
  vrai statut amont et son extrait, les trois 503 (pas de clé / suspendu /
  amont) distinguables, et **aucun détail technique dans la réponse** ;
- **remboursement de quota** (§2.17) : la RPC `consume_quota` en échec (400)
  bascule sur le compteur mémoire, et une génération qui n'aboutit pas rend
  l'unité **en mémoire** — l'endroit exact d'où elle vient ; même garantie pour
  un visiteur non connecté, et `refund_quota` en échec désormais journalisé
  (`refund-rpc-status`) au lieu d'échouer en silence.

**`tests/admin.test.js`** (158 assertions)

- configuration absente / non authentifié → dashboard inaccessible ;
- mauvais identifiants → accès refusé ;
- identifiants valides → dashboard + KPI + graphiques rendus ;
- 9 pages + 4 plages temporelles sans exception ;
- session expirée (RLS) → retour connexion ; déconnexion → données effacées ;
- **inscription** depuis l'écran de connexion : champ **nom complet** requis
  (masqué en mode connexion), refus sans nom, `full_name` transmis, création →
  dashboard si listé, confirmation e-mail si requise ;
- **compte hors liste blanche** → « Compte non autorisé », zéro donnée ;
- **clé du fournisseur** dans Paramètres : refus (< 8 caractères), enregistre,
  affiche `••••1234` (jamais la valeur), retrait → état initial ;
- **clés par outil** (§2.12) : 3 champs, refus d'une clé trop courte,
  enregistrement des 3 en une seule écriture, persistance `app_settings`,
  compteur `n / 3`, valeurs masquées, retrait global, et journal d'audit
  **sans** la valeur des clés ;
- **page Utilisateurs** : nav + titre + table des comptes (`profiles`) avec nom,
  e-mail, inscription, dernière connexion, KPI (comptes, avec nom, déjà
  connectés), aucun secret affiché, actualisation sans erreur ;
- **favicon + mode sombre** : `<link rel="icon">` et `apple-touch-icon`
  présents dans `admin/index.html`, palette `html.dark` dans `admin.css`,
  bouton de bascule sur le dashboard **et** sur l'écran de connexion,
  synchronisation des icônes, mémorisation `localStorage`, aucun flash au
  démarrage ;
- **détail des erreurs lisible** (§2.16) : signature affichée **en entier**
  (elle était coupée à 70 caractères), colonne **HTTP** avec badge, identifiant
  de requête isolé sous la signature, renvoi vers la ligne `amont-status` des
  journaux de la passerelle, 503 et 502 regroupés **séparément** (la
  normalisation les fusionnait), et le texte complet au survol du fil
  d'activité ;
- aucun mot de passe codé en dur, aucune `service_role`.

**`tests/studio.test.js`** (155 assertions) — LSV Studio (`/studio/`, §12)

- ouverture, rendu des panneaux, import de média, timeline ;
- ratios visuels (`RATIOS`, grille rendue par `UI.renderRatioGrid`) ;
- import depuis la bibliothèque LSV.ai (`studio/core/library-import.js`) :
  dédup `media.sourceUrl`, signalement CORS, IndexedDB ;
- aucune clé, aucun `sk-`, aucune `service_role` dans le bundle Studio.

**`tests/contact.test.mjs`** (154 assertions) — formulaires + `lsv-contact`

- validation (bornes, e-mail, CRLF, canal inconnu, troncatures) ;
- canaux `founder` / `site` et leur destinataire respectif ;
- CORS (origine autorisée vs refusée), OPTIONS, 405, corps trop volumineux ;
- honeypot + anti-bot temporel (réponse identique à un succès) ;
- double rate limit : mémoire (3/min, 20/j) et SQL (`submit_contact`) ;
- ordre garanti : **base d'abord**, puis notification, puis diagnostic, puis
  accusé — un bot ne peut pas faire consommer des envois puis être refusé ;
- pannes : fournisseur absent → `stored`, fournisseur en panne → message en
  base, ni base ni e-mail → `502`, rate limit SQL → 429 sans aucun e-mail ;
- modèles d'e-mail : HTML complet, contenu utilisateur échappé, mailto codé,
  aucun jeton, thème de la marque ;
- migration `upgrade-contact.sql` : RLS, `revoke` de `anon`/`authenticated`,
  bornes de longueur, canal contraint ;
- **rendu réel sous jsdom** : `contact/` et `a-propos/` chargent sans erreur JS,
  auto-initialisent le formulaire, soumettent et réinitialisent, footer rendu,
  portrait `pdg.png` à la bonne source ;
- **visionneuse du portrait** : vignette en `<button>` avec `aria-haspopup`,
  ouverture au clic, fermeture par le bouton et par le clic sur le fond,
  focus restitué à la vignette, clic sur l'image (hors fond) sans fermeture.

---

## 10. Limites connues (volontaires)

- **Comptes « légers »** : inscription/connexion obligatoire pour **créer**
  (image, vidéo, chat, enhancer, batch) + liste blanche pour le back-office,
  mais pas encore d'espace personnel de synchronisation (projets / historique
  dans le cloud), pas de rôles multiples, pas d'abonnement ni de paiement.
  Les données locales (projets, bibliothèque, historique) restent consultables
  sans compte — elles ne consomment rien.
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
- **Clé du fournisseur en base** : la passerelle la relit au plus une fois par
  minute (cache) → un changement depuis le back-office prend effet sous ~30 s
  et par isolate. Si la base est injoignable, le secret serveur reprend la main.
- **Noms de modèles encore présents dans `index.html`** (constantes `MODEL_*`) :
  ils ne sont jamais affichés à l'écran (testé), mais restent lisibles dans le
  source. Pour les retirer aussi, les faire injecter par la Gateway.
- CSS des blocs supprimés (`.api-mini`, `.debug*`) conservé mais inutilisé :
  aucun rendu, purge possible ultérieurement.

---

## 11. LSV.ai — accès rapide

L'application est prête pour le public : ouvrir `index.html`, **créer un compte**
(section Compte, une fois) et utiliser Images, Vidéos, Chat IA, Motion,
Storyboard, Workflows, Cohérence, Batch, Projets et Bibliothèque **sans saisir
aucune clé**. Sans compte, la consultation reste ouverte mais toute génération
est refusée. Deux autres conditions : la Gateway (§2.4) doit être déployée,
sinon les boutons de génération restent inactifs (et non pas « cassés »), et
ton e-mail doit être dans `admin_emails` pour ouvrir `/admin/` (§4.2).

---

## 12. LSV Studio — montage vidéo local (`/studio/`)

Éditeur vidéo **100 % local** dans le navigateur, accessible depuis le lien
« Studio vidéo » de la sidebar. Aucune requête réseau, aucun compte requis,
aucun quota consommé : le montage n'utilise jamais la Gateway ni les modèles
IA. Tout (projets, médias, export) reste sur l'appareil.

### 12.1 Ce qu'il fait

- **Projets locaux** en IndexedDB : création, ouverture, suppression, export /
  import d'un fichier `.lsvstudio.json` (sans les médias).
- **Import** de vidéos (MP4, MOV, WEBM), images (PNG, JPG, WEBP) et sons
  (MP3, WAV, M4A) par glisser-déposer ou sélecteur de fichiers.
- **Import direct depuis LSV.ai** (v3.13.0) : le panneau Médias affiche une
  section « Depuis LSV.ai » listant les créations déjà générées sur le site
  (même origine → lecture du `localStorage` du site, aucun compte requis).
  Un clic ou `Tout importer` récupère le média **en Blob** et le stocke dans
  IndexedDB : plus besoin de télécharger puis re-téléverser, et une URL
  signée qui expirerait chez le fournisseur n'entraîne plus la perte du média.
  Si le navigateur refuse la récupération (CORS), un message explicite propose
  le repli « télécharger depuis la Bibliothèque, puis déposer » — l'import
  n'est jamais simulé. Déduplication sur l'URL source (`media.sourceUrl`).
- **Timeline multipiste** (vidéo, overlay, texte, audio) : déplacement,
  recadrage aux poignées, scission à la tête de lecture (touche `S`),
  duplication (`Ctrl+D`), suppression (`Suppr`), aimantation sur les bords.
- **Panneau Propriétés** : vitesse, volume, opacité, texte (taille, couleur,
  contour, alignement), effets (luminosité, contraste, saturation, flou),
  transitions d'entrée/sortie (fondu, glissement, zoom).
- **Annuler / rétablir** (60 niveaux, `Ctrl+Z` / `Ctrl+Maj+Z`).
- **Export vidéo** en temps réel via `MediaRecorder` + `canvas.captureStream` :
  MP4/H.264 quand le navigateur le sait, sinon WebM. L'extension suit
  toujours le conteneur réel — aucun renommage de fichier.
- **Mode sombre** partagé avec LSV.ai (même clé `lsv4_theme`).

### 12.2 Comment l'export fonctionne (et ses limites)

L'export est **en temps réel** : une vidéo de 30 s met ~30 s à se produire.
C'est le prix d'une absence totale de dépendance native — pas de FFmpeg.wasm
(GitHub Pages n'offre pas COOP/COEP, donc pas de `SharedArrayBuffer`), pas de
transcodage serveur. Le mixage audio passe par Web Audio ; si le navigateur
ne l'expose pas, l'export est muet mais reste utilisable.

Le choix du conteneur (MP4 vs WebM) est détecté à l'ouverture de la page via
`MediaRecorder.isTypeSupported` et affiché dans l'écran d'accueil ainsi que
dans le panneau Propriétés (aucun réglage à faire).

### 12.3 Stockage et sauvegarde

Les projets vivent dans IndexedDB, **sur cet appareil uniquement** : une
sauvegarde locale n'est pas une sauvegarde cloud. Le bouton « Projet »
exporte la structure au format JSON (sans les binaires) ; à réimporter
ailleurs, les médias sont marqués « manquant » et doivent être re-reliés un
par un. Un projet dont le schéma provient d'une version plus récente est
refusé proprement (jamais corrompu à l'ouverture).

### 12.4 Tests

`npm run test:studio` (inclus dans `npm test`) vérifie : intégration sidebar,
structure des 5 zones, détection des capacités, thème partagé, absence
d'appel réseau et de clé secrète, ordre de chargement des modules, modèle de
projet (validations d'imports hostiles), modèle de timeline (chevauchements,
scission, recadrage, aimantation), historique, effets/transitions, export
(preflight), mixage audio et **import depuis la bibliothèque LSV.ai** (lecture
du `localStorage` du site, déduplication, échec CORS signalé, `importMany`).
L'export réel et le rendu canvas ne sont pas automatisables sous jsdom : voir
la checklist manuelle du dépôt.

### 12.5 Checklist manuelle (avant une release)

1. Ouvrir `/studio/` → l'écran d'accueil s'affiche sans erreur console.
2. Créer un projet → le format de séquence proposé est bien 1080×1920.
3. Importer 2 images + 1 vidéo → vignettes présentes, durées affichées.
4. Déposer les 3 médias sur la timeline → 3 clips, ordre chronologique.
5. Ajouter un texte (`Texte`) → le clip apparaît, le panneau Propriétés
   s'ouvre sur le texte.
6. Déplacer un clip, en recadrer un, scinder à la tête de lecture.
7. `Ctrl+Z` trois fois puis `Ctrl+Maj+Z` deux fois → l'état suit.
8. Exporter 5 s → un fichier est téléchargé, l'extension correspond au
   conteneur annoncé à l'accueil, la vidéo est lisible.
9. Recharger la page → le projet est toujours dans la liste, état intact.
10. Basculer le mode sombre → l'application principale suit au retour.
11. **Ratio** : sur l'onglet Image, vérifier que 5 rectangles aux proportions
    réelles s'affichent (9:16 sélectionné par défaut) ; en cliquant sur 16:9,
    la génération produit bien 2624×1472. Même chose en Vidéo (3 ratios).
12. **Bibliothèque** : générer au moins une image sur LSV.ai, ouvrir
    `/studio/` → la section « Depuis LSV.ai » liste la création ; un clic
    l'importe sans téléchargement. Un déjà-importé affiche une coche.
