# LSV.ai — Studio Viral v3

Application créative web : **Images · Vidéos · Chat IA · Motion · Projects · Library**, alimentées par les APIs Agnes AI.

Cette version ajoute une couche **extension** autour de l'application (qui n'a pas été refaite) :

- **Analytics** anonymes et non bloquants ;
- **Back-office admin** (`/admin`) avec authentification réelle ;
- **Architecture GitHub-ready** (front statique + service externe).

```text
LSV.ai
│
├── Application créative existante (inchangée)
│   Images · Vidéos · Chat IA · Motion · Projects · Library
│
├── Analytics            → analytics/analytics.js
│
└── Back-office Admin    → /admin
    Connexion · Dashboard · Visiteurs · Images · Vidéos · Chat
    Motion · Activité · Erreurs · Paramètres
```

---

## 1. Architecture

```text
Navigateur (GitHub Pages — statique)
   │
   ├── index.html            application LSV.ai (publique)
   │      └── analytics/analytics.js  →  POST asynchrone (non bloquant)
   │
   └── admin/                back-office (page publique, données protégées)
          └── Supabase JS SDK
                 │
                 ▼
        Supabase (service externe)
        ├── Auth        : e-mail + mot de passe → JWT (vérifié côté serveur)
        └── Postgres    : table analytics_events + Row Level Security
                 │
                 ▼
        Dashboard admin (lecture = compte authentifié uniquement)
```

### Arborescence

```text
lsv-ai/
│
├── index.html                 # Application LSV.ai (modifiée : + hooks Analytics)
│
├── analytics/
│   └── analytics.js           # Module Analytics indépendant et tolérant aux pannes
│
├── shared/
│   └── config.js              # Configuration commune (URL + clé anon Supabase)
│
├── admin/
│   ├── index.html             # Back-office (connexion + dashboard)
│   ├── admin.css              # Design admin (identité LSV.ai)
│   └── admin.js               # Auth, chargement, agrégats, graphiques
│
├── supabase/
│   └── schema.sql             # Table + RLS + indexes (à exécuter une fois)
│
├── tests/
│   ├── nonreg.test.js         # Non-régression LSV.ai + unités Analytics
│   └── admin.test.js          # Scénarios d'accès admin (§24)
│
├── package.json               # Scripts de test (devDependency : jsdom)
├── .env.example               # Modèle de variables (aucun secret réel)
├── .gitignore
└── README.md
```

---

## 2. Ce qui n'a **pas** été touché

Aucune couleur, typographie, animation, modal, galerie, prompt, logique de
génération, endpoint Agnes, modèle Agnes, paramètre de génération ni le
système de clé API n'ont été modifiés.

`index.html` a reçu uniquement **34 lignes ajoutées** (0 ligne supprimée) :

| Emplacement | Ajout |
|---|---|
| avant le bloc `<script>` principal | 2 balises `<script src>` + shim de sécurité |
| `UI.switchTab` | 1 ligne `track('tab_view')` |
| `ProjectService.create` | 1 ligne `track('project_created')` |
| `ChatView.sendMessage` | 2 lignes (succès / erreur) |
| `EnhancerView.generate` | 2 lignes (succès / erreur) |
| `BatchView.runOne` | 2 lignes (succès / erreur) |
| `Handlers.runImageGeneration` | 2 blocs (succès / erreur) |
| `Handlers.runVideoGeneration` | 2 blocs (succès / erreur) |

Chaque appel passe par `LSVAnalytics.track()`, qui est **intercepté par un shim**
si le module ne se charge pas : la fonctionnalité ne peut donc jamais lever
d'erreur à cause d'Analytics.

---

## 3. Installation locale

```bash
git clone <url-du-repo> lsv-ai
cd lsv-ai
npm install        # uniquement pour les tests (jsdom)
npm test           # lance les deux suites de tests
```

Ouvrir simplement `index.html` (double-clic) : l'application fonctionne
telle quelle. **Sans configuration Supabase, Analytics est inactif** et le
back-office affiche la page de connexion avec un message d'explication.

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

Ce script crée :

- la table `analytics_events` (insert anonyme autorisé, **lecture réservée aux
  comptes authentifiés**, pas de UPDATE/DELETE anon) ;
- une **liste blanche d'événements** (un inconnu ne peut pas injecter de n'importe
  quel événement) ;
- un contrôle de taille de payload (< 4 Ko) ;
- les index nécessaires.

### 4.3 Créer le compte administrateur

1. Dashboard → **Authentication** → **Users** → **Add user** → *Create new user*.
2. Saisir un e-mail et un mot de passe forts → **Create user**.
3. **IMPORTANT** : Authentication → **Sign In / Providers** → **Email** →
   désactiver **Enable Sign Ups** (personne ne peut s'auto-inscrire).

### 4.4 Récupérer les identifiants publics

Dashboard → **Project Settings** → **API** :

- **Project URL** → `SUPABASE_URL`
- **anon / public** key → `SUPABASE_ANON_KEY`

### 4.5 Les renseigner

Éditer `shared/config.js` :

```js
window.LSV_CONFIG = {
    SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOi...'
};
```

> Ces deux valeurs sont **publiques par conception** (clé `anon` destinée à être
> embarquée dans le navigateur). Ce ne sont **pas** des secrets : toute la
> sécurité repose sur les politiques RLS et sur Supabase Auth.
> La `service_role` key et le mot de passe base de données ne doivent **jamais**
> apparaître dans le dépôt (`.env.example` le rappelle).

---

## 5. Back-office `/admin`

URL : `https://<votre-site>/admin/`

```text
/admin
   ↓
Page de connexion
   ↓
Supabase Auth (vérification côté serveur — hachage du mot de passe)
   ↓
JWT de session (rafraîchi automatiquement, stocké par le SDK)
   ↓
Dashboard (lectures soumises à la RLS)
```

Comportements attendus :

| Situation | Résultat |
|---|---|
| Non authentifié | ❌ dashboard inaccessible, page de connexion |
| Mauvais identifiants | ❌ « Identifiants incorrects » |
| Session expirée | ❌ retour automatique à la connexion |
| URL connue sans compte | ❌ aucune donnée affichée (RLS refuse) |
| Supabase/CDN indisponible | ❌ message d'erreur, aucun crash |

### Pages du dashboard

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

### 6.2 Ce qui n'est **jamais** envoyé

- prompts, contenus de conversation ;
- URLs d'images / vidéos ;
- clés API, tokens, Authorization ;
- noms de fichiers, data-URI ;
- données personnelles (aucun compte utilisateur côté public).

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

1. Remplir `shared/config.js` avec les vraies valeurs, committer, push.
2. Ouvrir `https://<vous>.github.io/lsv-ai/admin/` → se connecter.
3. Vérifier que le dashboard s'affiche et que des événements arrivent en
   ouvrant `https://<vous>.github.io/lsv-ai/`.

**Note sur les chemins** : tous les liens sont **relatifs** (`./admin/`,
`../shared/config.js`) → le site fonctionne aussi bien à la racine que dans
un sous-dossier GitHub Pages (`/lsv-ai/`).

---

## 8. Variables et secrets

| Fichier | Contenu | Commité ? |
|---|---|---|
| `shared/config.js` | URL Supabase + clé `anon` (public) | ✅ oui |
| `.env.example` | modèle commenté | ✅ oui |
| `.env` | éventuel, hors dépôt | ❌ non (`.gitignore`) |
| `service_role` key | **jamais** utilisée par le front | ❌ non |
| Mot de passe base | uniquement dans Supabase | ❌ non |
| Mot de passe admin | uniquement dans Supabase Auth (haché) | ❌ non |

---

## 9. Tests

```bash
npm test
```

**`tests/nonreg.test.js`** (49 assertions)

- structure HTML identique à l'original (`ORIG=/chemin/index.original.html npm test`) ;
- `body.innerHTML` identique hors scripts ;
- navigation sur les 14 onglets sans exception ;
- génération d'image simulée : succès + échec, appel Agnes inchangé ;
- génération de vidéo simulée (création de tâche + polling) : succès, modèle inchangé ;
- Chat IA simulé (repli JSON) : conversation, réponse rendue ;
- sanitisation Analytics (clés API/prompts/tokens jamais envoyés) ;
- config absente → aucun envoi ;
- réseau en panne → LSV.ai continue ;
- module Analytics totalement absent → LSV.ai continue.

**`tests/admin.test.js`** (31 assertions)

- configuration absente / non authentifié → dashboard inaccessible ;
- mauvais identifiants → accès refusé ;
- identifiants valides → dashboard + KPI + graphiques rendus ;
- 8 pages + 4 plages temporelles sans exception ;
- session expirée (RLS) → retour connexion ;
- déconnexion → données effacées ;
- aucun mot de passe codé en dur, aucune `service_role`.

---

## 10. Limites connues (volontaires)

- **Un seul administrateur**, pas de rôles multiples, pas d'abonnement, pas de
  paiement, pas de comptes utilisateurs côté public → par choix pour cette phase.
- **Motion Control** n'est pas encore implémenté dans LSV.ai : le dashboard
  compte les ouvertures de l'onglet ; `motion_generated` est prêt à l'emploi.
- Le volume est pensé pour quelques milliers d'événements/jour (limite de 20 000
  lignes lues par requête). Au-delà, ajouter une agrégation serveur (vue SQL).
- L'insertion anonyme est ouverte (nécessaire pour un site public) : en cas
  d'abus possible, activer la policy « liste blanche d'e-mails » commentée dans
  `supabase/schema.sql`, ou poser un rate-limit Cloudflare devant Pages.

---

## 11. LSV.ai — accès rapide

L'application principale n'a pas changé : ouvrir `index.html`, renseigner la
clé API Agnes dans le panneau de configuration, puis utiliser Images, Vidéos,
Chat IA, Motion, Storyboard, Workflows, Cohérence, Batch, Projets et
Bibliothèque comme auparavant.
