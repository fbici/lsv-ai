# LSV.ai — Studio Viral v3.6.0

Application créative web : **Images · Vidéos · Chat IA · Motion · Projects · Library**.

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
├── a-propos/                 # Page « À propos » (URL propre : /a-propos/)
│   └── index.html            #   LeStudioViral · Salaou Souleyman · boutiques
├── assets/showcase/          # 1.jpg…6.jpg (tes créations) + 1.svg…6.svg (démo)
├── lsv.jpg                   # Logo officiel de la marque
├── robots.txt               # SEO : robots autorisés, /admin/ interdit, sitemap
├── sitemap.xml              # SEO : plan du site (studio + à propos)
│
├── supabase/
│   ├── schema.sql             # Tables + RLS + indexes (à exécuter une fois)
│   ├── upgrade-admin-whitelist.sql  # Migration : liste blanche admin
│   ├── upgrade-profiles.sql   # Migration : noms des comptes (profiles)
│   ├── email-confirm-signup.html    # Modèle d'e-mail « confirme ton compte »
│   ├── email-reset-password.html    # Modèle d'e-mail « mot de passe oublié »
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

## 2. Changements de cette version : Gateway + comptes + clé en back-office

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
#    a) RECOMMANDÉ : back-office → Paramètres → « Clé du fournisseur » (§5.3)
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
| *(table `app_settings`)* | **clé du fournisseur saisie dans le back-office** — prioritaire, relue toutes les 60 s | — |
| `AGNES_API_KEY` | **secret serveur de secours**, utilisé si la table est vide | — (recommandé) |
| `AGNES_API_BASE` | base amont (secret de configuration) | valeur interne |
| `ALLOWED_ORIGINS` | origines CORS autorisées | GitHub Pages + localhost |
| `RATE_LIMIT_PER_MIN` | requêtes / minute / IP + / visiteur | `10` |
| `IMAGE_LIMIT` | images / jour / visiteur | `0` = illimité |
| `VIDEO_LIMIT` | vidéos / jour / visiteur | `0` = illimité |
| `CHAT_LIMIT` | messages / jour / visiteur | `0` = illimité |
| `MOTION_LIMIT` | motions / jour / visiteur | `0` = illimité |
| `MAX_BODY_BYTES` | taille max d'une requête | `20` Mo |

Ordre de résolution de la clé côté serveur : **`app_settings` (saisie dans le
back-office)** → sinon **`AGNES_API_KEY` (secret)**. Une lecture de base au plus
par minute et par isolate ; la valeur n'est jamais renvoyée au navigateur.

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
| **Clé du fournisseur** | back-office → **Paramètres** → « Clé du fournisseur » : champ masqué + `Enregistrer la clé` → table `app_settings` (RLS : **liste blanche uniquement**, aucun droit pour `anon`) ; la Gateway la lit côté serveur, avec priorité sur le secret `AGNES_API_KEY` |
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
| **Galerie « Créé avec LSV.ai »** | 6 visuels (prompts + tags) — visuels SVG livrés, et dépose de **tes** images générées dans `assets/showcase/1.jpg`…`6.jpg` qui les remplacent automatiquement (repli SVG) |
| **Sections complètes** | fonctionnalités (6 cartes), « Comment ça marche » (3 étapes), bandeau de stats, **boutiques**, CTA final, pied de marque |
| **Première visite → compte** | « Commencer » sans compte ouvre l'inscription ; le dashboard de création n'apparaît qu'une fois le compte créé (drapeau `localStorage.lsv4_welcome`) |
| **Boutiques en ligne** | liens réels sur l'accueil **et** sur la page À propos : [Boutique LeStudioViral](https://rxorzera.mychariow.shop) (`SHOP_1_URL`) et [Académie Digital](https://blgbiwds.mychariow.shop) (`SHOP_2_URL`) |
| **URL propres** | plus aucun lien interne vers `index.html` : accueil `…/lsv-ai/`, à propos `…/a-propos/`, back-office `…/admin/` |
| **Onglets du navigateur** | titres de pages explicites + favicon `lsv.jpg` |
| **Texte sous les formulaires retiré** | la mention « Les mots de passe sont vérifiés… » sous la page de connexion a été supprimée |
| **Erreurs d'inscription plus claires** | échec d'envoi de l'e-mail de confirmation (SMTP non configuré) ou limite d'envoi : messages explicites au lieu de « Opération impossible » |

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
   *(Base déjà créée ? exécuter `supabase/upgrade-admin-whitelist.sql`,
   puis `supabase/upgrade-profiles.sql`.)*
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
- la table `app_settings` (clé du fournisseur saisie dans le back-office :
   RLS activée, **aucun droit pour `anon`**, lecture/écriture réservées à
   `is_admin()`) ;
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
>    → *Enable custom SMTP* → `smtp-relay.brevo.com`, port `587` (secours
>    `2525` ou `465`+SSL), SMTP login + SMTP key de Brevo, e-mail validé comme
>    expéditeur, nom d'expéditeur `LSV.ai` → Save.
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
- **Paramètres** — état de la connexion, session, fréquence d'actualisation,
  déconnexion, et **Clé du fournisseur** (état « aucune clé / configurée »
  masquée `••••1234`, champ pour enregistrer une nouvelle clé, bouton
  `Retirer la clé`). La clé est stockée dans `app_settings` : visible et
  modifiable **uniquement** par les comptes de la liste blanche, jamais
  renvoyée aux visiteurs ; effective côté passerelle sous ~1 minute.

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

1. **Déployer la LSV API Gateway** (§2.4), puis saisir la **clé du
   fournisseur** dans `/admin/` → **Paramètres** (ou injecter `AGNES_API_KEY`).
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
| `AGNES_API_KEY` | **secret serveur de secours** de la Gateway (Supabase Secrets) | ❌ non |
| Clé du fournisseur | saisie dans `/admin` → Paramètres → table `app_settings` (RLS liste blanche) | ❌ non |
| `service_role` key | **jamais** utilisée par le front | ❌ non |
| Mot de passe base | uniquement dans Supabase | ❌ non |
| Mot de passe admin | uniquement dans Supabase Auth (haché) | ❌ non |

La clé du fournisseur de génération n'existe **que** côté serveur : secret de
la fonction ou table `app_settings` (protégée par RLS, lue par la passerelle
avec la clé de service). Jamais dans `index.html`, `admin/`, `analytics/`,
`shared/`, `localStorage` ni dans Git (`tests/public.test.js` le vérifie) —
dans le back-office elle n'apparaît masquée que sous forme `••••1234`.

---

## 9. Tests

```bash
npm test        # 334 assertions (346 avec ORIG=… voir plus bas)
```

**`tests/nonreg.test.js`** (41 assertions, **53 avec `ORIG`**) — non-régression

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

**`tests/public.test.js`** (172 assertions) — interface publique + sécurité

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
  6 visuels, fonctionnalités, étapes, stats, boutiques, CTA), inscription
  obligatoire avant le dashboard, liens réels des boutiques
  (`rxorzera` / `blgbiwds`), aucun lien interne `index.html`, texte sous les
  formulaires supprimé, erreurs SMTP traduites.

**`tests/gateway.test.mjs`** (49 assertions) — passerelle

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
  `SUPABASE_SECRET_KEYS`.

**`tests/admin.test.js`** (72 assertions)

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
- **page Utilisateurs** : nav + titre + table des comptes (`profiles`) avec nom,
  e-mail, inscription, dernière connexion, KPI (comptes, avec nom, déjà
  connectés), aucun secret affiché, actualisation sans erreur ;
- aucun mot de passe codé en dur, aucune `service_role`.

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
  minute (cache) → un changement depuis le back-office prend effet sous ~1 min
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
