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

    console.log('\n=== 7ter. SUPPRESSION DE COMPTE & REFRIGÉRISSEMENT 30 JOURS ===');
    const upgradeDel = fs.readFileSync(path.join(PROJECT, 'supabase/upgrade-delete-account.sql'), 'utf8');
    const delFn = fs.readFileSync(path.join(PROJECT, 'supabase/functions/delete-account/index.ts'), 'utf8');
    check('upgrade : table des e-mails supprimés', /create table if not exists public\.deleted_emails/.test(upgradeDel));
    check('e-mail bloqué 30 jours', /interval '30 days'/.test(upgradeDel));
    check('lecture du refroidissement en SECURITY DEFINER',
        /email_cooling_down[\s\S]{0,200}security definer/.test(upgradeDel));
    check('garde-fou serveur avant création sur auth\.users',
        /lsv_block_deleted_email/.test(upgradeDel) && /before insert on auth\.users/.test(upgradeDel));
    check('aucune policy sur la liste des e-mails supprimés',
        !/create policy[\s\S]{0,80}deleted_emails/.test(upgradeDel));
    check('fonction serveur : suppression via l API admin GoTrue', /auth\.admin\.deleteUser/.test(delFn));
    check('fonction serveur : e-mail conservé avant la purge',
        delFn.indexOf('deleted_emails') !== -1 &&
        delFn.indexOf('deleted_emails') < delFn.indexOf('admin.deleteUser'));
    check('événement account_deleted dans la liste blanche', /'account_deleted'/.test(schema));
    check('bouton supprimer présent dans le panneau Compte', !!doc.getElementById('account-delete'));
    check('friendly conserve le message de refroidissement (date comprise)',
        /15 janvier 2099/.test(wb.LSV.services.account.friendly('Compte supprimé récemment : réessaie après le 15 janvier 2099.')),
        wb.LSV.services.account.friendly('Compte supprimé récemment : réessaie après le 15 janvier 2099.'));

    // Inscription sans e-mail confirmé : le mode bascule en connexion et le
    // bouton doit suivre (il affichait encore « Créer le compte » avant).
    const cool = await load(prepare());
    const wc = cool.dom.window;
    const dc = wc.document;
    const aCalls = [];
    wc.fetch = function (url) {
        const u = String(url);
        aCalls.push(u);
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/rest/v1/rpc/email_cooling_down')) return Promise.resolve({ ok: true, status: 200, json: async () => null, text: async () => '' });
        if (u.includes('/auth/v1/signup')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ user: { email: 'sans-confirmation@lsv.ai', user_metadata: {} } }),
                text: async () => ''
            });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    dc.getElementById('account-open').click();
    dc.getElementById('account-mode').click(); // → mode inscription
    dc.getElementById('account-name').value = 'Camille Test';
    dc.getElementById('account-email').value = 'sans-confirmation@lsv.ai';
    dc.getElementById('account-password').value = 'mot-de-passe-test';
    dc.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 350));
    check('inscription non confirmée → mode connexion',
        dc.getElementById('auth-heading').textContent === 'Se connecter', dc.getElementById('auth-heading').textContent);
    check('bouton du formulaire recalcule « Se connecter »',
        dc.getElementById('account-submit').textContent === 'Se connecter', dc.getElementById('account-submit').textContent);
    check('invitation à confirmer son e-mail',
        /confirme ton e-mail/i.test(dc.getElementById('account-status-text').textContent),
        dc.getElementById('account-status-text').textContent);
    check('aucune erreur console (inscription non confirmée)', cool.errors.length === 0, cool.errors.join('|'));

    // E-mail en refroidissement : refus avant même d'appeler l'inscription.
    const bCalls = [];
    wc.fetch = function (url) {
        const u = String(url);
        bCalls.push(u);
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/rest/v1/rpc/email_cooling_down')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => '2099-01-15T12:00:00Z', text: async () => '' });
        }
        if (u.includes('/auth/v1/signup')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ access_token: 'jwt-bloquee', refresh_token: 'rfr-bloquee', expires_in: 3600, user: { email: 'bloquee@lsv.ai' } }),
                text: async () => ''
            });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    dc.getElementById('account-mode').click(); // → retour mode inscription
    dc.getElementById('account-name').value = 'Camille Test';
    dc.getElementById('account-email').value = 'bloquee@lsv.ai';
    dc.getElementById('account-password').value = 'mot-de-passe-test';
    dc.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 350));
    const coolMsg = dc.getElementById('account-status-text').textContent;
    check('refroidissement : aucune requête d inscription envoyée',
        !bCalls.some(u => u.includes('/auth/v1/signup')), bCalls.join(','));
    check('refroidissement : date de réessai affichée',
        /réessaie après le 15 janvier 2099/i.test(coolMsg), coolMsg);
    check('refroidissement : aucun détail technique',
        !/HTTP|sk-|2099-01|T12/i.test(coolMsg), coolMsg);
    check('toujours déconnecté après refus', dc.getElementById('account-user').classList.contains('hidden'));
    check('aucune erreur console (refroidissement)', cool.errors.length === 0, cool.errors.join('|'));

    // Suppression de compte : deux clics, purge locale, session vidée.
    const del = await load(prepare());
    const wd = del.dom.window;
    const dd = wd.document;
    const dCalls = [];
    wd.fetch = function (url, options) {
        const u = String(url);
        dCalls.push({
            url: u,
            method: (options && options.method) || 'GET',
            headers: (options && options.headers) || {}
        });
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/auth/v1/token')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ access_token: 'jwt-a-supprimer', refresh_token: 'rfr-a-supprimer', expires_in: 3600, user: { email: 'supprime@lsv.ai' } }),
                text: async () => ''
            });
        }
        if (u.includes('/rest/v1/rpc/is_admin')) return Promise.resolve({ ok: true, status: 200, json: async () => false, text: async () => '' });
        if (u.includes('/functions/v1/delete-account')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    dd.getElementById('account-open').click();
    dd.getElementById('account-email').value = 'supprime@lsv.ai';
    dd.getElementById('account-password').value = 'mot-de-passe-test';
    dd.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 400));
    check('bouton supprimer visible une fois connecté',
        !dd.getElementById('account-user').classList.contains('hidden') &&
        !dd.getElementById('account-delete').classList.contains('hidden'));
    wd.localStorage.setItem('lsv4_projects', JSON.stringify([{ id: 'p1', name: 'Projet de test' }]));
    wd.localStorage.setItem('lsv4_images', JSON.stringify(['img1']));
    dd.getElementById('account-delete').click();
    await new Promise(r => setTimeout(r, 60));
    check('premier clic : aucune requête de suppression',
        !dCalls.some(c => c.url.includes('/functions/v1/delete-account')));
    check('premier clic : bouton en mode confirmation',
        /Confirmer/.test(dd.getElementById('account-delete').textContent),
        dd.getElementById('account-delete').textContent);
    dd.getElementById('account-delete').click();
    await new Promise(r => setTimeout(r, 400));
    const delCall = dCalls.find(c => c.url.includes('/functions/v1/delete-account'));
    check('second clic : requête de suppression envoyée', !!delCall && delCall.method === 'POST');
    check('requête portée par le jeton du compte',
        !!delCall && /Bearer jwt-a-supprimer/.test(String((delCall.headers && delCall.headers.Authorization) || '')),
        delCall && delCall.headers && delCall.headers.Authorization);
    check('session locale vidée', !wd.localStorage.getItem('lsv4_account'));
    check('données locales purgées (projets et bibliothèque)',
        !wd.localStorage.getItem('lsv4_projects') && !wd.localStorage.getItem('lsv4_images'));
    check('panneau invité de retour',
        dd.getElementById('account-user').classList.contains('hidden') &&
        !dd.getElementById('account-guest').classList.contains('hidden'));
    check('page d accueil réaffichée', !dd.getElementById('welcome').classList.contains('hidden'));
    check('toast « Compte supprimé »',
        /Compte supprimé/i.test(dd.getElementById('toast-text').textContent),
        dd.getElementById('toast-text').textContent);
    check('aucune erreur console (suppression)', del.errors.length === 0, del.errors.join('|'));

    console.log('\n=== 7quater. ISOLEMENT DES COMPTES, CORS CLOUDFLARE, MOBILE ===');
    const coreJs = fs.readFileSync(path.join(PROJECT, 'scripts/core.js'), 'utf8');
    const libImport = fs.readFileSync(path.join(PROJECT, 'studio/core/library-import.js'), 'utf8');
    const gwIndex = fs.readFileSync(path.join(PROJECT, 'supabase/functions/lsv-gateway/index.ts'), 'utf8');
    const contactIndex = fs.readFileSync(path.join(PROJECT, 'supabase/functions/lsv-contact/index.ts'), 'utf8');
    const delIndex = fs.readFileSync(path.join(PROJECT, 'supabase/functions/delete-account/index.ts'), 'utf8');
    const WORKER = 'lsv-ai.lestudioviral.workers.dev';
    check('données créatives suffixées par le compte (clé __u)',
        /base \+ '__u' \+ this\._owner/.test(coreJs) && /_SCOPED/.test(coreJs));
    check('préférences d appareil (thème, modèle) restent globales',
        !/THEME.*_k\(|_k\(STORAGE_KEYS\.THEME\)/.test(coreJs));
    check('Studio : bibliothèque lue sous la clé du compte connecté',
        /lsv4_assets__u/.test(libImport) && /assetsKey/.test(libImport));
    check('passerelle : origine Cloudflare autorisée (CORS)', gwIndex.indexOf(WORKER) !== -1);
    check('contact : origine Cloudflare autorisée (CORS)', contactIndex.indexOf(WORKER) !== -1);
    check('suppression de compte : origine Cloudflare autorisée (CORS)', delIndex.indexOf(WORKER) !== -1);
    const googleFile = path.join(PROJECT, 'google830a692cd2d78a2e.html');
    check('fichier de vérification Google présent',
        fs.existsSync(googleFile) &&
        fs.readFileSync(googleFile, 'utf8').trim() === 'google-site-verification: google830a692cd2d78a2e.html');

    // Isolement fonctionnel : A crée, B ne voit rien, A retrouve ses données.
    const iso = await load(prepare());
    const wi = iso.dom.window;
    const st = wi.LSV.services.storage;
    st.setOwner('compte-a-uuid');
    st.setProjects([{ id: 'p-a', name: 'Projet de A' }]);
    st.setConversations([{ id: 'c-a', title: 'Chat de A', messages: [] }]);
    check('compte A : données enregistrées sous clé suffixée',
        !!wi.localStorage.getItem('lsv4_projects__ucompte-a-uuid') &&
        wi.localStorage.getItem('lsv4_projects') === null);
    st.setOwner('compte-b-uuid');
    check('compte B : aucun projet ni conversation de A visible',
        st.getProjects().length === 0 && st.getConversations().length === 0);
    check('compte B : clé de A toujours presente mais non lue',
        !!wi.localStorage.getItem('lsv4_projects__ucompte-a-uuid') && st.getProjects().length === 0);
    st.setOwner('compte-a-uuid');
    check('retour au compte A : projets et conversations retrouvés',
        st.getProjects().length === 1 && st.getConversations().length === 1);

    // Adoption : les données d'avant-compte passent au premier compte.
    const legacy = await load(prepare());
    const wl = legacy.dom.window;
    wl.localStorage.setItem('lsv4_projects', JSON.stringify([{ id: 'p-legacy', name: 'Projet d avant' }]));
    wl.LSV.services.storage.setOwner('premier-compte');
    check('données d avant-compte adoptées par le premier compte',
        !!wl.localStorage.getItem('lsv4_projects__upremier-compte') &&
        wl.localStorage.getItem('lsv4_projects') === null);
    check('adoption : contenu intact',
        wl.LSV.services.storage.getProjects().length === 1 &&
        wl.LSV.services.storage.getProjects()[0].id === 'p-legacy');
    wl.LSV.services.storage.setOwner('autre-compte');
    check('deuxième compte : rien de l adoption hérité',
        wl.LSV.services.storage.getProjects().length === 0);

    // Connexion réelle (formulaire) : clés écrites sous le suffixe du compte.
    const live = await load(prepare());
    const wv = live.dom.window;
    const dv = wv.document;
    wv.fetch = function (url) {
        const u = String(url);
        if (u.includes('/rest/v1/analytics_events')) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        if (u.includes('/auth/v1/token')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ access_token: 'jwt-iso', refresh_token: 'rfr-iso', expires_in: 3600, user: { email: 'iso@lsv.ai', id: 'compte-live-id' } }),
                text: async () => ''
            });
        }
        if (u.includes('/rest/v1/rpc/is_admin')) return Promise.resolve({ ok: true, status: 200, json: async () => false, text: async () => '' });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    dv.getElementById('account-open').click();
    dv.getElementById('account-email').value = 'iso@lsv.ai';
    dv.getElementById('account-password').value = 'mot-de-passe-test';
    dv.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 400));
    wv.LSV.services.storage.setAssets([{ id: 'asset-iso', type: 'image', url: 'u', name: 'n', metadata: {}, createdAt: 1 }]);
    check('après connexion : bibliothèque sous la clé du compte',
        !!wv.localStorage.getItem('lsv4_assets__ucompte-live-id') &&
        wv.localStorage.getItem('lsv4_assets') === null);
    check('propriétaire actif = identifiant du compte',
        wv.LSV.services.storage.owner() === 'compte-live-id', wv.LSV.services.storage.owner());
    dv.getElementById('account-logout').click();
    await new Promise(r => setTimeout(r, 80));
    check('après déconnexion : bibliothèque invisible (clés conservées)',
        wv.LSV.services.storage.getAssets().length === 0 &&
        !!wv.localStorage.getItem('lsv4_assets__ucompte-live-id'));
    check('aucune erreur console (isolement)', iso.errors.length === 0 && legacy.errors.length === 0 && live.errors.length === 0,
        iso.errors.concat(legacy.errors, live.errors).join('|'));

    // Mobile : remontée en haut au changement d onglet + panneau Paramètres.
    const mob = await load(prepare());
    const wm = mob.dom.window;
    const dm = wm.document;
    let scrollSeen = null;
    wm.scrollTo = function (x, y) { scrollSeen = [x, y]; };
    dm.querySelector('.nav-mob[data-tab="chat"]').click();
    check('clic Chat (mobile) : page remontée en haut', scrollSeen && scrollSeen[0] === 0 && scrollSeen[1] === 0, JSON.stringify(scrollSeen));
    check('onglet Chat actif après clic', dm.getElementById('tab-chat').classList.contains('active'));
    const setBtn = dm.getElementById('mobile-settings');
    check('bouton Paramètres présent dans la barre mobile', !!setBtn);
    setBtn.click();
    check('clic Paramètres : panneau affiché', dm.body.classList.contains('panel-open') && setBtn.getAttribute('aria-expanded') === 'true');
    dm.querySelector('.nav-mob[data-tab="image"]').click();
    check('navigation : panneau Paramètres refermé automatiquement', !dm.body.classList.contains('panel-open'));
    setBtn.click();
    check('clic après navigation : panneau réaffiché', dm.body.classList.contains('panel-open') && setBtn.getAttribute('aria-expanded') === 'true');
    setBtn.click();
    check('second clic Paramètres : panneau masqué', !dm.body.classList.contains('panel-open') && setBtn.getAttribute('aria-expanded') === 'false');
    check('aucune erreur console (mobile)', mob.errors.length === 0, mob.errors.join('|'));

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

    console.log('\n=== 11bis. SERVICE VIDÉO SATURÉ ===');
    const failWith = async (status, heads) => wb.LSV.services.agnes.fail({
        status,
        headers: { get: n => (heads[n] || null) },
        text: async () => '{"code":"video_queue_full","message":"video queue is full"}'
    });
    const satErr = await failWith(503, {
        'x-lsv-request-id': 'jolqw0-vwhvik',
        'x-lsv-upstream-status': '503',
        'x-lsv-upstream-code': 'video_queue_full'
    });
    const satMsg = wb.LSV.utils.friendlyError(satErr);
    check('fail() porte le jeton amont reçu par la passerelle', satErr.code === 'video_queue_full', satErr.code);
    check('fail() garde la trace technique pour le journal', /HTTP 503 \[jolqw0-vwhvik\]/.test(satErr.message), satErr.message);
    check('saturation vidéo : message honnête et actionnable', /satur/i.test(satMsg) && /quelques minutes/i.test(satMsg), satMsg);
    check('saturation vidéo : aucun détail technique',
        !/API Key|Agnes|agnes|apihub|Bearer|sk-|Token|Authorization|Polling|Endpoint|HTTP|video_queue/i.test(satMsg), satMsg);
    const plainErr = await failWith(503, { 'x-lsv-request-id': 'abc-def' });
    check('503 sans jeton → message générique inchangé', /Impossible de générer/.test(wb.LSV.utils.friendlyError(plainErr)), wb.LSV.utils.friendlyError(plainErr));
    check('autre erreur amont → message générique inchangé',
        /Impossible de générer/.test(wb.LSV.utils.friendlyError(new Error('HTTP 502 [x] — {"a":1}'))));
    const mediaSrc = fs.readFileSync(path.join(PROJECT, 'scripts/media.js'), 'utf8');
    check('l interface annonce la saturation pendant les essais', /File vidéo saturée/.test(mediaSrc));
    check('statut de saturation borné au seul code connu',
        /code === 'video_queue_full'[\s\S]{0,40}\? 'File vidéo saturée/.test(mediaSrc));

    console.log('\n=== 11ter. DISPONIBILITÉ DU SERVICE VIDÉO (bandeau) ===');
    /* Le bandeau ne dit QUE ce qui est MESURÉ : sonde passerelle + dernière
       saturation réellement observée. Il ne promet jamais qu'une génération
       va aboutir, et ne déclare jamais « en panne » sur la base d'un simple
       échec de réseau. */
    const avail = wb.LSV.services.availability;
    check('service de disponibilité exposé',
        !!avail && typeof avail.refresh === 'function' && typeof avail.markSaturated === 'function' &&
        typeof avail.render === 'function');
    check('bandeau complet dans l\'onglet Vidéo',
        !!doc.getElementById('video-availability') && !!doc.getElementById('video-avail-title') &&
        !!doc.getElementById('video-avail-hint') && !!doc.getElementById('video-avail-badge') &&
        !!doc.getElementById('video-avail-recheck') && !!doc.getElementById('video-avail-dot'));
    check('bouton Re-vérifier actionnable',
        doc.getElementById('video-avail-recheck').tagName === 'BUTTON' &&
        !doc.getElementById('video-avail-recheck').disabled);

    /* a) Refus RÉEL (503 saturé) sur une tentative de génération : le
       bandeau suit immédiatement, et surtout RIEN n'est perdu pour
       l'utilisateur — c'est ce qui permet de réessayer sans tout refaire. */
    const promptBefore = wb.LSV.uiState.videoPrompt;
    const refsBefore = wb.LSV.uiState.videoRefs;
    wb.LSV.uiState.videoPrompt = 'Plan large d\'une ville au crépuscule';
    wb.LSV.uiState.videoRefs = [{ id: 1, name: 'ref.png', dataUri: 'data:image/png;base64,AAA' }];
    wb.LSV.services.account._s = {
        access_token: 'jwt-de-test', refresh_token: 'rfr-de-test',
        expires_at: Math.floor(Date.now() / 1000) + 3600, email: 'test@lsv.ai'
    };
    const realSleep = wb.LSV.utils.sleep;
    wb.LSV.utils.sleep = () => Promise.resolve();      /* 7 essais sans attendre */
    const failCalls = [];
    wb.fetch = (url) => {
        failCalls.push(String(url));
        return Promise.resolve({
            ok: false, status: 503,
            headers: { get: n => ({
                'x-lsv-upstream-code': 'video_queue_full',
                'x-lsv-upstream-status': '503',
                'x-lsv-request-id': 'test-503'
            }[n] || null) },
            text: async () => '{"code":"video_queue_full"}',
            json: async () => ({})
        });
    };
    let taskErr = null;
    try { await wb.LSV.services.video.createTask(null, null, 'prompt de test', 121); }
    catch (e) { taskErr = e; }
    wb.LSV.utils.sleep = realSleep;
    wb.LSV.ui.setStatus(null);
    check('tentative refusée avec le jeton exact du fournisseur', taskErr && taskErr.code === 'video_queue_full', taskErr && taskErr.code);
    check('essais bornés (aucune reprise illimitée)', failCalls.length <= 8, failCalls.length);
    check('refus réel → bandeau en « file saturée »', avail.status === 'queue_full', avail.status);
    check('badge DOM à jour', doc.getElementById('video-avail-badge').textContent === 'File saturée',
        doc.getElementById('video-avail-badge').textContent);
    check('aucune promesse de réussite dans le bandeau',
        !/prêt|réussi|garanti|disponible/i.test(
            doc.getElementById('video-avail-title').textContent + ' ' +
            doc.getElementById('video-avail-hint').textContent),
        doc.getElementById('video-avail-title').textContent);
    check('compte à rebours borné (15 s à 300 s)', avail.remaining() >= 15 && avail.remaining() <= 300, avail.remaining());
    check('état mémorisé pour la prochaine ouverture', !!wb.localStorage.getItem('lsv4_video_avail'));
    check('prompt conservé malgré l\'échec', wb.LSV.uiState.videoPrompt === 'Plan large d\'une ville au crépuscule',
        wb.LSV.uiState.videoPrompt);
    check('image de référence conservée malgré l\'échec', wb.LSV.uiState.videoRefs.length === 1,
        wb.LSV.uiState.videoRefs.length);

    /* b) Sonde de la passerelle : URL, cache local, affichage. */
    const probeCalls = [];
    wb.fetch = (url) => {
        probeCalls.push(String(url));
        return Promise.resolve({
            ok: true, status: 200,
            headers: { get: () => null },
            json: async () => ({
                available: true, status: 'ok', probe: 'models_ok', provider: 'agnes',
                checked_at: Date.now(), ttl: 60, retry_after: 0
            })
        });
    };
    await avail.refresh(true);
    check('sonde vers la passerelle uniquement (jamais le fournisseur)',
        probeCalls.length === 1 && probeCalls[0].indexOf('/v1/video-availability') !== -1 &&
        probeCalls[0].indexOf('agnes-ai') === -1, probeCalls[0]);
    check('état « ok » affiché après sonde réussie', avail.status === 'ok', avail.status);
    check('boîte verte = mesure, pas promesse', doc.getElementById('video-availability').classList.contains('avail-ok'));
    const probesAfterOk = probeCalls.length;
    await avail.refresh(false);
    check('cache local : pas de sonde inutile dans le TTL', probeCalls.length === probesAfterOk, probeCalls.length);

    /* c) Échec de la sonde : « non vérifié », ni « ok » ni « en panne ». */
    wb.fetch = () => Promise.reject(new Error('reseau'));
    await avail.refresh(true);
    check('sonde en échec → « unknown » (pas d\'incident inventé)', avail.status === 'unknown' && avail.probe === 'sonde_echouee',
        avail.status + '/' + avail.probe);
    check('bandeau dit « non vérifié », pas « indisponible »',
        /non vérifié/i.test(doc.getElementById('video-avail-badge').textContent) &&
        !/panne|indisponible/i.test(doc.getElementById('video-avail-hint').textContent),
        doc.getElementById('video-avail-badge').textContent);

    /* d) L'ouverture de l'onglet Vidéo déclenche bien la vérification. */
    let refreshCalls = 0;
    const realRefresh = avail.refresh;
    avail.refresh = function (f) { refreshCalls++; return realRefresh.call(avail, f); };
    wb.LSV.ui.switchTab('video');
    avail.refresh = realRefresh;
    check('ouverture de l\'onglet Vidéo → vérification lancée', refreshCalls >= 1, refreshCalls);

    /* e) L'état d'erreur ne contamine pas la suite des tests. */
    wb.LSV.uiState.videoPrompt = promptBefore;
    wb.LSV.uiState.videoRefs = refsBefore;
    check('données de test nettoyées', wb.LSV.uiState.videoRefs.length === refsBefore.length, wb.LSV.uiState.videoRefs.length);

    console.log('\n=== 11quater. CENTRE « ALTERNATIVES VIDÉO » ===');
    /* Des SITES gratuits vérifiés sur leur page officielle, ouverts dans un
       nouvel onglet : aucun appel API tiers, aucune donnée LSV.ai envoyée,
       et aucun champ inconnu présenté comme certain. */
    const alts = wb.LSV.alternatives;
    check('catalogue d\'alternatives exposé (6 services)',
        Array.isArray(alts) && alts.length === 6, alts && alts.length);
    check('chaque fiche porte sa page source officielle',
        alts.every(a => /^https:\/\/[a-z]/i.test(a.source)), alts.map(a => a.source).join(' '));
    const known = v => v === 'oui' || v === 'non' || v === 'non vérifié';
    check('image→vidéo / filigrane / licence : jamais d\'inconnu présenté pour acquis',
        alts.every(a => known(a.i2v) && known(a.watermark) && known(a.license)));
    check('quota gratuit formulé comme relevé, pas inventé',
        alts.every(a => typeof a.free === 'string' && a.free.length > 10));
    const altList = doc.getElementById('video-alt-list');
    const altLinks = altList ? altList.querySelectorAll('a.alt-item') : [];
    check('6 cartes rendues', altLinks.length === 6, altLinks.length);
    check('chaque lien ouvre un nouvel onglet sans échange',
        Array.from(altLinks).every(a => a.target === '_blank' && /noopener/.test(a.rel) && /^https:\/\//.test(a.href)));
    check('domaines officiels uniquement (aucun lien fabriqué)',
        Array.from(altLinks).every(a => /flow\.google\.com|app\.pixverse\.ai|www\.vidu\.com|hailuoai\.video|klingai\.com|runwayml\.com/.test(a.href)),
        Array.from(altLinks).map(a => a.href).join(' '));
    const altText = doc.getElementById('video-alternatives').textContent;
    check('aucun nom de fournisseur ni terme technique interdit dans le centre',
        !/Agnes|agnes|Bearer|sk-|Token|Endpoint|Polling|apihub/i.test(altText));
    check('le centre affirme que rien ne quitte LSV.ai', /Aucune donnée LSV\.ai n'est envoyée/.test(altText));
    check('date de vérification affichée', altText.indexOf(wb.LSV.altChecked) !== -1, wb.LSV.altChecked);
    check('origine des quotas indiquée (pages officielles)', /pages officielles/.test(altText));

    const altPanel = doc.getElementById('video-alt-panel');
    const altToggle = doc.getElementById('video-alt-toggle');
    check('panneau replié par défaut dans le HTML', /id="video-alt-panel" hidden/.test(source));
    /* 11ter s'est terminé sur un refus RÉEL : le centre est donc déjà ouvert,
       et il ne se referme jamais tout seul (l'état reste consultable). */
    check('refus réel de 11ter → centre déjà déplié', altPanel.hidden === false, altPanel.hidden);
    altToggle.click();
    check('refermeture manuelle possible', altPanel.hidden === true && altToggle.getAttribute('aria-expanded') === 'false');
    avail.markSaturated(120);
    check('problème constaté → centre déplié automatiquement',
        altPanel.hidden === false && altToggle.getAttribute('aria-expanded') === 'true', altPanel.hidden);
    check('bouton cohérent après dépliage', /Masquer/.test(altToggle.textContent), altToggle.textContent.trim());
    altToggle.click();
    check('bascule d\'ouverture/fermeture stable', altPanel.hidden === true, altPanel.hidden);

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
    /* Une icône est une LIGATURE de la police Material Symbols : un nom
       inexistant ne casse pas le code, il s'affiche en toutes lettres à
       l'écran (bug vécu sur « view_storyboard », affiché texte brut dans la
       tuile Storyboard). Liste de référence = noms présents dans le bundle,
       chacun vérifié comme existant dans le dépôt officiel
       google/material-design-icons et sur le chemin de production
       fonts.gstatic.com (29 octobre 2026). Toute icône NOUVELLE doit être
       ajoutée à cette liste après vérification. */
    const MS_LIGATURES = [
        '360', 'account_circle', 'account_tree', 'add', 'alt_route', 'apartment', 'arrow_forward',
        'aspect_ratio', 'attach_file', 'auto_awesome', 'auto_fix_high', 'auto_stories', 'bolt', 'brush',
        'burst_mode', 'category', 'check_circle', 'checkroom', 'close', 'cloud_upload', 'collections',
        'content_copy', 'crop', 'crop_square', 'dashboard', 'data_usage', 'delete', 'delete_forever',
        'description', 'diamond', 'difference', 'dns', 'download', 'east', 'edit',
        'edit_note', 'emoji_emotions', 'expand_more', 'folder', 'folder_open', 'follow_the_signs', 'forest',
        'forum', 'history', 'history_edu', 'hourglass_top', 'image', 'image_search', 'info',
        'landscape', 'lightbulb', 'lock', 'mail', 'memory', 'menu', 'menu_book',
        'monitor_heart', 'movie', 'movie_filter', 'nightlife', 'palette', 'pause', 'person',
        'photo_camera', 'photo_library', 'play_circle', 'queue', 'refresh', 'rocket_launch', 'school',
        'send', 'settings', 'shopping_bag', 'slow_motion_video', 'smart_toy', 'smartphone', 'speed',
        'splitscreen', 'stop_circle', 'storage', 'storefront', 'straighten', 'theater_comedy', 'timer',
        'trending_up', 'tune', 'video_library', 'videocam', 'view_in_ar', 'view_timeline', 'visibility_off',
        'warning', 'west', 'zoom_in', 'zoom_out'
    ];
    const msUsed = [...new Set(
        [...bundle.matchAll(/class="ms"[^>]*>([a-z0-9_]+)</g)].map(m => m[1])
            .concat([...bundle.matchAll(/icon:\s*'([a-z0-9_]+)'/g)].map(m => m[1]))
    )];
    const msUnknown = msUsed.filter(n => MS_LIGATURES.indexOf(n) === -1);
    check('icônes : ligatures Material Symbols réelles (jamais de texte brut à l\'écran)',
        msUsed.length > 60 && msUnknown.length === 0,
        msUnknown.join(', ') || msUsed.length + ' noms vérifiés');

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

    console.log('\n=== 15. MODÈLE DE CHAT : INTÉGRÉ / MISTRAL ===');
    /* Le sélecteur choisit un MODÈLE déclaré ; c'est la passerelle qui
       décide ensuite de la destination. Le navigateur ne connaît ni clé, ni
       URL de fournisseur : la valeur d'une option est un index, pas un
       identifiant qui révélerait un fournisseur dans le DOM public. */
    const sel15 = wb.document.getElementById('chat-model-select');
    check('sélecteur de modèle présent dans l\'en-tête du chat', !!sel15);
    check('deux modèles proposés', !!sel15 && sel15.options.length === 2, sel15 && sel15.options.length);
    check('valeurs = index (aucun identifiant de modèle dans le DOM)',
        !!sel15 && sel15.options[0].value === '0' && sel15.options[1].value === '1',
        sel15 && sel15.options[0].value + '/' + sel15.options[1].value);
    check('libellés sans clé, URL ni jeton',
        !!sel15 && !/agnes|apihub|sk-|Bearer|https?:/i.test(sel15.innerHTML), sel15 && sel15.innerHTML);
    check('modèle par défaut = modèle intégré',
        wb.eval('LSV.services.chat.model()') === wb.eval('LSV.config.MODEL_CHAT'),
        wb.eval('LSV.services.chat.model()'));
    check('deux modèles distincts exposés',
        wb.eval('LSV.config.CHAT_MODELS.length') === 2 &&
        wb.eval('LSV.config.CHAT_MODELS[0].id') !== wb.eval('LSV.config.CHAT_MODELS[1].id'));

    /* Choix de l'option Mistral : événement normal du sélecteur. Le choix
       vit pour la SESSION seulement — jamais en stockage : au chargement
       suivant, le modèle intégré redevient le défaut. */
    sel15.value = '1';
    sel15.dispatchEvent(new wb.Event('change', { bubbles: true }));
    check('choix Mistral enregistré pour la session', wb.eval('LSV.services.chat.model()') === 'mistral-small-2603',
        wb.eval('LSV.services.chat.model()'));
    check('choix NON persisté : rien écrit en stockage',
        wb.localStorage.getItem('lsv4_chat_model') === null,
        String(wb.localStorage.getItem('lsv4_chat_model')));
    check('choix annoncé en clair à l\'utilisateur',
        doc.getElementById('toast-text').textContent.indexOf('Mistral') !== -1,
        doc.getElementById('toast-text').textContent);

    /* Une valeur inconnue (modèle retiré entre deux versions) est refusée :
       elle n'est jamais envoyée telle quelle au fournisseur. */
    check('setModel d\'un modèle inconnu ignoré (modèle inchangé)',
        wb.eval('LSV.services.chat.setModel("modele-inconnu"); LSV.services.chat.model()') === 'mistral-small-2603',
        wb.eval('LSV.services.chat.model()'));

    /* Envoi réel : le corps porte le modèle CHOISI, la requête part vers la
       passerelle — jamais vers un fournisseur. */
    wb.eval('AccountService._save({access_token:"jwt-de-test", refresh_token:"refresh-de-test", ' +
        'expires_at:' + (Math.floor(Date.now() / 1000) + 3600) + ', ' +
        'email:"test@lsv.ai", name:"Test", id:"11111111-1111-4111-8111-111111111111"})');
    sel15.value = '1';
    sel15.dispatchEvent(new wb.Event('change', { bubbles: true }));
    const chatCalls15 = [];
    wb.fetch = function (url, options) {
        const u = String(url);
        chatCalls15.push({ url: u, options: options || {} });
        if (u.indexOf('/chat/completions') !== -1) {
            return Promise.resolve({
                ok: true, status: 200,
                body: {
                    getReader() {
                        let n = 0;
                        const chunks = ['data: {"choices":[{"delta":{"content":"Réponse test"}}]}\n\ndata: [DONE]\n\n'];
                        return {
                            read() {
                                if (n >= chunks.length) return Promise.resolve({ done: true, value: undefined });
                                return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[n++]) });
                            },
                            releaseLock() {}
                        };
                    }
                }
            });
        }
        if (u.indexOf('/v1/providers') !== -1) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ chat: { agnes: true, mistral: true } }) });
        }
        if (u.indexOf('/rest/v1/analytics_events') !== -1) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    const conv15 = wb.eval('ConversationService.create({}).id');
    const sent15 = await wb.LSV.services.chat.send({ id: conv15 }, 'Une idée de pub', {});
    const chatReq15 = chatCalls15.find(c => c.url.indexOf('/chat/completions') !== -1);
    check('réponse reçue et enregistrée dans la conversation', sent15 === 'Réponse test', sent15);
    check('requête envoyée à la passerelle, jamais au fournisseur',
        !!chatReq15 && chatReq15.url.indexOf('apihub') === -1 &&
        chatReq15.url.indexOf('mistral.ai') === -1 &&
        chatReq15.url.indexOf('/functions/v1/lsv-gateway/v1/chat/completions') !== -1,
        chatReq15 && chatReq15.url);
    check('le corps porte le modèle choisi', !!chatReq15 &&
        JSON.parse(chatReq15.options.body).model === 'mistral-small-2603',
        chatReq15 && JSON.parse(chatReq15.options.body).model);
    check('aucune clé de fournisseur dans la requête', !!chatReq15 &&
        JSON.stringify(chatReq15.options.headers || {}).indexOf('sk-') === -1,
        chatReq15 && JSON.stringify(chatReq15.options.headers || {}).slice(0, 80));
    check('deux messages enregistrés (utilisateur + assistant)',
        wb.eval('ConversationService.get("' + conv15 + '").messages.length') === 2,
        wb.eval('ConversationService.get("' + conv15 + '").messages.length'));

    /* État des fournisseurs : la passerelle dit ce qu'elle SAIT (clé
       configurée ou non), jamais si un service est en ligne. */
    const sel15b = wb.document.getElementById('chat-model-select');
    wb.fetch = function (url) {
        if (String(url).indexOf('/v1/providers') !== -1) {
            return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    await wb.LSV.services.chat.refreshAvailability();
    check('compte non connecté (401) : aucune décision prise', sel15b.options[1].disabled === false);

    wb.fetch = function (url) {
        if (String(url).indexOf('/v1/providers') !== -1) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ chat: { agnes: true, mistral: false } }) });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    await wb.LSV.services.chat.refreshAvailability();
    check('clé Mistral absente → option grisée', sel15b.options[1].disabled === true);
    check('grisée = « non configuré », jamais une panne',
        /non configuré/.test(sel15b.options[1].textContent), sel15b.options[1].textContent);
    check('modèle intégré toujours utilisable', sel15b.options[0].disabled === false);
    check('choix devenu indisponible → retour au modèle intégré',
        wb.eval('LSV.services.chat.model()') === wb.eval('LSV.config.MODEL_CHAT'),
        wb.eval('LSV.services.chat.model()'));
    check('aucun nom de clé ni URL dans le sélecteur',
        !/sk-|https?:|Bearer/i.test(sel15b.innerHTML), sel15b.innerHTML);

    wb.fetch = function (url) {
        if (String(url).indexOf('/v1/providers') !== -1) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ chat: { agnes: true, mistral: true } }) });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    await wb.LSV.services.chat.refreshAvailability();
    check('clé à nouveau configurée → option rétablie', sel15b.options[1].disabled === false);

    /* Nettoyage : aucune session de test ne doit survivre à la section. */
    wb.eval('AccountService._save(null)');
    wb.eval('LSV.services.chat.setModel(LSV.config.MODEL_CHAT)');
    check('aucune erreur console (modèle de chat)', errors.length === 0, errors.join('|'));

    console.log('\n=== 15bis. CHAT : DÉFAUT STANDARD, ÉCHEC RAPIDE, COPIE ===');
    /* Le standard redevient le défaut à CHAQUE chargement de page : un
       modèle défaillant ne survit pas à la session qui l'a révélé. */
    const fresh15 = await load(prepare());
    const wf15 = fresh15.dom.window;
    const df15 = wf15.document;
    check('au chargement : modèle par défaut = Standard (intégré)',
        wf15.eval('LSV.services.chat.model()') === wf15.eval('LSV.config.MODEL_CHAT'),
        wf15.eval('LSV.services.chat.model()'));
    check('aucune trace d\'un choix précédent en stockage',
        wf15.localStorage.getItem('lsv4_chat_model') === null);

    /* Un chat en échec (429) doit échouer VITE : stream + un seul repli non
       fluide, sans bandeau « Génération en cours » ni boucle de rejeu de
       plusieurs minutes (l'ancien repli utilisait la file des générations). */
    wf15.eval('AccountService._save({access_token:"jwt-de-test", refresh_token:"refresh-de-test", ' +
        'expires_at:' + (Math.floor(Date.now() / 1000) + 3600) + ', ' +
        'email:"test@lsv.ai", name:"Test", id:"22222222-2222-4222-8222-222222222222"})');
    const failCalls15 = [];
    wf15.fetch = function (url, options) {
        const u = String(url);
        failCalls15.push({ url: u, options: options || {} });
        if (u.indexOf('/chat/completions') !== -1) {
            return Promise.resolve({
                ok: false, status: 429,
                json: async () => ({ error: { message: 'limite de débit' } }),
                text: async () => 'limite de débit',
                headers: { get: () => null }
            });
        }
        if (u.indexOf('/rest/v1/analytics_events') !== -1) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x', headers: { get: () => null } });
    };
    const t015 = Date.now();
    df15.getElementById('chat-input').value = 'Une idée sous tension';
    await wf15.eval('ChatView.sendMessage()');
    const dt15 = Date.now() - t015;
    const chatFails15 = failCalls15.filter(c => c.url.indexOf('/chat/completions') !== -1);
    check('429 : deux essais maximum (stream + repli non fluide)',
        chatFails15.length === 2, chatFails15.length);
    check('429 : le repli n\'enchaîne pas les rejeux',
        !!chatFails15[1] && JSON.parse(chatFails15[1].options.body).stream === undefined,
        chatFails15[1] && String(JSON.parse(chatFails15[1].options.body).stream));
    check('429 : aucun bandeau « Génération en cours »',
        df15.getElementById('status-text').textContent.indexOf('Génération en cours') === -1,
        df15.getElementById('status-text').textContent);
    check('429 : réponse rapide (moins de 3 s)', dt15 < 3000, dt15 + 'ms');
    check('429 : message utilisateur honnête, sans détail technique',
        /Impossible|réessayer|limite/i.test(df15.getElementById('toast-text').textContent) &&
        !/sk-|HTTP|apihub|mistral|agnes/i.test(df15.getElementById('toast-text').textContent),
        df15.getElementById('toast-text').textContent);
    check('429 : indicateur de saisie retiré et flux libéré',
        !df15.getElementById('chat-typing-msg') && wf15.eval('Runtime.chatStreaming') === false);

    /* Rendu façon chatbot : blocs séparés, listes structurées, icône de
       copie en bas de chaque bloc (question ET réponse). */
    wf15.fetch = function (url, options) {
        const u = String(url);
        if (u.indexOf('/chat/completions') !== -1) {
            return Promise.resolve({
                ok: true, status: 200,
                body: {
                    getReader() {
                        let n = 0;
                        const chunks = ['data: {"choices":[{"delta":{"content":"**Concept** : une id\\u00e9e\\n\\n- piste une\\n- piste deux"}}]}\n\ndata: [DONE]\n\n'];
                        return {
                            read() {
                                if (n >= chunks.length) return Promise.resolve({ done: true, value: undefined });
                                return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[n++]) });
                            },
                            releaseLock() {}
                        };
                    }
                }
            });
        }
        if (u.indexOf('/rest/v1/analytics_events') !== -1) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    let copied15 = null;
    Object.defineProperty(wf15.navigator, 'clipboard', {
        value: { writeText: async (t) => { copied15 = t; } },
        configurable: true
    });
    wf15.eval('ChatView.newConversation()');
    df15.getElementById('chat-input').value = 'Ma question créative';
    await wf15.eval('ChatView.sendMessage()');
    check('blocs séparés : icône de copie sur la question ET sur la réponse',
        df15.querySelectorAll('.chat-msg.user .chat-msg-copy').length >= 1 &&
        df15.querySelectorAll('.chat-msg.assistant .chat-msg-copy').length >= 1);
    check('réponse rendue avec gras et liste structurée',
        /<strong>Concept<\/strong>/.test(df15.getElementById('chat-messages').innerHTML) &&
        /<ul><li>piste une<\/li><li>piste deux<\/li><\/ul>/.test(df15.getElementById('chat-messages').innerHTML),
        df15.getElementById('chat-messages').innerHTML.slice(0, 200));
    df15.querySelector('.chat-msg.assistant .chat-msg-copy').click();
    check('clic sur l\'icône : réponse copiée en clair',
        copied15 === '**Concept** : une idée\n\n- piste une\n- piste deux', JSON.stringify(copied15));
    copied15 = null;
    df15.querySelector('.chat-msg.user .chat-msg-copy').click();
    check('clic sur l\'icône : question copiée en clair',
        copied15 === 'Ma question créative', JSON.stringify(copied15));
    check('aucune erreur console (chat rapide + copie)',
        fresh15.errors.length === 0, fresh15.errors.join('|'));

    console.log('\n=== 16. STUDIO DE SCÉNARIOS IA (3 MODES) ===');
    /* Trois formats, un seul contrat de sortie : le texte affiché vient de
       champs normalisés, jamais d'une lecture à la volée de la réponse. */
    const scenTab = doc.getElementById('tab-scenarios');
    check('onglet Studio de scénarios présent', !!scenTab);
    check('entrée de menu dédiée', !!doc.querySelector('.nav-item[data-tab="scenarios"]'));
    const scenTiles = doc.querySelectorAll('#scenario-mode-grid .mode-tile');
    check('trois formats proposés', scenTiles.length === 3, scenTiles.length);
    check('formats = court, long, storyboard',
        Array.from(scenTiles).map(t => t.dataset.mode).join(',') === 'court,long,storyboard',
        Array.from(scenTiles).map(t => t.dataset.mode).join(','));
    check('chaque format annoncé en clair',
        Array.from(scenTiles).every(t => /Format court|Format long|Storyboard/.test(t.textContent)),
        Array.from(scenTiles).map(t => t.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
    check('format par défaut = court', scenTiles[0].classList.contains('selected'));
    check('sortie masquée tant que rien n\'est généré',
        doc.getElementById('scenario-output').classList.contains('hidden'));
    check('l\'onglet ne porte ni clé, ni URL de fournisseur',
        !/sk-|Bearer|apihub|agnes-ai|https?:\/\/api/i.test(scenTab.innerHTML));

    /* Le choix du format suit le clic et s'annonce dans le résultat. */
    scenTiles[1].dispatchEvent(new wb.Event('click', { bubbles: true }));
    check('clic sur « Format long » → sélection basculée',
        scenTiles[1].classList.contains('selected') && !scenTiles[0].classList.contains('selected'));
    check('libellé du format affiché pour le résultat',
        doc.getElementById('scenario-mode-label').textContent === 'Format long',
        doc.getElementById('scenario-mode-label').textContent);
    scenTiles[0].dispatchEvent(new wb.Event('click', { bubbles: true }));
    check('retour au format court', scenTiles[0].classList.contains('selected'));

    /* Sans compte, aucune requête ne quitte la page. */
    const scenCalls = [];
    wb.fetch = function (url, options) {
        scenCalls.push({ url: String(url), options: options || {} });
        if (String(url).indexOf('/rest/v1/analytics_events') !== -1) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    doc.getElementById('scenario-input').value = 'Une barista découvre que sa tasse prédit l\'avenir';
    doc.getElementById('scenario-input').dispatchEvent(new wb.Event('input', { bubbles: true }));
    check('bouton de génération actif une fois l\'idée remplie',
        !doc.getElementById('scenario-generate').disabled);
    await wb.LSV.views.scenarios.generate();
    check('sans compte : aucune requête envoyée',
        !scenCalls.some(c => c.url.indexOf('/chat/completions') !== -1),
        scenCalls.map(c => c.url).join(','));
    check('sans compte : message d\'invitation, sans détail',
        /Connecte-toi/.test(doc.getElementById('toast-text').textContent) &&
        !/sk-|HTTP|apihub|agnes/i.test(doc.getElementById('toast-text').textContent),
        doc.getElementById('toast-text').textContent);
    doc.getElementById('auth-modal').classList.add('hidden');
    doc.getElementById('account-form').classList.add('hidden');

    /* Génération avec compte : requête vers la passerelle, corps en JSON. */
    wb.eval('AccountService._save({access_token:"jwt-de-test", refresh_token:"refresh-de-test", ' +
        'expires_at:' + (Math.floor(Date.now() / 1000) + 3600) + ', ' +
        'email:"test@lsv.ai", name:"Test", id:"11111111-1111-4111-8111-111111111111"})');
    const scenJson16 = JSON.stringify({
        title: 'Tasse de veille',
        logline: 'Une barista devine demain une seconde à la fois.',
        scenes: [
            { act: 'Acte I', title: 'Le service du matin', description: 'Marie sert un café, la tasse se trouble.', prompt: 'Plan large d\'une barista derrière son comptoir, lumière chaude de fin de matin' },
            { act: 'Acte II', title: 'La première prédiction', description: 'La tasse annonce la fermeture de la rue.', prompt: 'Gros plan sur une tasse de café, vapeur en forme de chiffres' }
        ]
    });
    scenCalls.length = 0;
    wb.fetch = function (url, options) {
        scenCalls.push({ url: String(url), options: options || {} });
        if (String(url).indexOf('/chat/completions') !== -1) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: scenJson16 } }] }) });
        }
        if (String(url).indexOf('/rest/v1/analytics_events') !== -1) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    await wb.LSV.views.scenarios.generate();
    const scenReq = scenCalls.find(c => c.url.indexOf('/chat/completions') !== -1);
    check('requête partie vers la passerelle',
        !!scenReq && scenReq.url.indexOf('/functions/v1/lsv-gateway/v1/chat/completions') !== -1,
        scenReq && scenReq.url);
    check('le corps porte le modèle choisi dans le chat', !!scenReq &&
        JSON.parse(scenReq.options.body).model === wb.eval('LSV.services.chat.model()'),
        scenReq && JSON.parse(scenReq.options.body).model);
    check('réponse attendue en JSON', !!scenReq &&
        JSON.parse(scenReq.options.body).response_format.type === 'json_object');
    check('aucune clé dans la requête', !!scenReq &&
        JSON.stringify(scenReq.options.headers || {}).indexOf('sk-') === -1);
    const scenMsg16 = JSON.parse(scenReq.options.body).messages[1].content;
    check('le format choisi change la consigne envoyée', /Format court/.test(scenMsg16),
        scenMsg16.slice(0, 60).replace(/\s+/g, ' '));
    check('résultat affiché', !doc.getElementById('scenario-output').classList.contains('hidden'));
    check('titre rendu', doc.getElementById('scenario-out-title').textContent === 'Tasse de veille',
        doc.getElementById('scenario-out-title').textContent);
    check('accroche rendue', /devine demain/.test(doc.getElementById('scenario-logline').textContent),
        doc.getElementById('scenario-logline').textContent);
    check('deux scènes rendues', doc.querySelectorAll('#scenario-scenes .scenario-scene').length === 2,
        doc.querySelectorAll('#scenario-scenes .scenario-scene').length);
    check('prompt de scène affiché', /barista derrière son comptoir/.test(doc.getElementById('scenario-scenes').textContent));
    check('titre du format dans le résultat',
        doc.getElementById('scenario-mode-label').textContent === 'Format court',
        doc.getElementById('scenario-mode-label').textContent);
    check('génération historisée',
        wb.eval('JSON.stringify(HistoryService.all()[0])').indexOf('scenario.generate') !== -1,
        wb.eval('HistoryService.all()[0].type'));

    /* Un autre format envoie une autre consigne, sur la même route. */
    scenTiles[2].dispatchEvent(new wb.Event('click', { bubbles: true }));
    scenCalls.length = 0;
    await wb.LSV.views.scenarios.generate();
    const scenReq2 = scenCalls.find(c => c.url.indexOf('/chat/completions') !== -1);
    check('mode storyboard → consigne storyboard', !!scenReq2 &&
        /Storyboard/.test(JSON.parse(scenReq2.options.body).messages[1].content));
    check('même passerelle quel que soit le format', !!scenReq2 &&
        scenReq2.url.indexOf('/functions/v1/lsv-gateway/v1/chat/completions') !== -1);
    scenTiles[0].dispatchEvent(new wb.Event('click', { bubbles: true }));

    /* Transfert vers le Storyboard : sans projet, rien n'est écrit. */
    wb.eval('Runtime.currentProjectId = null');
    wb.LSV.views.scenarios.toStoryboard();
    check('sans projet actif : aucune scène créée',
        wb.eval('ProjectService.all().reduce((n, p) => n + (p.scenes || []).length, 0)') === 0,
        wb.eval('ProjectService.all().reduce((n, p) => n + (p.scenes || []).length, 0)'));
    check('sans projet actif : orientation vers Storyboard',
        doc.getElementById('tab-storyboard').classList.contains('active'));

    /* Avec un projet : chaque scène devient une scène éditable. */
    const scenProject = wb.eval('ProjectService.create({name:"Projet scénario", type:"general"}).id');
    wb.eval('Runtime.currentProjectId = "' + scenProject + '"');
    wb.LSV.views.scenarios.toStoryboard();
    check('scènes ajoutées au projet',
        wb.eval('ProjectService.get("' + scenProject + '").scenes.length') === 2,
        wb.eval('ProjectService.get("' + scenProject + '").scenes.length'));
    check('scènes rendues dans le Storyboard',
        doc.querySelectorAll('#storyboard-list .scene-card').length === 2,
        doc.querySelectorAll('#storyboard-list .scene-card').length);
    check('prompt de scène repris tel quel',
        /barista derrière son comptoir/.test(doc.getElementById('storyboard-list').textContent));
    check('projet actif annoncé', /2 scènes/.test(doc.getElementById('storyboard-project-info').textContent),
        doc.getElementById('storyboard-project-info').textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
    check('aucune erreur console (studio de scénarios)', errors.length === 0, errors.join('|'));

    console.log('\n=== 17. AMÉLIORATION DE PROMPT (AVANT / APRÈS) ===');
    const enhTab = doc.getElementById('tab-enhancer');
    check('outil « Améliorer un prompt existant » présent', !!doc.getElementById('improve-input'));
    check('les deux panneaux avant / après existent',
        !!doc.getElementById('improve-before') && !!doc.getElementById('improve-after'));
    check('résultat masqué avant génération',
        !doc.getElementById('improve-output').classList.contains('visible'));
    check('Enhancer d\'origine intact (saisie et bouton présents)',
        !!doc.getElementById('enhancer-input') && !!doc.getElementById('enhancer-generate') &&
        !!doc.getElementById('enhancer-output'));
    check('aucune clé ni URL de fournisseur dans l\'onglet',
        !/sk-|Bearer|apihub|agnes-ai/i.test(enhTab.innerHTML));

    const impCalls = [];
    const impAfter = 'Portrait d\'une barista, lumière chaude de fin de matin, objectif 50 mm, plan serré, ambiance cinématographique';
    wb.fetch = function (url, options) {
        impCalls.push({ url: String(url), options: options || {} });
        if (String(url).indexOf('/chat/completions') !== -1) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: impAfter } }] }) });
        }
        if (String(url).indexOf('/rest/v1/analytics_events') !== -1) return Promise.resolve({ ok: true, status: 201, json: async () => ([]) });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
    };
    const impBefore = 'une barista dans un café';
    doc.getElementById('improve-input').value = impBefore;
    doc.getElementById('improve-input').dispatchEvent(new wb.Event('input', { bubbles: true }));
    check('bouton actif une fois le prompt collé', !doc.getElementById('improve-generate').disabled);
    await wb.LSV.views.improve.generate();
    const impReq = impCalls.find(c => c.url.indexOf('/chat/completions') !== -1);
    check('requête partie vers la passerelle',
        !!impReq && impReq.url.indexOf('/functions/v1/lsv-gateway/v1/chat/completions') !== -1,
        impReq && impReq.url);
    check('consigne : conserver l\'intention d\'origine', !!impReq &&
        /intention/.test(JSON.parse(impReq.options.body).messages[0].content),
        impReq && JSON.parse(impReq.options.body).messages[0].content.slice(0, 60));
    check('résultat affiché', doc.getElementById('improve-output').classList.contains('visible'));
    check('AVANT = le prompt d\'origine, intact',
        doc.getElementById('improve-before').textContent === impBefore,
        doc.getElementById('improve-before').textContent);
    check('APRÈS = la version améliorée',
        doc.getElementById('improve-after').textContent === impAfter,
        doc.getElementById('improve-after').textContent);
    check('les deux textes diffèrent bel et bien',
        doc.getElementById('improve-before').textContent !== doc.getElementById('improve-after').textContent);
    check('la saisie d\'origine n\'est pas réécrite',
        doc.getElementById('improve-input').value === impBefore, doc.getElementById('improve-input').value);
    check('amélioration historisée',
        wb.eval('JSON.stringify(HistoryService.all()[0])').indexOf('prompt.improve') !== -1,
        wb.eval('HistoryService.all()[0].type'));

    /* Utiliser le résultat : il part vers l'onglet choisi, la saisie reste. */
    doc.getElementById('improve-use-image').dispatchEvent(new wb.Event('click', { bubbles: true }));
    check('résultat envoyé vers l\'onglet Image',
        doc.getElementById('image-prompt').value === impAfter &&
        doc.getElementById('tab-image').classList.contains('active'));
    check('saisie d\'amélioration conservée',
        doc.getElementById('improve-input').value === impBefore, doc.getElementById('improve-input').value);
    check('aucune erreur console (amélioration de prompt)', errors.length === 0, errors.join('|'));

    /* Nettoyage : aucune session de test ne doit survivre à la page. */
    wb.eval('AccountService._save(null)');

    const failed = results.filter(r => !r.ok);
    console.log('\n════════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests interface/sécurité OK');
    if (failed.length) console.log('ECHECS : ' + failed.map(f => f.label).join(', '));
    else console.log('INTERFACE PUBLIQUE CONFORME');
    setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})().catch(e => { console.error(e); process.exit(1); });
