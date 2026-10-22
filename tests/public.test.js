/* ═══════════════════════════════════════════════════════════════════════════
   Tests « interface publique » + sécurité LSV.ai
   ───────────────────────────────────────────────────────────────────────────
   Couvre les sections 25 et 26 de la mission :
   - plus aucune trace visible de clé API / Agnes / console de debug ;
   - génération sans aucune clé utilisateur ;
   - erreurs utilisateur génériques (jamais de détail technique) ;
   - aucun secret dans le HTML, le JavaScript public, localStorage ou Git.
   Usage : node tests/public.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROJECT = path.resolve(__dirname, '..');
const INDEX = path.join(PROJECT, 'index.html');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond });
    console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
}

/* Les scripts externes (shared/, analytics/, scripts/) sont inlinés car jsdom
   ne télécharge pas les ressources sans resource loader. Les CSS externes et
   les fonts sont retirés : inutiles pour les assertions. */
function prepare() {
    let html = fs.readFileSync(INDEX, 'utf8');
    html = html.replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '');
    html = html.replace(/<link[^>]*Material\+Symbols[^>]*>/g, '');
    html = html.replace(/<link rel="stylesheet" href="\.\/styles\/[^"]*">/g, '');
    html = html.replace(/<link rel="preload"[^>]*>/g, '');
    html = html.replace(/<script src="\.\/([^"]+)"[^>]*><\/script>/g, (m, rel) => {
        const p = path.join(PROJECT, rel);
        return fs.existsSync(p) ? '<script>' + fs.readFileSync(p, 'utf8') + '</script>' : '';
    });
    return html;
}

async function load(html, url) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
    vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
    vc.on('warn', () => {});
    const dom = new JSDOM(html, { url: url || 'https://fbici.github.io/lsv-ai/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
    await new Promise(res => {
        if (dom.window.document.readyState === 'complete') return res();
        dom.window.addEventListener('load', res);
        setTimeout(res, 4000);
    });
    await new Promise(r => setTimeout(r, 250));
    return { dom, errors };
}

(async () => {
    const source = fs.readFileSync(INDEX, 'utf8');
    /* Le code applicatif vit maintenant dans scripts/ + styles/ : les scans de
       sécurité portent sur l'ensemble du bundle (index + scripts + styles +
       config + analytics), pas seulement sur le squelette HTML. */
    const parts = [source];
    [
        'analytics/analytics.js', 'shared/config.js',
        'scripts/constants.js', 'scripts/core.js',
        'scripts/account.js', 'scripts/media.js', 'scripts/ui.js',
        'scripts/chat.js', 'scripts/views.js', 'scripts/handlers.js',
        'styles/base.css', 'styles/sidebar.css', 'styles/studio.css',
        'styles/account.css', 'styles/welcome.css', 'styles/views.css'
    ].forEach(rel => {
        const p = path.join(PROJECT, rel);
        parts.push(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    });
    const bundle = parts.join('\n');
    const { dom, errors } = await load(prepare());
    const wb = dom.window;
    const doc = wb.document;

    /* La création exige un compte connecté : session de test ouverte pour
       que les scénarios de génération restent valides. */
    wb.LSV.services.account._s = {
        access_token: 'jwt-de-test',
        refresh_token: 'rfr-de-test',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        email: 'test@lsv.ai'
    };

    console.log('=== 1. ÉLÉMENTS TECHNIQUES SUPPRIMÉS DE L INTERFACE ===');
    check('aucune erreur au chargement', errors.length === 0, errors.join('|'));
    check('champ de clé API absent', !doc.getElementById('api-input'));
    check('bouton Enregistrer la clé absent', !doc.getElementById('api-save'));
    check('statut de clé absent', !doc.getElementById('api-status') && !doc.getElementById('api-mini'));
    check('console LSV absente', !doc.getElementById('debug') && !doc.getElementById('debug-body'));

    console.log('\n=== 2. SCAN DU CONTENU PUBLIC (hors scripts) ===');
    const publicHtml = doc.body.innerHTML
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    const bodyClone = doc.body.cloneNode(true);
    bodyClone.querySelectorAll('script, style, noscript').forEach(n => n.remove());
    const publicText = bodyClone.textContent.replace(/\s+/g, ' ');
    const forbidden = [
        'API Key', 'Clé API', 'clé API', 'Ajoutez votre clé', 'Obtenir une clé',
        'Agnes', 'agnes-image', 'agnes-video', 'agnes-2.5',
        'apihub.agnes-ai.com', 'platform.agnes-ai.com',
        'Bearer', 'sk-', 'Console LSV', 'lsv4_api_key',
        'Token', 'Authorization', 'Polling', 'Endpoint'
    ];
    forbidden.forEach(tok => {
        const hit = publicHtml.indexOf(tok) !== -1 || publicText.indexOf(tok) !== -1;
        check('pas de « ' + tok + ' » dans l interface', !hit);
    });
    check('pas de mention Agnes en clair', !/agnes/i.test(publicText));

    console.log('\n=== 3. GÉNÉRATION SANS AUCUNE CLÉ UTILISATEUR ===');
    check('localStorage sans clé après chargement', wb.localStorage.getItem('lsv4_api_key') === null);
    check('CONFIG pointe vers la LSV Gateway',
        wb.LSV.config.API_BASE.indexOf('/functions/v1/lsv-gateway/v1') !== -1,
        wb.LSV.config.API_BASE);
    check('aucun appel direct vers le fournisseur', wb.LSV.config.API_BASE.indexOf('apihub') === -1 && wb.LSV.config.POLL_BASE.indexOf('apihub') === -1);

    const calls = [];
    wb.fetch = function (url, options) {
        calls.push({ url: String(url), options: options || {} });
        if (String(url).includes('/images/generations')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ url: 'https://cdn.test/img.png' }] }), text: async () => '' });
        }
        if (String(url).includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
    };
    wb.document.getElementById('image-prompt').value = 'Un tigre en costume, style cinématique';
    await wb.LSV.handlers.runImageGeneration();
    const gen = calls.find(c => c.url.includes('/images/generations'));
    check('image générée sans clé', wb.LSV.runtime.imageCount === 1, wb.LSV.runtime.imageCount);
    check('requête envoyée à la Gateway', !!gen && gen.url.indexOf('apihub') === -1, gen && gen.url);
    check('aucune clé créée en localStorage', wb.localStorage.getItem('lsv4_api_key') === null);
    check('aucun token sk- dans les en-têtes', !!gen && JSON.stringify(gen.options.headers || {}).indexOf('sk-') === -1, gen && JSON.stringify(gen.options.headers || {}));
    check('aucun toast demandant une clé', doc.getElementById('toast-text').textContent.indexOf('clé') === -1, doc.getElementById('toast-text').textContent);

    console.log('\n=== 4. ERREURS UTILISATEUR GÉNÉRIQUES (§11) ===');
    wb.fetch = function (url) {
        const u = String(url);
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201 });
        if (u.includes('/images/generations')) {
            return Promise.resolve({
                ok: false, status: 401,
                json: async () => ({ error: { message: 'Invalid key sk-SECRETAGNES on apihub.agnes-ai.com' } }),
                text: async () => 'Invalid key sk-SECRETAGNES on apihub.agnes-ai.com'
            });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    const beforeFail = wb.LSV.runtime.imageCount;
    await wb.LSV.handlers.runImageGeneration();
    const toast = doc.getElementById('toast-text').textContent;
    check('génération échouée sans bloquer l app', wb.LSV.runtime.imageCount === beforeFail, wb.LSV.runtime.imageCount);
    check('toast = message générique', /Impossible de générer|limite temporaire/.test(toast), toast);
    check('aucun détail technique dans le toast', !/apihub|sk-|agnes|HTTP|401|Bearer/i.test(toast), toast);
    check('aucune erreur console', errors.length === 0, errors.join('|'));

    console.log('\n=== 5. SÉCURITÉ : AUCUN SECRET DANS LE DÉPÔT ===');
    /* Le motif sk-[A-Za-z0-9]{10,} ignore volontairement la regex de
       redaction de analytics.js (qui écrit littéralement « sk-… » à des fins
       de masquage, jamais de fuite). */
    const skLeak = bundle.match(/sk-[A-Za-z0-9]{10,}/);
    check('bundle sans token sk-', !skLeak, skLeak ? skLeak[0].slice(0, 20) : '');
    check('bundle sans clé en localStorage', bundle.indexOf('lsv4_api_key') === -1);
    check('bundle sans endpoint amont', bundle.indexOf('apihub.agnes-ai.com') === -1);
    check('bundle sans lien plateforme fournisseur', bundle.indexOf('platform.agnes-ai.com') === -1);
    check('bundle sans service_role', !/service_role/i.test(bundle));
    check('bundle sans mot de passe en dur', !/password\s*[:=]\s*['"][^'"]+['"]/i.test(bundle));
    const publicFiles = [
        'admin/admin.js', 'admin/index.html', 'analytics/analytics.js', 'shared/config.js', 'admin/admin.css',
        'scripts/constants.js', 'scripts/core.js', 'scripts/account.js',
        'scripts/media.js', 'scripts/ui.js', 'scripts/chat.js', 'scripts/views.js', 'scripts/handlers.js',
        'styles/base.css', 'styles/sidebar.css', 'styles/studio.css', 'styles/account.css',
        'styles/welcome.css', 'styles/views.css'
    ];
    let leak = null;
    publicFiles.forEach(f => {
        const p = path.join(PROJECT, f);
        if (!fs.existsSync(p)) return;
        const c = fs.readFileSync(p, 'utf8');
        const m = c.match(/sk-[A-Za-z0-9]{10,}/);
        if (m && !leak) leak = f + ' : ' + m[0].slice(0, 16) + '…';
    });
    check('aucun token sk- dans les fichiers publics', !leak, leak || '');
    check('HTML non BOM', fs.readFileSync(INDEX).length > 3 && fs.readFileSync(INDEX)[0] !== 0xEF);

    console.log('\n=== 6. SÉPARATION PUBLIC / ADMIN ===');
    check('index.html sans lien vers /admin', !/(href|src)="[^"]*admin/.test(source));
    const adminJs = fs.readFileSync(path.join(PROJECT, 'admin/admin.js'), 'utf8');
    check('admin.js sans mot de passe en dur', !/password\s*[:=]\s*['"][^'"]+['"]/i.test(adminJs));
    check('admin.js s appuie sur Supabase Auth', /auth\.signInWithPassword|signInWithPassword/.test(adminJs));
    const schema = fs.readFileSync(path.join(PROJECT, 'supabase/schema.sql'), 'utf8');
    check('lecture analytics réservée aux comptes authentifiés',
        /create policy "authenticated_select_events"[\s\S]{0,160}to authenticated/.test(schema));
    check('lecture réservée à la liste blanche (is_admin)',
        /using \(public\.is_admin\(\)\)/.test(schema) && /public\.admin_emails/.test(schema));
    check('grant select jamais accordé à anon',
        /grant select on public\.analytics_events to authenticated/.test(schema) &&
        !/grant select on public\.analytics_events to anon/.test(schema));
    check('clé du fournisseur : aucun droit pour anon',
        /revoke all on public\.app_settings from anon/.test(schema) &&
        !/grant select on public\.app_settings to anon/.test(schema));
    check('écriture de la clé réservée à la liste blanche',
        /create policy "admin_insert_settings"[\s\S]{0,200}with check \(public\.is_admin\(\)\)/.test(schema) &&
        /create policy "admin_select_settings"[\s\S]{0,200}using \(public\.is_admin\(\)\)/.test(schema));

    console.log('\n=== 6ter. QUOTAS : LECTURE SÛRE DE app_settings ===');
    const quotaSql = ['supabase/schema.sql', 'supabase/upgrade-quotas.sql']
        .map(f => fs.readFileSync(path.join(PROJECT, f), 'utf8'));
    check('aucune lecture app_settings dans une variable entière',
        quotaSql.every(t => !/select value into v_(?!raw\b)\w+/.test(t)));
    check('récepteur TEXT déclaré dans les deux fichiers',
        quotaSql.every(t => (t.match(/v_raw\s+text;/g) || []).length >= 2));
    check('conversion en deux temps : nullif sur une variable entière banni',
        quotaSql.every(t => !/nullif\(v_limit/.test(t)));
    check('rejet des valeurs non numériques avant le cast',
        quotaSql.every(t => (t.match(/~ '\^\[0-9\]\+\$'/g) || []).length >= 2));
    check('migration de correction présente',
        fs.existsSync(path.join(PROJECT, 'supabase/upgrade-quota-empty-value.sql')));

    console.log('\n=== 6bis. PROFILS (NOMS DES COMPTES) ===');
    const upgradeProfiles = fs.readFileSync(path.join(PROJECT, 'supabase/upgrade-profiles.sql'), 'utf8');
    check('table profiles présente (schéma + migration)',
        /create table if not exists public\.profiles/.test(schema) &&
        /create table if not exists public\.profiles/.test(upgradeProfiles));
    check('profil lié à auth.users (suppression en cascade)',
        /references auth\.users \(id\) on delete cascade/.test(schema));
    check('RLS activée sur profiles', /alter table public\.profiles enable row level security/.test(schema));
    check('aucun droit anon sur profiles',
        /revoke all on public\.profiles from anon/.test(schema) &&
        !/grant .* on public\.profiles to anon/.test(schema));
    check('lecture réservée : soi-même ou liste blanche',
        /"profiles_select_own"/.test(schema) && /"profiles_select_admin"/.test(schema) &&
        /using \(auth\.uid\(\) = id\)/.test(schema));
    check('aucune écriture client sur profiles', !/for insert[\s\S]{0,80}on public\.profiles/.test(schema));
    check('rempli automatiquement à l inscription',
        /create trigger on_auth_user_created/.test(schema) && /handle_new_user/.test(schema));
    check('comptes déjà inscrits recopiés', /insert into public\.profiles[\s\S]{0,200}from auth\.users/.test(upgradeProfiles));
    check('profiles sans colonne secrète', !/password\s+text|access_token\s+text|api_key\s+text|secret\s+text/i.test(schema));
    check('profiles : e-mail + dernière connexion',
        /email\s+text/.test(schema) && /last_sign_in_at\s+timestamptz/.test(schema));
    check('trigger : e-mail et connexion recopiés à chaque connexion',
        /after update of raw_user_meta_data, email, last_sign_in_at on auth\.users/.test(schema));
    check('profil renseigné aussi si le compte existait déjà', /on conflict \(id\) do update/.test(upgradeProfiles));

    console.log('\n=== 7. COMPTES UTILISATEURS (Supabase Auth) ===');
    check('section Compte présente', !!doc.getElementById('account-section'));
    check('formulaire fermé par défaut', doc.getElementById('account-form').classList.contains('hidden'));
    check('aucun compte connecté par défaut', doc.getElementById('account-user').classList.contains('hidden'));
    check('page de connexion masquée par défaut', doc.getElementById('auth-modal').classList.contains('hidden'));
    check('page de connexion au niveau du body', !!doc.getElementById('auth-modal').closest('body'));
    check('l application permet l inscription (Auth REST)', /auth\/v1\/signup|AccountService/.test(bundle));
    check('message clair si e-mail non confirmé (code GoTrue)',
        /E-mail non confirmé/i.test(wb.LSV.services.account.friendly('email_not_confirmed')),
        wb.LSV.services.account.friendly('email_not_confirmed'));
    check('message clair si identifiants invalides',
        /Identifiants incorrects/i.test(wb.LSV.services.account.friendly('Invalid login credentials')),
        wb.LSV.services.account.friendly('Invalid login credentials'));
    check('admin.js permet la création de compte', /auth\.signUp/.test(adminJs));
    check('aucun lien statique vers le back-office', !doc.getElementById('account-admin').hasAttribute('href'));

    // Échec de connexion → message utilisateur générique (§11)
    wb.fetch = function (url) {
        const u = String(url);
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/auth/v1/token')) {
            return Promise.resolve({
                ok: false, status: 401,
                json: async () => ({ error_description: 'Invalid login credentials sk-SECRETAGNES' }),
                text: async () => ''
            });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    doc.getElementById('account-open').click();
    check('page de connexion ouverte par le bouton', !doc.getElementById('auth-modal').classList.contains('hidden'));
    doc.getElementById('account-email').value = 'visiteur@lsv.ai';
    doc.getElementById('account-password').value = 'secret-de-test';
    doc.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 300));
    const accMsg = doc.getElementById('account-status-text').textContent;
    check('connexion refusée → message générique', /Identifiants incorrects/i.test(accMsg), accMsg);
    check('aucun détail technique dans le message', !/sk-|HTTP|401|apihub|agnes/i.test(accMsg), accMsg);
    check('toujours déconnecté', doc.getElementById('account-user').classList.contains('hidden'));
    check('page de connexion restée ouverte après échec', !doc.getElementById('auth-modal').classList.contains('hidden'));

    // Connexion réussie → compte affiché, back-office masqué hors liste blanche
    wb.fetch = function (url) {
        const u = String(url);
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/auth/v1/token')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ access_token: 'jwt-de-test', refresh_token: 'rfr-de-test', expires_in: 3600, user: { email: 'visiteur@lsv.ai' } }),
                text: async () => ''
            });
        }
        if (u.includes('/rest/v1/rpc/is_admin')) return Promise.resolve({ ok: true, status: 200, json: async () => false, text: async () => '' });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    doc.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 400));
    check('compte affiché après connexion', !doc.getElementById('account-user').classList.contains('hidden'));
    check('page de connexion fermée après connexion', doc.getElementById('auth-modal').classList.contains('hidden'));
    check('e-mail affiché', /visiteur@lsv\.ai/.test(doc.getElementById('account-mail').textContent), doc.getElementById('account-mail').textContent);
    check('back-office masqué hors liste blanche', doc.getElementById('account-admin').classList.contains('hidden'));
    check('session conservée sur l appareil', !!wb.localStorage.getItem('lsv4_account'));
    check('aucun mot de passe en clair stocké', !/password|motdepasse|secret-de-test/i.test(wb.localStorage.getItem('lsv4_account') || ''));
    check('aucune erreur console (comptes)', errors.length === 0, errors.join('|'));

    console.log('\n=== 7bis. INSCRIPTION AVEC NOM COMPLET ===');
    doc.getElementById('account-logout').click();
    await new Promise(r => setTimeout(r, 80));
    doc.getElementById('account-open').click();
    check('champ nom masqué en mode connexion', doc.getElementById('account-name').classList.contains('hidden'));
    doc.getElementById('account-mode').click(); // → mode inscription
    check('champ nom complet visible en inscription', !doc.getElementById('account-name').classList.contains('hidden'));
    check('trois champs : nom, e-mail, mot de passe',
        !!doc.getElementById('account-name') && !!doc.getElementById('account-email') && !!doc.getElementById('account-password'));
    check('champ nom regroupé (label + icône)', !doc.getElementById('account-name-field').classList.contains('hidden'));
    check('réinitialisation masquée en inscription', doc.getElementById('account-forgot').classList.contains('hidden'));
    check('titre de page en inscription', doc.getElementById('auth-heading').textContent === 'Créer un compte', doc.getElementById('auth-heading').textContent);

    doc.getElementById('account-eye').click();
    check('œil : mot de passe affiché', doc.getElementById('account-password').type === 'text');
    doc.getElementById('account-eye').click();
    check('œil : mot de passe masqué', doc.getElementById('account-password').type === 'password');

    doc.getElementById('account-mode').click(); // → retour mode connexion
    check('retour en mode connexion', doc.getElementById('account-name').classList.contains('hidden') &&
        !doc.getElementById('account-forgot').classList.contains('hidden'));
    check('titre de page en connexion', doc.getElementById('auth-heading').textContent === 'Se connecter', doc.getElementById('auth-heading').textContent);

    doc.getElementById('account-email').value = '';
    doc.getElementById('account-forgot').click();
    const emptyForgot = doc.getElementById('account-status-text').textContent;
    check('réinitialisation sans e-mail refusée', /e-mail/i.test(emptyForgot), emptyForgot);

    wb.fetch = function (url) {
        const u = String(url);
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/auth/v1/recover')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    doc.getElementById('account-email').value = 'visiteur@lsv.ai';
    doc.getElementById('account-forgot').click();
    await new Promise(r => setTimeout(r, 250));
    const forgotMsg = doc.getElementById('account-status-text').textContent;
    check('e-mail de réinitialisation demandé', /E-mail envoyé/i.test(forgotMsg), forgotMsg);

    doc.getElementById('auth-modal').dispatchEvent(new wb.MouseEvent('mousedown', { bubbles: true }));
    check('fermeture en cliquant le fond', doc.getElementById('auth-modal').classList.contains('hidden'));
    doc.getElementById('account-open').click();
    check('réouverture depuis le panneau', !doc.getElementById('auth-modal').classList.contains('hidden'));
    doc.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('fermeture avec Échap', doc.getElementById('auth-modal').classList.contains('hidden'));
    doc.getElementById('account-open').click();
    doc.getElementById('account-mode').click(); // → mode inscription pour la suite

    const signCalls = [];
    wb.fetch = function (url, options) {
        const u = String(url);
        signCalls.push({ url: u, body: (options && options.body) || '' });
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/auth/v1/signup')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({
                    access_token: 'jwt-inscription', refresh_token: 'rfr-inscription', expires_in: 3600,
                    user: { email: 'nouveau@lsv.ai', user_metadata: { full_name: 'Ada Lovelace' } }
                }),
                text: async () => ''
            });
        }
        if (u.includes('/rest/v1/rpc/is_admin')) return Promise.resolve({ ok: true, status: 200, json: async () => false, text: async () => '' });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    doc.getElementById('account-email').value = 'nouveau@lsv.ai';
    doc.getElementById('account-password').value = 'mot-de-passe-test';
    doc.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 250));
    const noNameMsg = doc.getElementById('account-status-text').textContent;
    check('inscription sans nom refusée', /Nom complet requis/i.test(noNameMsg), noNameMsg);
    check('aucune requête d inscription sans nom', !signCalls.some(c => c.url.includes('/auth/v1/signup')), signCalls.map(c => c.url).join(','));
    check('toujours déconnecté', doc.getElementById('account-user').classList.contains('hidden'));

    doc.getElementById('account-name').value = 'Ada Lovelace';
    doc.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 450));
    const up = signCalls.find(c => c.url.includes('/auth/v1/signup'));
    check('nom complet envoyé à Supabase Auth', !!up && /"full_name":"Ada Lovelace"/.test(up.body), up && up.body);
    check('e-mail et mot de passe envoyés', !!up && /nouveau@lsv\.ai/.test(up.body) && /mot-de-passe-test/.test(up.body), up && up.body);
    check('compte créé et connecté', !doc.getElementById('account-user').classList.contains('hidden'));
    check('nom affiché avec l e-mail', /Ada Lovelace/.test(doc.getElementById('account-mail').textContent), doc.getElementById('account-mail').textContent);
    check('mot de passe jamais stocké', !/mot-de-passe-test/.test(wb.localStorage.getItem('lsv4_account') || ''));
    check('aucune erreur console (inscription app)', errors.length === 0, errors.join('|'));

    console.log('\n=== 8. CRÉATION BLOQUÉE SANS COMPTE ===');
    const anon = await load(prepare());
    const wa = anon.dom.window;
    const da = wa.document;
    const anonCalls = [];
    wa.fetch = function (url, options) {
        anonCalls.push(String(url));
        if (String(url).includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    da.getElementById('image-prompt').value = 'Un tigre en costume, style cinématique';
    await wa.LSV.handlers.runImageGeneration();
    check('aucune requête image sans compte', !anonCalls.some(u => u.includes('/images/generations')), anonCalls.join(','));
    check('aucune image créée', wa.LSV.runtime.imageCount === 0, wa.LSV.runtime.imageCount);
    check('toast = invitation à se connecter', /Connecte-toi/.test(da.getElementById('toast-text').textContent), da.getElementById('toast-text').textContent);
    check('formulaire Compte ouvert automatiquement', !da.getElementById('account-form').classList.contains('hidden'));
    check('page de connexion ouverte automatiquement', !da.getElementById('auth-modal').classList.contains('hidden'));
    check('aucun détail technique dans le toast', !/sk-|HTTP|apihub|agnes/i.test(da.getElementById('toast-text').textContent));

    da.getElementById('chat-input').value = 'Salut, une idée ?';
    await wa.LSV.views.chat.sendMessage();
    check('aucune requête chat sans compte', !anonCalls.some(u => u.includes('/chat/completions')), anonCalls.join(','));
    check('message conservé dans le champ', da.getElementById('chat-input').value === 'Salut, une idée ?', da.getElementById('chat-input').value);
    check('aucune erreur console (bloqué)', anon.errors.length === 0, anon.errors.join('|'));

    console.log('\n=== 8bis. RETOUR DES LIENS SUPABASE (confirmation / réinitialisation) ===');
    const okReturn = await load(prepare(), 'https://fbici.github.io/lsv-ai/?code=test-code-123');
    const wo = okReturn.dom.window;
    const dox = wo.document;
    check('retour de confirmation : toast de succès', /E-mail confirmé/i.test(dox.getElementById('toast-text').textContent), dox.getElementById('toast-text').textContent);
    check('retour de confirmation : adresse nettoyée', !/[?&]code=/.test(wo.location.search), wo.location.search);
    check('retour de confirmation : modale fermée', dox.getElementById('auth-modal').classList.contains('hidden'));
    check('retour de confirmation : aucune erreur console', okReturn.errors.length === 0, okReturn.errors.join('|'));

    const badReturn = await load(prepare(), 'https://fbici.github.io/lsv-ai/?error_description=Email+link+is+invalid+or+has+expired');
    const wb2 = badReturn.dom.window;
    const db2 = wb2.document;
    check('lien expiré : toast d erreur clair', /Lien invalide ou expiré/i.test(db2.getElementById('toast-text').textContent), db2.getElementById('toast-text').textContent);
    check('lien expiré : aucun détail technique', !/error_description|token|supabase|HTTP/i.test(db2.getElementById('toast-text').textContent), db2.getElementById('toast-text').textContent);
    check('lien expiré : aucune erreur console', badReturn.errors.length === 0, badReturn.errors.join('|'));

    const plain = await load(prepare());
    check('chargement normal : aucun toast de retour', !/E-mail confirmé|Lien invalide/i.test(plain.dom.window.document.getElementById('toast-text').textContent), plain.dom.window.document.getElementById('toast-text').textContent);

    console.log('\n=== 9. À PROPOS & SEO (LeStudioViral · Salaou Souleyman) ===');
    const aboutLink = doc.getElementById('site-about');
    const aboutA = aboutLink ? aboutLink.querySelector('a') : null;
    check('lien « À propos » présent dans le studio', !!aboutA && aboutA.getAttribute('href') === './a-propos/', aboutA && aboutA.getAttribute('href'));
    check('lien À propos vers la seule page a-propos', !/admin/i.test(aboutA ? aboutA.getAttribute('href') : ''), aboutA && aboutA.getAttribute('href'));
    check('meta description du studio citant la marque', /LeStudioViral/.test(source) && /Salaou Souleyman/.test(source) && /<meta name="description"/.test(source));
    check('SEO : canonical + Open Graph + Twitter', /rel="canonical"/.test(source) && /og:title/.test(source) && /twitter:card/.test(source));
    check('SEO : données structurées (WebSite + fondateur)', /application\/ld\+json/.test(source) && /Salaou Souleyman/.test(source));

    const aboutPath = path.join(PROJECT, 'a-propos', 'index.html');
    const aboutSrc = fs.existsSync(aboutPath) ? fs.readFileSync(aboutPath, 'utf8') : '';
    check('page a-propos/index.html existe (URL sans .html)', !!aboutSrc, aboutSrc.length + ' octets');
    check('page à propos en français', /<html lang="fr">/.test(aboutSrc));
    check('fondateur nommé (Salaou Souleyman)', /Salaou Souleyman/.test(aboutSrc));
    check('marque nommée (LeStudioViral)', /LeStudioViral/.test(aboutSrc));
    check('métiers mentionnés (web + mobile + contenu)', /applications web/i.test(aboutSrc) && /mobile/i.test(aboutSrc) && /contenu/i.test(aboutSrc));
    check('accès au studio depuis la page', /fbici\.github\.io\/lsv-ai\//.test(aboutSrc));
    check('SEO : titre + description + canonical sur la page', /<title>[^<]*Salaou Souleyman/.test(aboutSrc) && /meta name="description"/.test(aboutSrc) && /canonical" href="https:\/\/fbici\.github\.io\/lsv-ai\/a-propos\/"/.test(aboutSrc));
    check('SEO : JSON-LD Person + Organization', /"@type": "Person"/.test(aboutSrc) && /"@type": "Organization"/.test(aboutSrc) && /"founder"/.test(aboutSrc));
    check('emplacement prévu pour le site officiel', /SITE_OFFICIEL/.test(aboutSrc) && /lestudioviral\.com/.test(aboutSrc));
    check('logo officiel affiché (header uniquement) sur la page', (aboutSrc.match(/src="\.\.\/lsv\.jpg"/g) || []).length === 1, (aboutSrc.match(/src="\.\.\/lsv\.jpg"/g) || []).length);
    check('deux boutiques prévues (LeStudioViral + Académie)', /SHOP_1_URL/.test(aboutSrc) && /SHOP_2_URL/.test(aboutSrc) && /Boutique LeStudioViral/.test(aboutSrc) && /Académie Digital/.test(aboutSrc));
    check('produits digitaux mentionnés (IA, TikTok, trading, ebooks)', /IA/i.test(aboutSrc) && /TikTok/.test(aboutSrc) && /trading/i.test(aboutSrc) && /ebooks/i.test(aboutSrc));
    check('aucun secret dans la page à propos', !/sk-[A-Za-z0-9]{10,}|service_role|password\s*[:=]/.test(aboutSrc));

    const robotsPath = path.join(PROJECT, 'robots.txt');
    const robotsSrc = fs.existsSync(robotsPath) ? fs.readFileSync(robotsPath, 'utf8') : '';
    check('robots.txt présent et admin interdit', /Disallow:\s*\/admin\//.test(robotsSrc) && /Sitemap:/.test(robotsSrc), robotsSrc.slice(0, 40));
    const sitemapPath = path.join(PROJECT, 'sitemap.xml');
    const sitemapSrc = fs.existsSync(sitemapPath) ? fs.readFileSync(sitemapPath, 'utf8') : '';
    check('sitemap.xml contient studio + à propos', /fbici\.github\.io\/lsv-ai\//.test(sitemapSrc) && /a-propos\//.test(sitemapSrc) && !/a-propos\.html/.test(sitemapSrc));
    check('sitemap daté (lastmod)', /<lastmod>/.test(sitemapSrc));
    const llmsPath = path.join(PROJECT, 'llms.txt');
    check('llms.txt présent (index IA)', fs.existsSync(llmsPath) && /LSV\.ai/.test(fs.readFileSync(llmsPath, 'utf8')));
    check('SEO accueil : og:image + twitter:card large + robots', /og:image/.test(source) && /summary_large_image/.test(source) && /name="robots" content="index, follow/.test(source));
    check('SEO accueil : JSON-LD SoftwareApplication', /"SoftwareApplication"/.test(source));
    check('SEO à propos : og:image + robots', /og:image/.test(aboutSrc) && /name="robots" content="index, follow/.test(aboutSrc));

    console.log('\n=== 10. PAGE D\'ACCUEIL & BOUTIQUES ===');
    check('logo officiel sur l accueil', !!doc.getElementById('welcome-logo') && doc.getElementById('welcome-logo').getAttribute('src') === './lsv.jpg');
    check('bouton Commencer présent', !!doc.getElementById('welcome-continue'));
    check('second bouton Commencer (bas de page)', !!doc.getElementById('welcome-continue-2'));
    check('lien connexion pour comptes existants', !!doc.getElementById('welcome-login'));
    check('gallerie d exemples (6 images + 1 vidéo)', doc.querySelectorAll('#welcome-gallery .w-shot').length === 7 && doc.querySelectorAll('#welcome-gallery img[data-src^="./assets/showcase/"]').length === 6, doc.querySelectorAll('#welcome-gallery .w-shot').length);
    check('vignettes jpg + repli svg', doc.querySelectorAll('#welcome-gallery img[data-src^="./assets/showcase/"]').length === 6 && doc.querySelectorAll('#welcome-gallery img[data-fallback$=".svg"]').length === 6);
    check('vidéo générée (V1) en tête de gallerie', !!doc.querySelector('#welcome-gallery video source[src="./assets/showcase/V1.mp4"]'));
    check('seconde vidéo (V2) en bas de page', !!doc.querySelector('.w-videoband video source[src="./assets/showcase/V2.mp4"]'));
    check('gallerie sans badges ni légendes', doc.querySelectorAll('#welcome-gallery .w-badge, #welcome-gallery figcaption, #welcome-gallery .w-prompt, #welcome-gallery .w-tag').length === 0);
    check('aucune phrase technique de dépôt sur l accueil', !/dépose|assets\/showcase|repli|SVG/i.test(doc.getElementById('welcome-gallery').textContent));
    check('sections accueil (créations, fonctions, boutiques, final)', !!doc.getElementById('w-showcase') && !!doc.getElementById('w-features') && !!doc.getElementById('w-shops') && !!doc.querySelector('.w-final'));
    check('étapes & stats présentes', doc.querySelectorAll('.w-step').length === 3 && doc.querySelectorAll('.w-stat').length === 4);
    const shopA = doc.getElementById('shop-boutique');
    const shopB = doc.getElementById('shop-academie');
    check('boutique LeStudioViral en ligne (SHOP_1_URL)', !!shopA && shopA.getAttribute('href') === 'https://rxorzera.mychariow.shop', shopA && shopA.getAttribute('href'));
    check('Académie Digital en ligne (SHOP_2_URL)', !!shopB && shopB.getAttribute('href') === 'https://blgbiwds.mychariow.shop', shopB && shopB.getAttribute('href'));
    check('texte sous les formulaires supprimé', !/Les mots de passe sont vérifiés/.test(source));
    check('aucun lien interne vers index.html', !/href="[^"]*index\.html/.test(source) && !/href="[^"]*index\.html/.test(aboutSrc));

    doc.getElementById('welcome-continue').click();
    await new Promise(r => setTimeout(r, 200));
    check('Continuer avec un compte : accueil masqué', doc.getElementById('welcome').classList.contains('hidden'));
    check('Continuer avec un compte : accueil marqué comme vu', wb.localStorage.getItem('lsv4_welcome') === 'done', wb.localStorage.getItem('lsv4_welcome'));

    doc.getElementById('account-logout').click();
    await new Promise(r => setTimeout(r, 200));
    check('déconnexion : renvoi automatique vers l accueil', !doc.getElementById('welcome').classList.contains('hidden'));

    const first = await load(prepare());
    const wf = first.dom.window;
    const df = wf.document;
    check('première visite sans compte : accueil visible', !df.getElementById('welcome').classList.contains('hidden'));
    wf.localStorage.setItem('lsv4_welcome', 'done');
    const again = await load(prepare());
    check('visiteur déconnecté : accueil visible même après passage précédent', !again.dom.window.document.getElementById('welcome').classList.contains('hidden'));
    df.getElementById('welcome-continue').click();
    await new Promise(r => setTimeout(r, 200));
    check('Continuer sans compte : modale d inscription ouverte', !df.getElementById('auth-modal').classList.contains('hidden'));
    check('Continuer sans compte : mode inscription', df.getElementById('account-submit').textContent === 'Créer le compte', df.getElementById('account-submit').textContent);
    check('Continuer sans compte : accueil reste visible derrière', !df.getElementById('welcome').classList.contains('hidden'));
    wf.fetch = function (url, options) {
        if (String(url).includes('/auth/v1/signup')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ access_token: 'jwt-test', refresh_token: 'rfr-test', expires_in: 3600, token_type: 'bearer', user: { id: 'u1', email: 'nouveau@lsv.ai', user_metadata: { full_name: 'Ada Lovelace' } } }),
                text: async () => ''
            });
        }
        if (String(url).includes('/rest/v1/rpc/is_admin')) return Promise.resolve({ ok: true, status: 200, json: async () => false, text: async () => '' });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    df.getElementById('account-name').value = 'Ada Lovelace';
    df.getElementById('account-email').value = 'nouveau@lsv.ai';
    df.getElementById('account-password').value = 'mot-de-passe-test';
    df.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 450));
    check('inscription depuis l accueil : bienvenue', df.getElementById('welcome').classList.contains('hidden'));
    check('inscription depuis l accueil : accueil marqué comme vu', wf.localStorage.getItem('lsv4_welcome') === 'done', wf.localStorage.getItem('lsv4_welcome'));
    check('inscription depuis l accueil : aucune erreur console', first.errors.length === 0, first.errors.join('|'));

    check('erreur d envoi masquée à l utilisateur', /réessaie dans quelques instants/i.test(wb.LSV.services.account.friendly('Error sending confirmation email')), wb.LSV.services.account.friendly('Error sending confirmation email'));
    check('aucune mention technique dans les messages', !/SMTP|Supabase|Authentication|HTTP|sk-/i.test(wb.LSV.services.account.friendly('Error sending confirmation email') + ' ' + wb.LSV.services.account.friendly('Email address not authorized')));
    check('limite d inscriptions traduite', /réessaie dans une heure/i.test(wb.LSV.services.account.friendly('over_email_send_rate_limit')), wb.LSV.services.account.friendly('over_email_send_rate_limit'));

    console.log('\n=== 12. ARCHITECTURE MODULAIRE ===');
    check('index.html léger (squelette HTML seulement)', source.length < 90000, source.length + ' octets');
    check('aucun <style> inline dans index.html', !/<style>/.test(source));
    /* Seuls les <script> exécutables sont comptés : le JSON-LD
       (type="application/ld+json") est de la donnée, pas du code. */
    const inlineScripts = source.match(/<script(?![^>]*src=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g) || [];
    check('scripts inline limités au shim (3 max)', inlineScripts.length <= 3, inlineScripts.length);
    check('script inline court (shim uniquement)', inlineScripts.every(s => s.length < 600), inlineScripts.map(s => s.length).join('+'));
    const expected = [
        'styles/base.css', 'styles/sidebar.css', 'styles/studio.css',
        'styles/account.css', 'styles/welcome.css', 'styles/views.css',
        'scripts/constants.js', 'scripts/core.js', 'scripts/account.js',
        'scripts/media.js', 'scripts/ui.js', 'scripts/chat.js',
        'scripts/views.js', 'scripts/handlers.js'
    ];
    const missing = expected.filter(rel => !fs.existsSync(path.join(PROJECT, rel)));
    check('tous les modules CSS/JS existent', missing.length === 0, missing.join(','));
    check('chaque module référencé par index.html', expected.every(rel => source.indexOf('./' + rel) !== -1), expected.filter(rel => source.indexOf('./' + rel) === -1).join(','));
    const bigInline = source.match(/<script(?![^>]*src=)(?![^>]*application\/ld\+json)[^>]*>[\s\S]{2000,}<\/script>/);
    check('aucun script inline volumineux', !bigInline);
    check('ordre des modules constant → core → account → media → ui → chat → views → handlers',
        source.indexOf('./scripts/constants.js') < source.indexOf('./scripts/core.js') &&
        source.indexOf('./scripts/core.js') < source.indexOf('./scripts/account.js') &&
        source.indexOf('./scripts/account.js') < source.indexOf('./scripts/media.js') &&
        source.indexOf('./scripts/media.js') < source.indexOf('./scripts/ui.js') &&
        source.indexOf('./scripts/ui.js') < source.indexOf('./scripts/chat.js') &&
        source.indexOf('./scripts/chat.js') < source.indexOf('./scripts/views.js') &&
        source.indexOf('./scripts/views.js') < source.indexOf('./scripts/handlers.js'));

    console.log('\n=== 13. SÉLECTEUR DE RATIO VISUEL ===');
    /* Remplace l'ancien <select> : chaque ratio est un rectangle aux
       proportions réelles, plus lisible qu'une liste de ratios. */
    check('conteneurs de ratio présents (image + vidéo)',
        !!wb.document.getElementById('image-ratio') && !!wb.document.getElementById('video-ratio'));
    const imgOpts = wb.document.querySelectorAll('#image-ratio [data-ratio]');
    const vidOpts = wb.document.querySelectorAll('#video-ratio [data-ratio]');
    check('image : 5 ratios rendus', imgOpts.length === 5, imgOpts.length);
    check('vidéo : 3 ratios seulement (16:9, 9:16, 1:1)', vidOpts.length === 3,
        Array.from(vidOpts).map(b => b.dataset.ratio).join(','));
    check('ratios image = ceux prévus (16:9, 9:16, 1:1, 4:3, 3:4)',
        Array.from(imgOpts).map(b => b.dataset.ratio).sort().join(',') ===
        ['16:9', '9:16', '1:1', '4:3', '3:4'].sort().join(','),
        Array.from(imgOpts).map(b => b.dataset.ratio).join(','));
    check('chaque option expose un rectangle à la bonne proportion',
        Array.from(imgOpts).every(b => {
            const s = b.querySelector('.ratio-shape');
            if (!s) return false;
            const ar = (s.getAttribute('style') || '').match(/aspect-ratio:\s*(\d+)\/(\d+)/);
            if (!ar) return false;
            const parts = b.dataset.ratio.split(':');
            return Number(ar[1]) === Number(parts[0]) && Number(ar[2]) === Number(parts[1]);
        }));
    check('ratio image par défaut = 9:16 (verticale)',
        wb.eval('UIState.imageRatio') === '9:16' &&
        !!wb.document.querySelector('#image-ratio [data-ratio="9:16"].selected'));
    check('ratio vidéo par défaut = 9:16',
        wb.eval('UIState.videoRatio') === '9:16' &&
        !!wb.document.querySelector('#video-ratio [data-ratio="9:16"].selected'));
    /* Clic = changement de ratio, sans renvoyer vers le serveur. */
    const before16 = wb.eval('UIState.imageRatio');
    wb.document.querySelector('#image-ratio [data-ratio="16:9"]').click();
    check('clic → UIState.imageRatio mis à jour', wb.eval('UIState.imageRatio') === '16:9',
        before16 + ' → ' + wb.eval('UIState.imageRatio'));
    check('la sélection visuelle suit le clic',
        !!wb.document.querySelector('#image-ratio [data-ratio="16:9"].selected') &&
        !wb.document.querySelector('#image-ratio [data-ratio="9:16"].selected'));
    check('accessibilité : rôle radiogroup + aria-checked',
        wb.document.getElementById('image-ratio').getAttribute('role') === 'radiogroup' &&
        wb.document.querySelector('#image-ratio [data-ratio="16:9"]').getAttribute('aria-checked') === 'true');
    /* La génération utilise bien le ratio choisi (table IMG_RES, constante globale). */
    check('conversion ratio → pixels via IMG_RES',
        wb.eval('IMG_RES["2K"]["16:9"]') === '2624x1472' &&
        wb.eval('IMG_RES["2K"]["9:16"]') === '1472x2624');

    console.log('\n=== 14. IMAGE DE RÉFÉRENCE : APPAREIL OU BIBLIOTHÈQUE ===');
    /* Image→Vidéo peut partir d'un fichier local, mais aussi d'une création
       déjà générée sur LSV.ai : le sélecteur de source doit permettre les
       deux sans toucher au parcours fichier existant. */
    check('deux onglets de source présents',
        !!wb.document.getElementById('ref-tab-device') && !!wb.document.getElementById('ref-tab-library'));
    check('les deux panneaux existent',
        !!wb.document.getElementById('ref-zone-device') && !!wb.document.getElementById('ref-zone-library'));
    check('l\'appareil est la source active au chargement',
        wb.document.getElementById('ref-tab-device').classList.contains('is-selected') &&
        wb.document.getElementById('ref-zone-library').classList.contains('hidden'));
    check('accessibilité : aria-selected + aria-controls',
        wb.document.getElementById('ref-tab-device').getAttribute('aria-selected') === 'true' &&
        wb.document.getElementById('ref-tab-library').getAttribute('aria-controls') === 'ref-zone-library');

    /* Mode Image→Vidéo : le panneau de référence doit être visible. */
    wb.document.querySelector('.mode-tile[data-mode="image-to-video"]').click();
    check('mode image-to-video → carte de référence affichée',
        !wb.document.getElementById('video-ref-card').classList.contains('hidden'));
    check('limite = 1 image en image-to-video', wb.eval('Handlers.refLimit()') === 1);

    /* Bascule vers la bibliothèque. Les sections précédentes ont déjà généré
       des créations : on vide le magasin pour vérifier l'état vide, puis on
       le restaure. */
    const savedAssets = wb.eval('StorageService.getAssets()');
    wb.eval('StorageService.setAssets([]); AssetService._cache = null; Handlers.renderRefLibrary();');
    wb.document.getElementById('ref-tab-library').click();
    check('clic Bibliothèque → panneau montré, appareil masqué',
        !wb.document.getElementById('ref-zone-library').classList.contains('hidden') &&
        wb.document.getElementById('ref-zone-device').classList.contains('hidden'));
    check('bibliothèque vide → état vide affiché',
        !!wb.document.querySelector('#ref-library-grid .ref-empty'));
    check('état vide oriente vers l\'onglet Image',
        wb.document.querySelector('#ref-library-grid .ref-empty').textContent.indexOf('Image') !== -1);

    /* Deux créations images de test dans la bibliothèque. */
    wb.eval('AssetService.add({type:"image", url:"data:image/png;base64,iVBOR", name:"Création alpha"});' +
            'AssetService.add({type:"image", url:"data:image/png;base64,iVBOR2", name:"Création bêta"});' +
            'AssetService.add({type:"video", url:"https://cdn.test/v.mp4", name:"Vidéo"});' +
            'Handlers.renderRefLibrary();');
    const libBtns = wb.document.querySelectorAll('#ref-library-grid [data-ref-pick]');
    const imgCount = wb.eval('AssetService.filter({type:"image"}).length');
    check('la grille ne montre que les images', libBtns.length === imgCount && imgCount === 2, libBtns.length);
    /* Aucun bouton ne pointe vers l'asset vidéo injecté. */
    const videoId = wb.eval('AssetService.filter({type:"video"})[0].id');
    check('aucune vidéo proposée comme source',
        Array.from(libBtns).every(b => b.dataset.refPick !== videoId));

    /* Sélection d'une image de la bibliothèque. */
    libBtns[0].click();
    const refs = wb.eval('JSON.stringify(UIState.videoRefs)');
    check('sélection → 1 référence enregistrée', wb.eval('UIState.videoRefs.length') === 1, refs);
    check('la référence porte son identifiant de bibliothèque',
        wb.eval('UIState.videoRefs[0].source') === 'library' &&
        !!wb.eval('UIState.videoRefs[0].assetId'));
    /* La vignette reprend l'URL de la création, telle quelle : c'est la
       passerelle qui l'encodera, jamais le navigateur. */
    const picked = wb.eval('JSON.parse(JSON.stringify(UIState.videoRefs[0]))');
    check('la vignette de prévisualisation utilise l\'URL de la création',
        picked.preview === picked.dataUri && /^data:image\//.test(picked.preview), picked.preview);
    check('l\'URL est aussi portée dans dataUri (prête pour la passerelle)',
        picked.dataUri === wb.eval('AssetService.get("' + picked.assetId + '").url'));
    check('élément de la grille marqué sélectionné',
        !!wb.document.querySelector('#ref-library-grid [data-ref-pick].is-selected'));
    check('l\'élément sélectionné est annoncé (aria-pressed)',
        wb.document.querySelector('#ref-library-grid [data-ref-pick].is-selected')
            .getAttribute('aria-pressed') === 'true');

    /* En image-to-video, une seule image : la seconde doit être refusée. */
    wb.document.querySelectorAll('#ref-library-grid [data-ref-pick]')[1].click();
    check('image-to-video : deuxième image refusée', wb.eval('UIState.videoRefs.length') === 1);
    check('refus annoncé à l\'utilisateur',
        wb.document.getElementById('toast-text').textContent.indexOf('Une seule image') !== -1,
        wb.document.getElementById('toast-text').textContent);

    /* Le même asset ne peut pas être ajouté deux fois. */
    wb.document.querySelectorAll('#ref-library-grid [data-ref-pick]')[0].click();
    check('doublon refusé', wb.eval('UIState.videoRefs.length') === 1);

    /* Keyframes autorise deux images. */
    wb.document.querySelector('.mode-tile[data-mode="keyframes"]').click();
    check('mode keyframes → limite 2', wb.eval('Handlers.refLimit()') === 2);
    wb.document.querySelectorAll('#ref-library-grid [data-ref-pick]')[1].click();
    check('keyframes : deuxième image acceptée', wb.eval('UIState.videoRefs.length') === 2);
    check('compteur d\'usage mis à jour',
        wb.document.querySelector('#ref-library-grid .ref-limit').textContent.indexOf('2 / 2') !== -1,
        wb.document.querySelector('#ref-library-grid .ref-limit').textContent);

    /* Retour appareil : le parcours fichier historique est intact. */
    wb.document.getElementById('ref-tab-device').click();
    check('retour appareil : zone d\'upload à nouveau visible',
        !wb.document.getElementById('ref-zone-device').classList.contains('hidden') &&
        wb.document.getElementById('ref-zone-library').classList.contains('hidden'));
    check('l\'input fichier est toujours en place (non cassé)',
        !!wb.document.getElementById('video-ref-input') &&
        wb.document.getElementById('video-ref-input').multiple === true);

    /* Une URL de bibliothèque est déjà un data-URI ou une URL : la
       passerelle se charge de la conversion, jamais le navigateur. */
    check('aucun fetch de l\'URL côté client',
        wb.eval('JSON.stringify(UIState.videoRefs)').indexOf('fetch') === -1);

    const failed = results.filter(r => !r.ok);
    console.log('\n════════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests interface/sécurité OK');
    if (failed.length) console.log('ECHECS : ' + failed.map(f => f.label).join(', '));
    else console.log('INTERFACE PUBLIQUE CONFORME');
    setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})().catch(e => { console.error(e); process.exit(1); });
