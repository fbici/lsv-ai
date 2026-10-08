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

function prepare() {
    let html = fs.readFileSync(INDEX, 'utf8');
    html = html.replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '');
    const cfg = fs.readFileSync(path.join(PROJECT, 'shared/config.js'), 'utf8');
    const ana = fs.readFileSync(path.join(PROJECT, 'analytics/analytics.js'), 'utf8');
    html = html.replace('<script src="./shared/config.js"></script>', '<script>' + cfg + '</script>');
    html = html.replace('<script src="./analytics/analytics.js"></script>', '<script>' + ana + '</script>');
    return html;
}

async function load(html) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
    vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
    vc.on('warn', () => {});
    const dom = new JSDOM(html, { url: 'https://fbici.github.io/lsv-ai/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
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
    check('index.html sans token sk-', source.indexOf('sk-') === -1);
    check('index.html sans clé en localStorage', source.indexOf('lsv4_api_key') === -1);
    check('index.html sans endpoint amont', source.indexOf('apihub.agnes-ai.com') === -1);
    check('index.html sans lien plateforme fournisseur', source.indexOf('platform.agnes-ai.com') === -1);
    const publicFiles = ['admin/admin.js', 'admin/index.html', 'analytics/analytics.js', 'shared/config.js', 'admin/admin.css'];
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

    console.log('\n=== 7. COMPTES UTILISATEURS (Supabase Auth) ===');
    check('section Compte présente', !!doc.getElementById('account-section'));
    check('formulaire fermé par défaut', doc.getElementById('account-form').classList.contains('hidden'));
    check('aucun compte connecté par défaut', doc.getElementById('account-user').classList.contains('hidden'));
    check('index.html permet l inscription (Auth REST)', /auth\/v1\/signup|AccountService/.test(source));
    check('index.html sans mot de passe en dur', !/password\s*[:=]\s*['"][^'"]+['"]/i.test(source));
    check('index.html sans service_role', !/service_role/i.test(source));
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
    doc.getElementById('account-email').value = 'visiteur@lsv.ai';
    doc.getElementById('account-password').value = 'secret-de-test';
    doc.getElementById('account-submit').click();
    await new Promise(r => setTimeout(r, 300));
    const accMsg = doc.getElementById('account-status-text').textContent;
    check('connexion refusée → message générique', /Identifiants incorrects/i.test(accMsg), accMsg);
    check('aucun détail technique dans le message', !/sk-|HTTP|401|apihub|agnes/i.test(accMsg), accMsg);
    check('toujours déconnecté', doc.getElementById('account-user').classList.contains('hidden'));

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
    check('aucun détail technique dans le toast', !/sk-|HTTP|apihub|agnes/i.test(da.getElementById('toast-text').textContent));

    da.getElementById('chat-input').value = 'Salut, une idée ?';
    await wa.LSV.views.chat.sendMessage();
    check('aucune requête chat sans compte', !anonCalls.some(u => u.includes('/chat/completions')), anonCalls.join(','));
    check('message conservé dans le champ', da.getElementById('chat-input').value === 'Salut, une idée ?', da.getElementById('chat-input').value);
    check('aucune erreur console (bloqué)', anon.errors.length === 0, anon.errors.join('|'));

    const failed = results.filter(r => !r.ok);
    console.log('\n════════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests interface/sécurité OK');
    if (failed.length) console.log('ECHECS : ' + failed.map(f => f.label).join(', '));
    else console.log('INTERFACE PUBLIQUE CONFORME');
    setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})().catch(e => { console.error(e); process.exit(1); });
