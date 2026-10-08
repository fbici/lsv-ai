/* Tests du back-office LSV.ai — scénarios d'accès (§24 de la mission) */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROJECT = path.resolve(__dirname, '..');
const ADMIN_HTML = path.join(PROJECT, 'admin/index.html');

const EVENTS = [
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', event: 'page_view', props: { path: '/' } },
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', event: 'image_generated', props: { model: 'agnes-image-2.1-flash', ratio: '16:9', size: '1312x736', style: 'cinematic' } },
    { created_at: new Date().toISOString(), visitor_id: 'v2', session_id: 's2', event: 'video_generated', props: { model: 'agnes-video-v2.0', mode: 'text-to-video', duration: 5, segments: 2 } },
    { created_at: new Date().toISOString(), visitor_id: 'v2', session_id: 's2', event: 'chat_used', props: { status: 'success' } },
    { created_at: new Date().toISOString(), visitor_id: 'v1', session_id: 's1', event: 'generation_error', props: { feature: 'video', detail: 'HTTP 500 — Internal error' } },
    { created_at: new Date().toISOString(), visitor_id: 'v3', session_id: 's3', event: 'project_created', props: { type: 'pub' } },
    { created_at: new Date().toISOString(), visitor_id: 'v3', session_id: 's3', event: 'tab_view', props: { tab: 'motion' } }
];

const GOOD_EMAIL = 'admin@test.com';
const GOOD_PASSWORD = 'password-de-test';
const OTHER_EMAIL = 'user@test.com'; // compte réel mais hors liste blanche
const NEW_EMAIL = 'nouveau@test.com'; // créé par le scénario d'inscription
const CONFIRM_EMAIL = 'confirme@test.com'; // inscription nécessitant une confirmation
const WHITELIST = [GOOD_EMAIL, NEW_EMAIL];

let rlsEnabled = true; // simule la RLS Supabase : pas de session = pas de données

function makeFakeSupabase() {
    function builder(rowsForRequest) {
        const b = {
            select() { return b; }, gte() { return b; }, lt() { return b; },
            order() { return b; }, limit() { return b; },
            then(resolve) {
                const session = api._session;
                if (rlsEnabled && (!session || session.user.email !== GOOD_EMAIL)) {
                    resolve({ data: null, error: { message: 'permission denied for table analytics_events' } });
                } else {
                    resolve({ data: rowsForRequest, error: null });
                }
            }
        };
        return b;
    }
    const api = {
        _session: null,
        _listeners: [],
        auth: {
            getSession() { return Promise.resolve({ data: { session: api._session }, error: null }); },
            signInWithPassword({ email, password }) {
                if (email === GOOD_EMAIL && password === GOOD_PASSWORD) {
                    const session = { user: { id: 'uid-1', email: email }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
                    api._session = session;
                    api._listeners.forEach(cb => cb('SIGNED_IN', session));
                    return Promise.resolve({ data: { user: session.user, session }, error: null });
                }
                return Promise.resolve({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } });
            },
            signOut() { api._session = null; api._listeners.forEach(cb => cb('SIGNED_OUT', null)); return Promise.resolve({ error: null }); },
            onAuthStateChange(cb) { api._listeners.push(cb); return { data: { subscription: {} } }; }
        },
        from(table) {
            if (table !== 'analytics_events') return builder([]);
            return builder(EVENTS);
        },
        rpc(name) {
            if (name !== 'is_admin') return Promise.resolve({ data: null, error: { message: 'unknown function' } });
            const s = api._session;
            const email = s && s.user && s.user.email;
            return Promise.resolve({ data: !!(email && ['admin@test.com', 'nouveau@test.com'].indexOf(email) !== -1), error: null });
        }
    };
    return { createClient: () => api, _api: api };
}

function prepare(html, fake, config) {
    let h = html
        .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
        .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/,
            '<script>window.supabase = (' + fake.toString() + ')();</script>')
        .replace('<script src="../shared/config.js"></script>',
            '<script>window.LSV_CONFIG = ' + JSON.stringify(config) + ';</script>')
        .replace('<script src="./admin.js"></script>',
            '<script>' + fs.readFileSync(path.join(PROJECT, 'admin/admin.js'), 'utf8') + '</script>');
    return h;
}

async function load(html) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
    vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
    vc.on('warn', () => {});
    const dom = new JSDOM(html, { url: 'https://lsv.test/admin/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
    await new Promise(r => { if (dom.window.document.readyState === 'complete') return r(); dom.window.addEventListener('load', r); setTimeout(r, 3000); });
    await new Promise(r => setTimeout(r, 250));
    return { dom, errors };
}

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond });
    console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login(dom, email, password) {
    const w = dom.window || (dom.dom && dom.dom.window);
    w.document.getElementById('login-email').value = email;
    w.document.getElementById('login-password').value = password;
    w.document.getElementById('login-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(300);
}

(async () => {
    const src = fs.readFileSync(ADMIN_HTML, 'utf8');
    const fake = function makeFakeSupabase() {
        function builder(rowsForRequest, table) {
            const b = {
                _table: table, _upsert: null, _isDelete: false,
                select() { return b; }, gte() { return b; }, lt() { return b; },
                order() { return b; }, limit() { return b; }, eq() { return b; },
                upsert(row) { b._upsert = row; return b; },
                delete() { b._isDelete = true; return b; },
                then(resolve, reject) {
                    const session = api._session;
                    const listed = session && (window.__WHITELIST || []).indexOf(session.user.email) !== -1;
                    let result;
                    if (window.__rlsEnabled && !listed) {
                        result = { data: null, error: { message: 'permission denied for table ' + (b._table || 'analytics_events') } };
                    } else if (b._table === 'app_settings') {
                        const store = window.__SETTINGS || {};
                        if (b._upsert) {
                            store[b._upsert.key] = b._upsert;
                            window.__SETTINGS = store;
                            result = { data: [b._upsert], error: null };
                        } else if (b._isDelete) {
                            window.__SETTINGS = {};
                            result = { data: null, error: null };
                        } else {
                            const row = store.provider_api_key;
                            result = { data: row ? [{ key: row.key, value: row.value, updated_at: row.updated_at }] : [], error: null };
                        }
                    } else {
                        result = { data: rowsForRequest, error: null };
                    }
                    return Promise.resolve(result).then(resolve, reject);
                }
            };
            return b;
        }
        const api = {
            _session: null, _listeners: [],
            auth: {
                getSession() { return Promise.resolve({ data: { session: api._session }, error: null }); },
                signInWithPassword(creds) {
                    const ok = creds.password === window.__GOOD_PASSWORD &&
                        (creds.email === window.__GOOD_EMAIL || creds.email === window.__USER_EMAIL);
                    if (ok) {
                        const session = { user: { id: 'uid-1', email: creds.email, user_metadata: {} }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
                        api._session = session;
                        api._listeners.forEach(cb => cb('SIGNED_IN', session));
                        return Promise.resolve({ data: { user: session.user, session }, error: null });
                    }
                    return Promise.resolve({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } });
                },
                signUp(creds) {
                    const meta = (creds.options && creds.options.data) || {};
                    if (creds.email === window.__CONFIRM_EMAIL) {
                        return Promise.resolve({ data: { user: { id: 'uid-2', email: creds.email, user_metadata: meta }, session: null }, error: null });
                    }
                    const session = { user: { id: 'uid-2', email: creds.email, user_metadata: meta }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
                    api._session = session;
                    api._listeners.forEach(cb => cb('SIGNED_IN', session));
                    return Promise.resolve({ data: { user: session.user, session }, error: null });
                },
                signOut() { api._session = null; api._listeners.forEach(cb => cb('SIGNED_OUT', null)); return Promise.resolve({ error: null }); },
                onAuthStateChange(cb) { api._listeners.push(cb); return { data: { subscription: {} } }; }
            },
            from(table) { return builder(window.__EVENTS, table); },
            rpc(name) {
                if (name !== 'is_admin') return Promise.resolve({ data: null, error: { message: 'unknown function' } });
                const s = api._session;
                const email = s && s.user && s.user.email;
                const wl = window.__WHITELIST || [];
                return Promise.resolve({ data: !!(email && wl.indexOf(email) !== -1), error: null });
            }
        };
        return { createClient: () => api, _api: api };
    };

    const CONFIG_OK = { SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature' };
    const CONFIG_KO = { SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co', SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY' };

    function inject(html, config) {
        return html
            .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
            .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/,
                '<script>window.__rlsEnabled=true;window.__GOOD_EMAIL="' + GOOD_EMAIL + '";window.__GOOD_PASSWORD="' + GOOD_PASSWORD +
                '";window.__USER_EMAIL="' + OTHER_EMAIL + '";window.__CONFIRM_EMAIL="' + CONFIRM_EMAIL +
                '";window.__WHITELIST=' + JSON.stringify(WHITELIST) +
                ';window.__SETTINGS={};window.__EVENTS=' + JSON.stringify(EVENTS) + ';window.supabase=(' + fake.toString() + ')();</script>')
            .replace('<script src="../shared/config.js"></script>', '<script>window.LSV_CONFIG=' + JSON.stringify(config) + ';</script>')
            .replace('<script src="./admin.js"></script>', '<script>' + fs.readFileSync(path.join(PROJECT, 'admin/admin.js'), 'utf8') + '</script>');
    }

    console.log('\n=== A. CONFIGURATION ABSENTE ===');
    let t = await load(inject(src, CONFIG_KO));
    check('page de connexion affichée', !t.dom.window.document.getElementById('auth-screen').classList.contains('hidden'));
    check('dashboard masqué', t.dom.window.document.getElementById('admin-app').classList.contains('hidden'));
    check('message de configuration', /config/i.test(t.dom.window.document.getElementById('auth-status').textContent));
    check('aucune erreur console', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== B. NON AUTHENTIFIÉ ===');
    t = await load(inject(src, CONFIG_OK));
    const w = t.dom.window;
    check('dashboard inaccessible', w.document.getElementById('admin-app').classList.contains('hidden'));
    check('login visible', !w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('aucune donnée affichée', w.document.getElementById('kpi-grid').innerHTML.trim() === '');
    check('aucune erreur console', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== C. MAUVAIS IDENTIFIANTS ===');
    await login(t, 'admin@test.com', 'mauvais-mdp');
    const err = w.document.getElementById('login-error');
    check('accès refusé (message)', !err.classList.contains('hidden') && /incorrect/i.test(err.textContent), err.textContent);
    check('dashboard toujours masqué', w.document.getElementById('admin-app').classList.contains('hidden'));

    console.log('\n=== D. IDENTIFIANTS VALIDES ===');
    await login(t, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(500);
    check('dashboard accessible', !w.document.getElementById('admin-app').classList.contains('hidden'));
    check('login masqué', w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('email affiché', w.document.getElementById('admin-email').textContent === GOOD_EMAIL);
    const kpis = w.document.getElementById('kpi-grid').textContent;
    check('KPI visiteurs=3', /Visiteurs[\s\S]*?3/.test(kpis), kpis.replace(/\s+/g, ' ').slice(0, 160));
    check('KPI images=1', /Images générées\s*1/.test(kpis.replace(/\s+/g, ' ')));
    check('graphique rendu (svg)', !!w.document.querySelector('#chart-activity svg'));
    check('barres utilisation rendues', w.document.getElementById('usage-bars').innerHTML.indexOf('usage-row') !== -1);
    check('feed activité rendu', w.document.getElementById('overview-feed').innerHTML.indexOf('feed-item') !== -1);

    console.log('\n=== E. PAGES DU DASHBOARD ===');
    const pages = ['images', 'videos', 'chat', 'motion', 'activity', 'errors', 'settings', 'overview'];
    let pagesOk = true;
    for (const p of pages) {
        try {
            w.document.querySelector('.nav-item[data-page="' + p + '"]').dispatchEvent(new w.Event('click', { bubbles: true }));
            await sleep(60);
            const active = w.document.querySelector('.page.active');
            if (!active || active.id !== 'page-' + p) { pagesOk = false; console.log('    page KO: ' + p); }
            if (w.document.getElementById('page-title').textContent.trim() === '') { pagesOk = false; }
        } catch (e) { pagesOk = false; console.log('    exception ' + p + ': ' + e.message); }
    }
    check('8 pages navigables sans exception', pagesOk);

    // contenu des pages
    w.document.querySelector('.nav-item[data-page="errors"]').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(60);
    check('table erreurs remplie', w.document.getElementById('errors-table').innerHTML.indexOf('VIDEO') !== -1 || w.document.getElementById('errors-table').innerHTML.indexOf('video') !== -1);
    check('badge type erreur', w.document.getElementById('errors-table').innerHTML.indexOf('GENERATION_ERROR') !== -1);

    w.document.querySelector('.nav-item[data-page="images"]').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(60);
    check('table images remplie', w.document.getElementById('images-table').innerHTML.indexOf('agnes-image-2.1-flash') !== -1);

    console.log('\n=== F. PLAGE TEMPORELLE ===');
    let rangeOk = true;
    for (const r of ['7d', '30d', 'all', 'today']) {
        try {
            w.document.querySelector('.range-btn[data-range="' + r + '"]').dispatchEvent(new w.Event('click', { bubbles: true }));
            await sleep(120);
            if (!w.document.querySelector('.range-btn[data-range="' + r + '"]').classList.contains('active')) rangeOk = false;
        } catch (e) { rangeOk = false; console.log('    exception range ' + r + ': ' + e.message); }
    }
    check('4 plages fonctionnelles', rangeOk);

    console.log('\n=== G. SESSION EXPIRÉE / RLS ===');
    w.__rlsEnabled = true;
    w.supabase._api._session = null; // le token a expiré côté serveur
    w.document.getElementById('refresh-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(400);
    check('retour vers la connexion', !w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('dashboard refermé', w.document.getElementById('admin-app').classList.contains('hidden'));

    console.log('\n=== H. DÉCONNEXION ===');
    await login(w, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(400);
    check('reconnexion OK', !w.document.getElementById('admin-app').classList.contains('hidden'));
    w.document.getElementById('logout-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
    await sleep(300);
    check('déconnexion → login', !w.document.getElementById('auth-screen').classList.contains('hidden'));
    check('données effacées après logout', w.document.getElementById('kpi-grid').innerHTML.indexOf('kpi-value') === -1 || w.document.getElementById('admin-app').classList.contains('hidden'));

    console.log('\n=== I. INSCRIPTION DEPUIS L ÉCRAN CONNEXION ===');
    t = await load(inject(src, CONFIG_OK));
    let wi = t.dom.window;
    check('champ nom masqué en mode connexion', wi.document.getElementById('login-name-field').classList.contains('hidden'));
    wi.document.getElementById('signup-toggle').dispatchEvent(new wi.Event('click', { bubbles: true }));
    await sleep(80);
    check('titre = Créer un compte', wi.document.getElementById('auth-title').textContent === 'Créer un compte');
    check('indice d inscription visible', !wi.document.getElementById('signup-hint').classList.contains('hidden'));
    check('champ nom complet visible en inscription', !wi.document.getElementById('login-name-field').classList.contains('hidden'));
    check('bouton = Créer le compte', /Créer le compte/.test(wi.document.getElementById('login-btn').textContent));
    check('libellé inversé (j ai déjà un compte)', /déjà un compte/.test(wi.document.getElementById('signup-toggle').textContent));
    check('autocomplete = new-password', wi.document.getElementById('login-password').getAttribute('autocomplete') === 'new-password');
    check('login form masqué avant inscription', wi.document.getElementById('admin-app').classList.contains('hidden'));

    wi.document.getElementById('login-email').value = NEW_EMAIL;
    wi.document.getElementById('login-password').value = 'mot-de-passe-test';
    wi.document.getElementById('login-form').dispatchEvent(new wi.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(200);
    check('inscription sans nom refusée', /Nom complet requis/i.test(wi.document.getElementById('login-error').textContent), wi.document.getElementById('login-error').textContent);
    check('dashboard fermé sans nom', wi.document.getElementById('admin-app').classList.contains('hidden'));

    wi.document.getElementById('login-name').value = 'Jean Nouveau';
    wi.document.getElementById('login-form').dispatchEvent(new wi.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(500);
    check('inscription → dashboard (liste blanche)', !wi.document.getElementById('admin-app').classList.contains('hidden'));
    check('e-mail du nouveau compte affiché', wi.document.getElementById('admin-email').textContent === NEW_EMAIL, wi.document.getElementById('admin-email').textContent);
    const meta = wi.supabase._api._session && wi.supabase._api._session.user.user_metadata;
    check('nom complet transmis à Supabase Auth', meta && meta.full_name === 'Jean Nouveau', JSON.stringify(meta));

    const t2 = await load(inject(src, CONFIG_OK));
    const wc = t2.dom.window;
    wc.document.getElementById('signup-toggle').dispatchEvent(new wc.Event('click', { bubbles: true }));
    await sleep(60);
    wc.document.getElementById('login-name').value = 'Confirme Toi';
    wc.document.getElementById('login-email').value = CONFIRM_EMAIL;
    wc.document.getElementById('login-password').value = 'mot-de-passe-test';
    wc.document.getElementById('login-form').dispatchEvent(new wc.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(450);
    check('confirmation e-mail demandée', /confirme ton e-mail/i.test(wc.document.getElementById('auth-status').textContent), wc.document.getElementById('auth-status').textContent);
    check('dashboard fermé en attente de confirmation', wc.document.getElementById('admin-app').classList.contains('hidden'));
    check('retour au mode connexion', /Créer un compte/.test(wc.document.getElementById('signup-toggle').textContent));
    check('aucune erreur console (inscription)', t2.errors.length === 0, t2.errors.join('|'));

    console.log('\n=== J. COMPTE HORS LISTE BLANCHE ===');
    t = await load(inject(src, CONFIG_OK));
    const wo = t.dom.window;
    await login(t, OTHER_EMAIL, GOOD_PASSWORD);
    await sleep(450);
    check('dashboard masqué (non listé)', wo.document.getElementById('admin-app').classList.contains('hidden'));
    check('message non autorisé', /non autorisé/i.test(wo.document.getElementById('login-error').textContent), wo.document.getElementById('login-error').textContent);
    check('écran de connexion visible', !wo.document.getElementById('auth-screen').classList.contains('hidden'));
    check('aucune donnée affichée (hors liste)', wo.document.getElementById('kpi-grid').innerHTML.trim() === '');
    check('aucune erreur console (hors liste)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== L. CLÉ DU FOURNISSEUR DANS PARAMÈTRES ===');
    t = await load(inject(src, CONFIG_OK));
    const wk = t.dom.window;
    await login(t, GOOD_EMAIL, GOOD_PASSWORD);
    await sleep(500);
    wk.document.querySelector('.nav-item[data-page="settings"]').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(250);
    check('carte « Clé du fournisseur » présente', !!wk.document.getElementById('provider-key-input'));
    const keyStatus = () => wk.document.getElementById('settings-key-status').textContent;
    check('statut initial : aucune clé en base', /aucune clé/i.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));

    wk.document.getElementById('provider-key-input').value = 'court';
    wk.document.getElementById('provider-key-save').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(120);
    check('clé trop courte refusée', /8 caractères/.test(wk.document.getElementById('toast-text').textContent), wk.document.getElementById('toast-text').textContent);
    check('statut inchangé après refus', /aucune clé/i.test(keyStatus()));

    wk.document.getElementById('provider-key-input').value = 'cle-de-test-1234567890';
    wk.document.getElementById('provider-key-save').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(250);
    check('clé enregistrée (confirmation)', /enregistrée/i.test(wk.document.getElementById('toast-text').textContent), wk.document.getElementById('toast-text').textContent);
    check('statut = configurée', /configurée/i.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));
    check('clé masquée dans le statut', !/cle-de-test-1234567890/.test(keyStatus()) && /••••/.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));
    check('champ vidé après enregistrement', wk.document.getElementById('provider-key-input').value === '');

    wk.document.getElementById('provider-key-clear').dispatchEvent(new wk.Event('click', { bubbles: true }));
    await sleep(250);
    check('clé retirée → statut initial', /aucune clé/i.test(keyStatus()), keyStatus().replace(/\s+/g, ' ').slice(0, 90));
    check('aucune erreur console (clé)', t.errors.length === 0, t.errors.join('|'));

    console.log('\n=== K. SANITÉ ===');
    check('aucune erreur console globale', t.errors.length === 0, t.errors.join('|'));
    const finalHtml = fs.readFileSync(path.join(PROJECT, 'admin/index.html'), 'utf8') + fs.readFileSync(path.join(PROJECT, 'admin/admin.js'), 'utf8');
    check('aucun mot de passe codé en dur', !/ADMIN_PASSWORD|password\s*===\s*['"][^'"]+['"]/.test(finalHtml));
    check('aucun service_role', !/service_role/i.test(finalHtml));

    const failed = results.filter(r => !r.ok);
    console.log('\n══════════════════════════════');
    console.log((results.length - failed.length) + '/' + results.length + ' tests admin OK');
    if (failed.length) console.log('ECHECS: ' + failed.map(f => f.label).join(', '));
    else console.log('SCÉNARIOS ADMIN CONFORMES');
    setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})();
